import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, terminalRef, ensureTerminal, teardownLiveTerminals, uninstallProcessCleanup } from '../src/index.ts'

// 背景(tmux 泄漏真根因):原实现把收尾挂在 session/end-seed 上,但那是【构造期
// seed 边界标记】——只在恢复/fork 带 seed 构造时写入,且在 Session 构造期间 append
// (此时尚未 attach,entry 为 undefined)⇒ 从不发布到 session/event 火线。
// 结果:收尾是从不触发的死代码,终端永不销毁 = 泄漏。
// 正确事件是 session/disposed(store 摘除已 announced 会话时的配对收尾)。

/** 假 ctx:捕获 on/effect;脚本化 shell 响应;记录每条命令。 */
function makeCtx(opts: { hasSession: boolean; sendWorks: boolean }) {
  const listeners: Record<string, any> = {}
  const disposers: Array<() => void> = []
  const commands: string[] = []
  const shell = {
    resolve: (spec: any) => spec,
    run: async (spec: any) => {
      const c = spec.command
      commands.push(c)
      if (c.includes('has-session')) {
        return { exitCode: 0, stdout: { text: `RC=${opts.hasSession ? 0 : 1}` }, stderr: { text: '' } }
      }
      if (c.includes('capture-pane')) {
        return { exitCode: 0, stdout: { text: '[none] zsh %' }, stderr: { text: '' } }
      }
      if (c.includes('display-message') && c.includes('pane_current_command')) {
        // 终端「忙」用 sudo 模拟:门禁一据此拒绝注入
        return { exitCode: 0, stdout: { text: opts.sendWorks ? 'zsh' : 'sudo' }, stderr: { text: '' } }
      }
      if (c.includes('display-message') && c.includes('pane_pid')) {
        return { exitCode: 0, stdout: { text: '4242' }, stderr: { text: '' } }
      }
      if (c.includes('send-keys') && opts.sendWorks) {
        const m = c.match(/(\/[^\s']*agsh_sent_\d+_\d+\.txt)/)
        if (m) writeFileSync(m[1], '')
      }
      return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
    },
  }
  const ctx: any = {
    on: (ev: string, fn: any) => {
      listeners[ev] = fn
    },
    effect: (execute: () => any) => {
      const d = execute()
      if (typeof d === 'function') disposers.push(d)
      return () => {}
    },
    tools: { register: () => {} },
    get: (k: string) => (k === 'shell' ? shell : undefined),
    timer: { timeout: (_ms: number) => Promise.resolve() },
  }
  return { ctx, listeners, disposers, commands }
}

function agshSession(cwd: string, id = 'sess-1') {
  return {
    id,
    header: { cwd, agentPreset: 'agsh' },
    snapshotEvents: () => [{ type: 'agent-preset/selected', data: { agentPreset: 'agsh' } }],
  }
}

async function waitFor(pred: () => boolean, ms = 500): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (pred()) return true
    await Bun.sleep(10)
  }
  return pred()
}

let root = ''
let savedRoot: string | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agsh-life-'))
  mkdirSync(join(root, 'agent-shell', 'src'), { recursive: true })
  writeFileSync(join(root, 'agent-shell', 'src', 'cli.ts'), '// stub\n')
  savedRoot = process.env.AGSH_ROOT
  process.env.AGSH_ROOT = join(root, 'agent-shell')
  // 干净基线:本文件的 apply 用例不逐个卸载,前序用例遗留的进程钩子会让
  // 「安装前后计数差 1」的断言失真(installProcessCleanup 幂等,先摘旧的再装)。
  uninstallProcessCleanup()
})

afterEach(() => {
  if (savedRoot === undefined) delete process.env.AGSH_ROOT
  else process.env.AGSH_ROOT = savedRoot
  rmSync(root, { recursive: true, force: true })
})

describe('terminalRef:会话 → 终端坐标(纯函数)', () => {
  test('确定性 + socket 路径 + 会话名前缀', () => {
    const a = terminalRef('/w', 'abc-123')
    const b = terminalRef('/w', 'abc-123')
    expect(a).toEqual(b)
    expect(a.socket).toBe('/w/.agsh/tmp/dsh-tmux.sock')
    expect(a.session).toBe('agsh-abc-123')
  })

  test('会话 id 净化:非 [A-Za-z0-9_-] 替换为 _,并截断到末 40 字符', () => {
    expect(terminalRef('/w', 'a/b c:d').session).toBe('agsh-a_b_c_d')
    const long = 'x'.repeat(60) + 'END'
    const s = terminalRef('/w', long).session
    expect(s.startsWith('agsh-')).toBe(true)
    expect(s.slice('agsh-'.length).length).toBe(40)
    expect(s.endsWith('END')).toBe(true)
  })
})

describe('收尾钩子注册:用 session/disposed,不用 end-seed 死钩子', () => {
  test('apply 注册 session/disposed;不再注册 session/event', () => {
    const { ctx, listeners } = makeCtx({ hasSession: true, sendWorks: true })
    apply(ctx)
    expect(typeof listeners['session/disposed']).toBe('function')
    // 旧实现的死钩子必须消失 —— 它从不触发,是泄漏根因
    expect(listeners['session/event']).toBeUndefined()
  })

  test('apply 用 ctx.effect 注册插件卸载收尾', () => {
    const { ctx, disposers } = makeCtx({ hasSession: true, sendWorks: true })
    apply(ctx)
    expect(disposers.length).toBeGreaterThan(0)
  })

  test('非 agsh 会话 ⇒ 不收尾(零侵入)', async () => {
    const { ctx, listeners, commands } = makeCtx({ hasSession: true, sendWorks: true })
    apply(ctx)
    listeners['session/disposed']({ id: 'x', header: { cwd: root, agentPreset: 'standard' } })
    await Bun.sleep(50)
    expect(commands.filter((c) => c.includes('kill-session'))).toEqual([])
  })
})

describe('收尾行为:终端必须被销毁(否则就是泄漏)', () => {
  test('正常收尾:drop 凭证 + 销毁终端', async () => {
    const { ctx, listeners, commands } = makeCtx({ hasSession: true, sendWorks: true })
    apply(ctx)
    listeners['session/disposed'](agshSession(root))
    const killed = await waitFor(() => commands.some((c) => c.includes('kill-session')))
    expect(killed).toBe(true)
    expect(commands.some((c) => c.includes('credential drop'))).toBe(true)
  })

  test('关键回归:终端忙(drop 失败)仍必须销毁终端 —— 否则回到泄漏', async () => {
    const { ctx, listeners, commands } = makeCtx({ hasSession: true, sendWorks: false })
    apply(ctx)
    listeners['session/disposed'](agshSession(root))
    const killed = await waitFor(() => commands.some((c) => c.includes('kill-session')))
    expect(killed).toBe(true) // drop 被门禁拒绝,但 kill 照做
  })

  test('终端本就不存在 ⇒ 不创建、不 kill(绝不为销毁而建终端)', async () => {
    const { ctx, listeners, commands } = makeCtx({ hasSession: false, sendWorks: true })
    apply(ctx)
    listeners['session/disposed'](agshSession(root))
    await Bun.sleep(80)
    expect(commands.some((c) => c.includes('new-session'))).toBe(false)
    expect(commands.some((c) => c.includes('kill-session'))).toBe(false)
  })
})

describe('插件卸载收尾(ctx.effect):清掉本插件用过的终端', () => {
  test('ensureTerminal 用过的终端被登记,并出现在卸载收尾清单里(且只清一次)', async () => {
    const { ctx, disposers, commands } = makeCtx({ hasSession: false, sendWorks: true })
    apply(ctx)
    // 走一次真实建终端路径 —— 该终端必须被登记,否则卸载时会漏
    await ensureTerminal(ctx, root, join(root, 'agent-shell'), 'unload-1', undefined)
    expect(commands.some((c) => c.includes('new-session'))).toBe(true)
    expect(disposers.length).toBeGreaterThan(0)

    const seen: string[] = []
    const n = teardownLiveTerminals((t) => seen.push(t.session))
    expect(n).toBe(1)
    expect(seen).toEqual(['agsh-unload-1'])
    // 幂等:已清空,再调不重复销毁
    expect(teardownLiveTerminals((t) => seen.push(t.session))).toBe(0)
    expect(seen).toEqual(['agsh-unload-1'])
  })
})

describe('终端认领:属主标记 + server 自退(泄漏的第二半)', () => {
  // 本机 ~/.tmux.conf:29 设了 `set -g exit-empty off`,插件的 tmux server 会继承它
  // —— 会话杀光后 server 仍常驻并留下 socket 文件,只杀会话治不了。故认领时必须
  // 把本 socket 的 exit-empty 按回 on(tmux 的真实默认)。
  test('建终端后会打 @agsh_owner 标记,并把 exit-empty 按回 on', async () => {
    const { ctx, commands } = makeCtx({ hasSession: false, sendWorks: true })
    apply(ctx)
    await ensureTerminal(ctx, root, join(root, 'agent-shell'), 'mark-1', undefined)

    const claim = commands.find((c) => c.includes('@agsh_owner'))
    expect(claim).toBeDefined()
    expect(claim).toContain(String(process.pid))
    expect(claim).toContain('exit-empty on')
  })

  test('复用既有终端时也补打标记(旧版本建的终端没有标记)', async () => {
    const { ctx, commands } = makeCtx({ hasSession: true, sendWorks: true })
    apply(ctx)
    await ensureTerminal(ctx, root, join(root, 'agent-shell'), 'mark-2', undefined)

    expect(commands.some((c) => c.includes('new-session'))).toBe(false) // 确认走的是复用分支
    const claim = commands.find((c) => c.includes('@agsh_owner'))
    expect(claim).toBeDefined()
    expect(claim).toContain('exit-empty on')
  })
})

describe('宿主退出收尾(进程信号):Ctrl-C 关服务器时必须销毁终端', () => {
  // 2026-09-25 实测的洞:session/disposed 只在单个会话关闭时发,ctx.effect 只在
  // fiber.dispose() 时跑;而 dsh 自身不处理信号,Node 的信号默认终止这两条都不走。
  // 故 apply 必须额外安装进程级钩子,且卸载时摘干净。
  test('apply 安装进程级收尾钩子;卸载 disposer 运行时摘除它们', () => {
    const before = {
      SIGINT: process.listenerCount('SIGINT'),
      SIGTERM: process.listenerCount('SIGTERM'),
      SIGHUP: process.listenerCount('SIGHUP'),
      exit: process.listenerCount('exit'),
    }
    const { ctx, disposers } = makeCtx({ hasSession: false, sendWorks: true })
    apply(ctx)

    expect(process.listenerCount('SIGINT')).toBe(before.SIGINT + 1)
    expect(process.listenerCount('SIGTERM')).toBe(before.SIGTERM + 1)
    expect(process.listenerCount('SIGHUP')).toBe(before.SIGHUP + 1)
    expect(process.listenerCount('exit')).toBe(before.exit + 1)

    for (const d of disposers) d()
    expect(process.listenerCount('SIGINT')).toBe(before.SIGINT)
    expect(process.listenerCount('SIGTERM')).toBe(before.SIGTERM)
    expect(process.listenerCount('SIGHUP')).toBe(before.SIGHUP)
    expect(process.listenerCount('exit')).toBe(before.exit)
  })
})
