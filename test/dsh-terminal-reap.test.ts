import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import {
  pidAlive,
  parseTerminalList,
  selectOrphanTerminals,
  installProcessCleanup,
  uninstallProcessCleanup,
  reapOrphanTerminals,
  type TerminalOwnerInfo,
} from '../src/index.ts'

// 背景(2026-09-25 实测):Ctrl-C 关掉 `dsh web` 后 tmux 终端仍在。
// 根因不是收尾逻辑写错,而是【收尾回调根本没机会跑】:
//   · dsh 启动链(bin.js / dsh-app-boot / dsh-web-app)没有任何 SIGINT/SIGTERM 处理器;
//   · Node 对信号的默认终止不会触发 'exit' 事件(实测注册了 process.on('exit') 也不执行);
//   · cordis 的 ctx.effect 只绑 fiber.dispose(),不绑任何进程事件。
// 所以 session/disposed 与 ctx.effect 两条路都不覆盖 Ctrl-C —— 必须显式接管信号。
// 信号钩子覆盖不了 SIGKILL/崩溃,由「属主标记 + 开机自检」兜底。

// ── 1. 进程级收尾钩子 ─────────────────────────────────────────────────────

describe('installProcessCleanup', () => {
  // 干净基线:前序用例/文件中 apply 过的安装会先被幂等地摘掉,
  // 不先清就会让「安装前后计数差 1」的断言失真。
  beforeEach(() => {
    uninstallProcessCleanup()
  })
  afterEach(() => {
    uninstallProcessCleanup()
  })

  test('注册 SIGINT / SIGTERM / SIGHUP 与 exit 四个钩子', () => {
    const before = {
      SIGINT: process.listenerCount('SIGINT'),
      SIGTERM: process.listenerCount('SIGTERM'),
      SIGHUP: process.listenerCount('SIGHUP'),
      exit: process.listenerCount('exit'),
    }
    const uninstall = installProcessCleanup({ teardown: () => 0 })
    expect(process.listenerCount('SIGINT')).toBe(before.SIGINT + 1)
    expect(process.listenerCount('SIGTERM')).toBe(before.SIGTERM + 1)
    expect(process.listenerCount('SIGHUP')).toBe(before.SIGHUP + 1)
    expect(process.listenerCount('exit')).toBe(before.exit + 1)
    uninstall()
    expect(process.listenerCount('SIGINT')).toBe(before.SIGINT)
    expect(process.listenerCount('SIGTERM')).toBe(before.SIGTERM)
    expect(process.listenerCount('SIGHUP')).toBe(before.SIGHUP)
    expect(process.listenerCount('exit')).toBe(before.exit)
  })

  test('收到信号:先同步收尾,再摘掉自己并原样补发该信号', () => {
    const calls: string[] = []
    const baseline = new Set(process.listeners('SIGINT'))
    const uninstall = installProcessCleanup({
      teardown: () => {
        calls.push('teardown')
        return 3
      },
      raise: (s) => calls.push(`raise:${s}`),
    })
    const added = process.listeners('SIGINT').filter((l) => !baseline.has(l))
    expect(added.length).toBe(1)

    ;(added[0] as () => void)()

    // 顺序关键:必须【先收尾再补发】,否则 rais 之后进程已终止,收尾跑不完。
    expect(calls).toEqual(['teardown', 'raise:SIGINT'])
    // 摘掉自己 ⇒ 宿主若无其他处理器则回到默认终止(退出码 128+n 与不接管时一致)。
    expect(process.listeners('SIGINT').filter((l) => !baseline.has(l))).toEqual([])
    uninstall()
  })

  test('exit 钩子同样执行收尾(正常退出路径)', () => {
    const calls: string[] = []
    const baseline = new Set(process.listeners('exit'))
    const uninstall = installProcessCleanup({ teardown: () => (calls.push('teardown'), 0) })
    const added = process.listeners('exit').filter((l) => !baseline.has(l))
    expect(added.length).toBe(1)
    ;(added[0] as () => void)()
    expect(calls).toEqual(['teardown'])
    uninstall()
  })

  test('幂等:插件 reload 重复 apply 不叠加处理器', () => {
    const before = process.listenerCount('SIGINT')
    installProcessCleanup({ teardown: () => 0, raise: () => {} })
    const once = process.listenerCount('SIGINT')
    installProcessCleanup({ teardown: () => 0, raise: () => {} })
    installProcessCleanup({ teardown: () => 0, raise: () => {} })
    expect(once).toBe(before + 1)
    expect(process.listenerCount('SIGINT')).toBe(once)
    uninstallProcessCleanup()
    expect(process.listenerCount('SIGINT')).toBe(before)
  })

  test('陈旧 disposer 不会摘掉后来安装的那一套', () => {
    const before = process.listenerCount('SIGTERM')
    const stale = installProcessCleanup({ teardown: () => 0, raise: () => {} })
    const live = installProcessCleanup({ teardown: () => 0, raise: () => {} })
    // 旧纤维的 disposer 若晚于新纤维的 apply 运行,不得误摘新钩子。
    stale()
    expect(process.listenerCount('SIGTERM')).toBe(before + 1)
    live()
    expect(process.listenerCount('SIGTERM')).toBe(before)
  })
})

// ── 2. 属主标记与残留判定 ─────────────────────────────────────────────────

describe('pidAlive', () => {
  test('本进程存活', () => {
    expect(pidAlive(process.pid)).toBe(true)
  })

  test('非法 pid 一律视为不存活', () => {
    expect(pidAlive(0)).toBe(false)
    expect(pidAlive(-1)).toBe(false)
    expect(pidAlive(1.5)).toBe(false)
    expect(pidAlive(NaN)).toBe(false)
  })

  test('不存在的 pid 视为不存活', () => {
    expect(pidAlive(999999)).toBe(false)
  })
})

describe('parseTerminalList', () => {
  test('解析 session / 属主 / 创建时刻,空字段归 null', () => {
    const out = parseTerminalList(
      ['agsh-a\t4242\t1700000000', 'agsh-b\t\t1700000001', 'agsh-c\t4243\t', '', '   '].join('\n'),
    )
    expect(out).toEqual([
      { session: 'agsh-a', ownerPid: 4242, createdEpoch: 1700000000 },
      { session: 'agsh-b', ownerPid: null, createdEpoch: 1700000001 },
      { session: 'agsh-c', ownerPid: 4243, createdEpoch: null },
    ])
  })

  test('空输出返回空表(终端不存在时 list-sessions 无输出)', () => {
    expect(parseTerminalList('')).toEqual([])
  })
})

describe('selectOrphanTerminals', () => {
  const NOW = 1_700_000_100

  const list = (): TerminalOwnerInfo[] => [
    { session: 'agsh-self', ownerPid: 111, createdEpoch: NOW },
    { session: 'agsh-live', ownerPid: 222, createdEpoch: NOW },
    { session: 'agsh-dead', ownerPid: 333, createdEpoch: NOW },
    { session: 'agsh-young', ownerPid: null, createdEpoch: NOW - 5 },
    { session: 'agsh-old', ownerPid: null, createdEpoch: NOW - 3600 },
    { session: 'agsh-noclock', ownerPid: null, createdEpoch: null },
    { session: 'user-own', ownerPid: null, createdEpoch: NOW - 3600 },
  ]
  const alive = (pid: number): boolean => pid === 111 || pid === 222

  test('只挑属主已死或超期无标记的 agsh- 会话', () => {
    expect(selectOrphanTerminals(list(), 111, NOW, 60_000, alive)).toEqual(['agsh-dead', 'agsh-old'])
  })

  test('绝不回收非 agsh- 前缀的会话(用户自己的 tmux 会话)', () => {
    const only = [{ session: 'work', ownerPid: null, createdEpoch: NOW - 999_999 }]
    expect(selectOrphanTerminals(only, 111, NOW, 60_000, alive)).toEqual([])
  })

  test('无创建时刻的无标记会话永不回收(判不出年龄 ⇒ 宁漏杀不误杀)', () => {
    const noclock: TerminalOwnerInfo[] = [{ session: 'agsh-noclock', ownerPid: null, createdEpoch: null }]
    expect(selectOrphanTerminals(noclock, 111, NOW, 0, alive)).toEqual([])
    expect(selectOrphanTerminals(noclock, 111, NOW, 60_000, alive)).toEqual([])
  })

  test('宽限期边界:未到期保留,刚过期回收', () => {
    const inGrace: TerminalOwnerInfo[] = [{ session: 'agsh-x', ownerPid: null, createdEpoch: NOW - 60 }]
    const past: TerminalOwnerInfo[] = [{ session: 'agsh-x', ownerPid: null, createdEpoch: NOW - 61 }]
    expect(selectOrphanTerminals(inGrace, 111, NOW, 60_000, alive)).toEqual([])
    expect(selectOrphanTerminals(past, 111, NOW, 60_000, alive)).toEqual(['agsh-x'])
  })
})

describe('reapOrphanTerminals', () => {
  function makeReapCtx(stdout: string, throwOnRun = false) {
    const commands: string[] = []
    const shell = {
      resolve: (spec: any) => spec,
      run: async (spec: any) => {
        commands.push(spec.command)
        if (throwOnRun) throw new Error('shell unavailable')
        if (spec.command.includes('list-sessions')) {
          return { exitCode: 0, stdout: { text: stdout }, stderr: { text: '' } }
        }
        return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
      },
    }
    const ctx: any = { get: (k: string) => (k === 'shell' ? shell : undefined) }
    return { ctx, commands }
  }

  const NOW = 1_700_000_100
  const stdout = [
    'agsh-self\t111\t' + NOW,
    'agsh-dead\t333\t' + NOW,
    'agsh-old\t\t' + (NOW - 3600),
    'agsh-inflight\t444\t' + NOW,
    'user-own\t\t' + (NOW - 3600),
  ].join('\n')

  test('回收属主已死/超期无标记的终端,且不碰 keep 里的会话与用户会话', async () => {
    const { ctx, commands } = makeReapCtx(stdout)
    const killed: string[] = []
    const n = await reapOrphanTerminals(ctx, '/tmp/proj', '/tmp/proj/.agsh/tmp/dsh-tmux.sock', {
      keep: new Set(['agsh-inflight']),
      nowEpoch: NOW,
      isAlive: (pid) => pid === 111,
      kill: (t) => killed.push(t.session),
    })
    // agsh-dead(属主死)+ agsh-old(无标记超期);agsh-self 属主活;
    // agsh-inflight 属主死但在 keep 里(本进程正在用)⇒ 保留;user-own 非本插件。
    expect(n).toBe(2)
    expect(killed).toEqual(['agsh-dead', 'agsh-old'])
    expect(commands.length).toBe(1)
    expect(commands[0]).toContain('list-sessions')
    expect(commands[0]).toContain('@agsh_owner')
  })

  test('终端不存在 / shell 不可用时静默返回 0(回收是尽力而为)', async () => {
    const empty = makeReapCtx('')
    expect(await reapOrphanTerminals(empty.ctx, '/tmp/proj', '/tmp/s.sock', { nowEpoch: NOW })).toBe(0)

    const broken = makeReapCtx('', true)
    expect(await reapOrphanTerminals(broken.ctx, '/tmp/proj', '/tmp/s.sock', { nowEpoch: NOW })).toBe(0)
  })
})
