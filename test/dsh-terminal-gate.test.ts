import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  tmuxSend,
  isShellCommand,
  terminalBusyMessage,
  sentinelTimeoutMs,
  escalateEnabled,
  TerminalBusyError,
} from '../src/index.ts'

// 背景(2026-09-22 r24-plan 事故):sudo 在等认证时,注入行被前台进程当成输入
// 吃掉 —— 命令未执行、history 永不落盘、插件空转 120s,且补发的 C-c 打不断
// PAM 层认证。三道门禁把「静默挂死」变成「立即的诚实错误」。

/** 假 DSH ctx:脚本化 shell.run,记录每条被执行的命令。 */
function makeCtx(opts: {
  fg: string
  /** 收到 send-keys 时是否「执行」注入行(写出 sentinel) */
  executeLine?: boolean
  /** 前台进程名随探测次数变化(模拟瞬时外部进程) */
  fgSeq?: string[]
}) {
  const commands: string[] = []
  let probe = 0
  const shell = {
    resolve: (spec: any) => spec,
    run: async (spec: any) => {
      commands.push(spec.command)
      if (spec.command.includes('display-message')) {
        const seq = opts.fgSeq
        const fg = seq && seq.length ? seq[Math.min(probe++, seq.length - 1)] : opts.fg
        return { exitCode: 0, stdout: { text: fg }, stderr: { text: '' } }
      }
      if (spec.command.includes('send-keys') && opts.executeLine) {
        // 模拟 shell 执行注入行:行首 `: > '<sentinel>'` 写出哨兵文件
        const m = spec.command.match(/(\/[^\s']*agsh_sent_\d+_\d+\.txt)/)
        if (m) writeFileSync(m[1], '')
      }
      return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
    },
  }
  const ctx: any = {
    get: (k: string) => (k === 'shell' ? shell : undefined),
    timer: { timeout: (_ms: number) => Promise.resolve() },
  }
  return { ctx, commands }
}

const T = { socket: '/tmp/fake.sock', session: 'agsh-test' }

let cwd = ''
const ENV_KEY = 'AGSH_SENTINEL_TIMEOUT_MS'
let savedEnv: string | undefined

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'agsh-gate-'))
  savedEnv = process.env[ENV_KEY]
  process.env[ENV_KEY] = '150' // 测试里把 sentinel 等待压到 150ms
})

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = savedEnv
  rmSync(cwd, { recursive: true, force: true })
})

describe('isShellCommand', () => {
  test('认 shell 名(含带路径形式)', () => {
    for (const s of ['zsh', 'bash', 'sh', 'dash', 'ksh', 'fish', '/bin/zsh', '/usr/bin/bash']) {
      expect(isShellCommand(s)).toBe(true)
    }
  })
  test('非 shell 一律 false(sudo/ssh/长命令/bun)', () => {
    for (const s of ['sudo', 'ssh', 'bun', 'python3', 'sleep', 'node']) {
      expect(isShellCommand(s)).toBe(false)
    }
  })
  test('空/空白 = false(由调用方按「无法判定」放行)', () => {
    expect(isShellCommand('')).toBe(false)
    expect(isShellCommand('   ')).toBe(false)
    expect(isShellCommand(undefined as any)).toBe(false)
  })
})

describe('sentinelTimeoutMs', () => {
  test('默认 4000,合法值生效,非法值回落', () => {
    expect(sentinelTimeoutMs({})).toBe(4000)
    expect(sentinelTimeoutMs({ [ENV_KEY]: '9000' })).toBe(9000)
    for (const bad of ['0', '-1', 'abc', 'NaN', 'Infinity']) {
      expect(sentinelTimeoutMs({ [ENV_KEY]: bad })).toBe(4000)
    }
  })
})

describe('terminalBusyMessage', () => {
  test('点名占用者并说明命令未执行', () => {
    const m = terminalBusyMessage('sudo')
    expect(m).toContain('终端被占用')
    expect(m).toContain('sudo')
    expect(m).toContain('未执行')
  })
  test('占用者未知/为空时用兜底措辞', () => {
    expect(terminalBusyMessage('')).toContain('前台进程')
    expect(terminalBusyMessage('zsh')).toContain('前台进程')
  })
})

describe('门禁一:前台非 shell ⇒ 拒绝注入', () => {
  test('sudo 在等认证:抛 TerminalBusyError,且绝不发出 send-keys(安全)', async () => {
    const { ctx, commands } = makeCtx({ fg: 'sudo' })
    let err: any
    try {
      await tmuxSend(ctx, cwd, T, 'echo SHOULD_NOT_BE_SENT')
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(TerminalBusyError)
    expect(err.foreground).toBe('sudo')
    // 安全属性:注入行(含凭证 id、路径)绝不送进认证提示 —— 否则会变成一次
    // 「密码尝试」,可能触发 sudo 锁定。
    const sent = commands.filter((c) => c.includes('send-keys'))
    expect(sent).toEqual([])
  })

  test('门禁一在重试窗口内吸收瞬时外部进程(如终端尾调的 bun)', async () => {
    const { ctx } = makeCtx({ fg: 'zsh', fgSeq: ['bun', 'bun', 'zsh'], executeLine: true })
    await tmuxSend(ctx, cwd, T, 'echo ok') // 不抛 = 瞬时占用被吸收
  })

  test('外部进程持续占用(长命令 sleep)⇒ 拒绝,不注入', async () => {
    const { ctx, commands } = makeCtx({ fg: 'sleep' })
    await expect(tmuxSend(ctx, cwd, T, 'echo x')).rejects.toBeInstanceOf(TerminalBusyError)
    expect(commands.filter((c) => c.includes('send-keys'))).toEqual([])
  })
})

describe('门禁二:探路哨兵(注入之前)⇒ 真行永不被 reader 吃掉', () => {
  test('前台仍是 zsh(内建 read 阻塞)⇒ 抛 TerminalBusyError', async () => {
    // 内建 read 时 pane_current_command 仍报 zsh —— 门禁一放行,只能靠哨兵抓
    const { ctx } = makeCtx({ fg: 'zsh', executeLine: false })
    let err: any
    try {
      await tmuxSend(ctx, cwd, T, 'echo never')
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(TerminalBusyError)
  })

  test('关键安全属性:被吃掉时,真行【从未发出】(reader 只收到无害短探路行)', async () => {
    const { ctx, commands } = makeCtx({ fg: 'zsh', executeLine: false })
    await expect(tmuxSend(ctx, cwd, T, 'echo SECRET_CRED_ID')).rejects.toBeInstanceOf(TerminalBusyError)
    // 探路行发出去了(无害),但真行绝不发出 —— 这是修复「先喂后判」的判据
    const sent = commands.filter((c) => c.includes('send-keys'))
    expect(sent.length).toBe(1)
    expect(sent[0]).toContain('agsh_sent_')
    expect(sent[0]).not.toContain('SECRET_CRED_ID')
  })

  test('健康终端:探路 + 真行都落地 ⇒ 正常返回', async () => {
    const { ctx, commands } = makeCtx({ fg: 'zsh', executeLine: true })
    await tmuxSend(ctx, cwd, T, 'echo hello')
    expect(commands.filter((c) => c.includes('send-keys')).length).toBe(2) // 探路 + 真行
  })

  test('真行自带哨兵,且原命令原样保留', async () => {
    const { ctx, commands } = makeCtx({ fg: 'zsh', executeLine: true })
    await tmuxSend(ctx, cwd, T, 'echo MARKER_XYZ')
    const sent = commands.filter((c) => c.includes('send-keys'))
    expect(sent[1]).toContain('MARKER_XYZ')
    expect(sent[1]).toContain('agsh_sent_')
  })

  test('哨兵文件用后即删(探路 + 真行都不残留)', async () => {
    const { ctx } = makeCtx({ fg: 'zsh', executeLine: true })
    await tmuxSend(ctx, cwd, T, 'echo x')
    const tmp = join(cwd, '.agsh', 'tmp')
    const files = existsSync(tmp) ? readdirSync(tmp) : []
    expect(files.filter((f) => f.startsWith('agsh_sent_'))).toEqual([])
  })
})

describe('门禁三:恢复升级(让下一条命令可用)', () => {
  test('escalateEnabled 默认开,=0 才关', () => {
    expect(escalateEnabled({})).toBe(true)
    expect(escalateEnabled({ AGSH_TERMINAL_ESCALATE: '1' })).toBe(true)
    expect(escalateEnabled({ AGSH_TERMINAL_ESCALATE: '0' })).toBe(false)
  })
})
