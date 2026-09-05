import { test, expect, describe } from 'bun:test'
import {
  name,
  inject,
  apply,
  classifyToolCall,
  retryBudget,
  repairDriftChunk,
  shouldRetryAttempt,
  shouldWriteHistory,
  streamInner,
  decideStepRetry,
  appendRetryRecords,
  isSelfInnerRequest,
  AGSH_TOOLCALL_RETRY_CODE,
  AGSH_RETRY_POLICY_KEY,
  SHELL_GUARD_SPEC,
} from '../src/index.ts'

// 真实漂移样本(逐字取自 session-fe692567 第 661 条)
const DRIFT_ARGS = '{"command":"cd /Users/zic/agent-demo && echo \\"=== PRELOAD\\"","cmd":""}'

/** 把事件数组包成一次「API 调用」返回的事件流;log 记录源被拉取的时刻。 */
function scripted(events: any[], log?: string[]) {
  return (async function* () {
    for (const e of events) {
      log?.push(`pull:${e.type}`)
      yield e
    }
  })()
}

/** 驱动生成器,逐块记录「源被拉」与「被放行」的时刻 —— 实时性的判据。 */
async function drive(it: AsyncGenerator<any, any, void>, log: string[]) {
  const out: any[] = []
  for (;;) {
    const s = await it.next()
    if (s.done) return { out, result: s.value }
    log.push(`yield:${s.value.type}`)
    out.push(s.value)
  }
}

/** 假 DSH ctx:捕获 llm/stream 与 agent/request-error listener;脚本化 ctx.llm.stream。
 *  effect 是宿主契约的一部分(插件用它注册卸载收尾),这里捕获 disposer 以便断言。 */
function makeCtx(stream?: AsyncIterable<any>) {
  const listeners: Record<string, any> = {}
  const issued: any[] = []
  const disposers: Array<() => void> = []
  const ctx: any = {
    on: (ev: string, fn: any) => {
      listeners[ev] = fn
    },
    tools: { register: () => {} },
    get: () => undefined,
    effect: (execute: () => any) => {
      const d = execute()
      if (typeof d === 'function') disposers.push(d)
      return () => {}
    },
    llm: {
      stream: (o: any) => {
        issued.push(o)
        return stream
      },
    },
  }
  return { ctx, listeners, issued, disposers }
}

/** 假 agent:session.append 记账。 */
function makeAgent(appended: any[]) {
  return {
    session: {
      id: 's1',
      append: (type: string, data: any) => {
        appended.push({ type, data })
        return { type, data }
      },
    },
  }
}

// DSH chunk 形状(StreamChunk):tool-call 的最终参数在 block-end.block.arguments
const DSH_DRIFT = [
  { type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'tool-call-delta', index: 0, id: 'call_01', name: 'shell', argumentsDelta: DRIFT_ARGS },
  {
    type: 'block-end',
    index: 0,
    block: { type: 'tool-call', id: 'call_01', name: 'shell', arguments: DRIFT_ARGS },
  },
  { type: 'finish', reason: { kind: 'tool-calls' } },
]
const DSH_OK = [
  { type: 'reasoning-delta', index: 0, text: '想一下' },
  { type: 'block-start', index: 1, blockType: 'tool-call' },
  { type: 'tool-call-delta', index: 1, id: 'call_02', name: 'shell', argumentsDelta: '{"cmd":"pwd"}' },
  {
    type: 'block-end',
    index: 1,
    block: { type: 'tool-call', id: 'call_02', name: 'shell', arguments: '{"cmd":"pwd"}' },
  },
  { type: 'finish', reason: { kind: 'tool-calls' } },
]
const DSH_INVALID = [
  { type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'tool-call-delta', index: 0, id: 'call_03', name: 'shell', argumentsDelta: '{"cmd":""}' },
  {
    type: 'block-end',
    index: 0,
    block: { type: 'tool-call', id: 'call_03', name: 'shell', arguments: '{"cmd":""}' },
  },
  { type: 'finish', reason: { kind: 'tool-calls' } },
]

const INNER_OPTIONS = () => ({
  provider: 'deepseek',
  model: 'm',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
  sessionId: 's',
  purpose: 'agsh-inner',
})

describe('A. 导出契约', () => {
  test('插件仍导出 name / inject / apply', () => {
    expect(name).toBe('agsh-context')
    expect(inject).toContain('llm')
    expect(typeof apply).toBe('function')
  })

  test('实时放行 + step 级重试的公开面', () => {
    expect(typeof streamInner).toBe('function')
    expect(typeof repairDriftChunk).toBe('function')
    expect(typeof shouldRetryAttempt).toBe('function')
    expect(typeof decideStepRetry).toBe('function')
    expect(typeof appendRetryRecords).toBe('function')
    expect(AGSH_TOOLCALL_RETRY_CODE).toBe('AGSH_TOOLCALL')
    expect(AGSH_RETRY_POLICY_KEY).toBe('agsh-toolcall')
  })
})

describe('B. 折叠入桥的纯逻辑(镜像 agsh-stdlib/api-retry-core.ts)', () => {
  test('classifyToolCall:ok / drift / invalid / not-shell', () => {
    expect(classifyToolCall('{"cmd":"pwd"}', 'shell')).toBe('ok')
    expect(classifyToolCall('{"command":"pwd","cmd":""}', 'shell')).toBe('drift')
    expect(classifyToolCall(DRIFT_ARGS, 'shell')).toBe('drift')
    expect(classifyToolCall('{"cmd":""}', 'shell')).toBe('invalid')
    expect(classifyToolCall('not-json', 'shell')).toBe('invalid')
    expect(classifyToolCall('{"cmd":"pwd"}', 'bash')).toBe('not-shell')
  })

  test('retryBudget 读 AGSH_API_RETRY_MAX(不读 STDLIB_* 命名空间)', () => {
    expect(retryBudget({})).toBe(2)
    expect(retryBudget({ AGSH_API_RETRY_MAX: '3' })).toBe(3)
    for (const raw of ['0', '-1', 'abc', '', '2.5']) {
      expect(retryBudget({ AGSH_API_RETRY_MAX: raw })).toBe(2)
    }
    // 标准库命名空间不生效(归属边界)
    expect(retryBudget({ STDLIB_API_RETRY_MAX: '9' } as any)).toBe(2)
  })

  test('guard spec', () => {
    expect(SHELL_GUARD_SPEC).toEqual({ tool: 'shell', required: 'cmd', aliases: ['command'] })
  })

  test('shouldRetryAttempt:仅 invalid 且非 max-tokens 截断', () => {
    expect(shouldRetryAttempt('invalid', { kind: 'tool-calls' })).toBe(true)
    expect(shouldRetryAttempt('invalid', { kind: 'max-tokens' })).toBe(false)
    expect(shouldRetryAttempt('ok', { kind: 'tool-calls' })).toBe(false)
    expect(shouldRetryAttempt('drift', { kind: 'tool-calls' })).toBe(false)
    expect(shouldRetryAttempt('not-shell', { kind: 'tool-calls' })).toBe(false)
  })

  // 回归:收尾块形状是 { type:'finish', reason:{kind} },没有顶层 kind
  // (dsh-llm types.d.ts:385-389)。曾误用 finish.kind 写守卫 ⇒ 恒真 ⇒ 被传输
  // 中断(TRANSPORT/TIMEOUT)或 aborted 的截断流被当成完整回复写进 history。
  test('shouldWriteHistory:error / aborted 的截断流不落盘', () => {
    const finish = (reason: any) => ({ type: 'finish', reason })
    // 正常收尾 ⇒ 写
    expect(shouldWriteHistory(finish({ kind: 'tool-calls' }), false)).toBe(true)
    expect(shouldWriteHistory(finish({ kind: 'stop' }), false)).toBe(true)
    expect(shouldWriteHistory(finish({ kind: 'max-tokens' }), false)).toBe(true)
    // 传输中断 / 超时 ⇒ 不写(这正是 1.2M–1.4M 字符截断流被落盘的那条路径)
    expect(shouldWriteHistory(finish({ kind: 'error', failure: { code: 'TRANSPORT' } }), false)).toBe(false)
    expect(shouldWriteHistory(finish({ kind: 'error', failure: { code: 'TIMEOUT' } }), false)).toBe(false)
    expect(shouldWriteHistory(finish({ kind: 'aborted' }), false)).toBe(false)
    // 插件已合成 error 收尾(substituted)⇒ 不写
    expect(shouldWriteHistory(finish({ kind: 'tool-calls' }), true)).toBe(false)
    // 缺收尾 ⇒ 不写
    expect(shouldWriteHistory(undefined, false)).toBe(false)
  })

  test('回归:收尾块没有顶层 kind,守卫必须读 finish.reason.kind', () => {
    const f: any = { type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT' } } }
    expect(f.kind).toBeUndefined() // 顶层不存在 ⇒ 旧写法 finish.kind !== 'error' 恒真
    expect(f.reason.kind).toBe('error')
  })
})

describe('C. drift 就地改写(repairDriftChunk)', () => {
  test('真实漂移样本 ⇒ 别名值写进 cmd、别名键删除', () => {
    const out = repairDriftChunk(DSH_DRIFT[2])
    expect(JSON.parse(out.block.arguments)).toEqual({
      cmd: 'cd /Users/zic/agent-demo && echo "=== PRELOAD"',
    })
    expect(out.block.id).toBe('call_01') // 其余字段原样
  })

  test('合规 / 非 shell / 非法 / 非 block-end ⇒ 原对象返回(不改写)', () => {
    const ok = {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', name: 'shell', arguments: '{"cmd":"pwd"}' },
    }
    const other = {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', name: 'bash', arguments: DRIFT_ARGS },
    }
    const bad = { type: 'block-end', index: 0, block: { type: 'tool-call', name: 'shell', arguments: '{"cmd":""}' } }
    const text = { type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } }
    for (const chunk of [ok, other, bad, text]) expect(repairDriftChunk(chunk)).toBe(chunk)
  })
})

describe('D. 实时放行:源被拉一块,就放行一块', () => {
  test('合规尝试:严格交替拉取 / 放行,收尾块原样放行', async () => {
    const log: string[] = []
    const { ctx } = makeCtx(scripted(DSH_OK, log))
    const { out, result } = await drive(streamInner(ctx, INNER_OPTIONS()), log)

    expect(log).toEqual([
      'pull:reasoning-delta',
      'yield:reasoning-delta',
      'pull:block-start',
      'yield:block-start',
      'pull:tool-call-delta',
      'yield:tool-call-delta',
      'pull:block-end',
      'yield:block-end',
      'pull:finish',
      'yield:finish',
    ])
    expect(out.filter((c) => c.type === 'finish').length).toBe(1)
    expect(out.at(-1).reason.kind).toBe('tool-calls')
    expect(result.substituted).toBe(false)
    const be = result.assembler.blocks().find((b: any) => b.type === 'tool-call')
    expect(JSON.parse(be.arguments)).toEqual({ cmd: 'pwd' })
  })

  test('漂移尝试:放行的是改写后的块(assembler 收到的同为一改写版)', async () => {
    const log: string[] = []
    const { ctx } = makeCtx(scripted(DSH_DRIFT, log))
    const { out, result } = await drive(streamInner(ctx, INNER_OPTIONS()), log)

    expect(log[0]).toBe('pull:block-start')
    expect(log[1]).toBe('yield:block-start')
    expect(log.at(-1)).toBe('yield:finish')
    const yielded = out.find((c) => c.type === 'block-end')
    expect(JSON.parse(yielded.block.arguments)).toEqual({ cmd: 'cd /Users/zic/agent-demo && echo "=== PRELOAD"' })
    const assembled = result.assembler.blocks().find((b: any) => b.type === 'tool-call')
    expect(JSON.parse(assembled.arguments)).toEqual({ cmd: 'cd /Users/zic/agent-demo && echo "=== PRELOAD"' })
    expect(result.substituted).toBe(false) // drift 不重发
  })
})

describe('E. 收尾判定:内容不可用 ⇒ 合成 error 收尾(交给 step 级重试)', () => {
  test('非法参数 ⇒ 放行合成 error,原 finish 不放行,substituted=true', async () => {
    const log: string[] = []
    const { ctx } = makeCtx(scripted(DSH_INVALID, log))
    const { out, result } = await drive(streamInner(ctx, INNER_OPTIONS()), log)

    expect(out.filter((c) => c.type === 'finish').length).toBe(1)
    const finish = out.at(-1)
    expect(finish.reason.kind).toBe('error')
    expect(finish.reason.failure.code).toBe(AGSH_TOOLCALL_RETRY_CODE)
    expect(result.substituted).toBe(true)
    expect(result.finish).toBe(finish)
    // 实时性不受影响:工具块照旧逐块放行
    expect(log[0]).toBe('pull:block-start')
    expect(log[1]).toBe('yield:block-start')
  })

  test('流以 error 收尾 ⇒ 原样放行,交 DSH 原生 dsh-llm-retry(不合成)', async () => {
    const events = [
      { type: 'reasoning-delta', index: 0, text: 'x' },
      { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'SERVER' } } },
    ]
    const log: string[] = []
    const { ctx } = makeCtx(scripted(events, log))
    const { out, result } = await drive(streamInner(ctx, INNER_OPTIONS()), log)

    expect(result.substituted).toBe(false)
    expect(out.at(-1).reason.failure.code).toBe('SERVER')
  })

  test('max-tokens 截断的坏参数 ⇒ 不合成(重发只会再截断)', async () => {
    const events = [...DSH_INVALID.slice(0, 3), { type: 'finish', reason: { kind: 'max-tokens' } }]
    const log: string[] = []
    const { ctx } = makeCtx(scripted(events, log))
    const { result } = await drive(streamInner(ctx, INNER_OPTIONS()), log)
    expect(result.substituted).toBe(false)
  })

  test('allowContentRetry=false(预算耗尽)⇒ 不合成,坏参数原样放行给工具边界', async () => {
    const log: string[] = []
    const { ctx } = makeCtx(scripted(DSH_INVALID, log))
    const { out, result } = await drive(streamInner(ctx, INNER_OPTIONS(), { allowContentRetry: false }), log)

    expect(result.substituted).toBe(false)
    expect(out.at(-1).reason.kind).toBe('tool-calls') // 原 finish,不是合成的 error
    expect(out.filter((c) => c.type === 'finish').length).toBe(1)
  })

  test('内层请求经 ctx.llm.stream 发出一次且为原对象(不重发)', async () => {
    const { ctx, issued } = makeCtx(scripted(DSH_OK))
    const options = INNER_OPTIONS()
    await drive(streamInner(ctx, options), [])
    expect(issued.length).toBe(1)
    expect(issued[0]).toBe(options)
  })
})

describe('F. 内容级重试决策(decideStepRetry)', () => {
  const payload = (code: string) => ({
    turn: 3,
    step: 2,
    provider: 'deepseek',
    failure: { message: 'bad args', code },
    agent: { session: { id: 's1' } },
  })

  test('认领本插件失败码:首答给 retry=1,耗尽后放弃', () => {
    const ledger = new Map<string, any>()
    const first = decideStepRetry(payload(AGSH_TOOLCALL_RETRY_CODE), ledger, 2, () => 'rid-1')
    expect(first).toEqual({ retry: 1, retryId: 'rid-1' })
    ledger.set('s1:3:2', first!)
    // 预算含首次=2 ⇒ 最多重试 1 次
    expect(decideStepRetry(payload(AGSH_TOOLCALL_RETRY_CODE), ledger, 2, () => 'rid-2')).toBe(null)
    // 预算 3 ⇒ 还能再来一次,且沿用同一 retryId
    expect(decideStepRetry(payload(AGSH_TOOLCALL_RETRY_CODE), ledger, 3, () => 'rid-2')).toEqual({
      retry: 2,
      retryId: 'rid-1',
    })
  })

  test('非本插件失败码 / 已取消 / 无会话 ⇒ 不认领', () => {
    const ledger = new Map<string, any>()
    expect(decideStepRetry(payload('SERVER'), ledger, 2, () => 'x')).toBe(null)
    const aborted = { ...payload(AGSH_TOOLCALL_RETRY_CODE), signal: { aborted: true } }
    expect(decideStepRetry(aborted, ledger, 2, () => 'x')).toBe(null)
    const noSession = { ...payload(AGSH_TOOLCALL_RETRY_CODE), agent: { session: {} } }
    expect(decideStepRetry(noSession, ledger, 2, () => 'x')).toBe(null)
  })
})

describe('G. 重试记录形状(对齐 dsh-llm-retry 的持久化契约)', () => {
  test('llm/retry + llm/retry-started 成对写入,字段齐备', () => {
    const appended: any[] = []
    const agent = makeAgent(appended)
    const payload = {
      turn: 3,
      step: 2,
      provider: 'deepseek',
      failure: { message: 'bad args', code: AGSH_TOOLCALL_RETRY_CODE },
    }
    expect(appendRetryRecords(agent, payload, { retry: 1, retryId: 'rid-1' }, 2)).toBe(true)
    expect(appended.map((a) => a.type)).toEqual(['llm/retry', 'llm/retry-started'])
    expect(appended[0].data).toEqual({
      retryId: 'rid-1',
      turn: 3,
      step: 2,
      provider: 'deepseek',
      mode: 'normal',
      policyKey: AGSH_RETRY_POLICY_KEY,
      retry: 1,
      maxRetries: 2,
      delayMs: 0,
      failure: { message: 'bad args', code: AGSH_TOOLCALL_RETRY_CODE },
    })
    expect(appended[1].data).toEqual({ retryId: 'rid-1', turn: 3, step: 2, retry: 1 })
  })

  test('宿主不支持 append ⇒ false(调用方降级放行)', () => {
    expect(appendRetryRecords({}, { turn: 1, step: 1 }, { retry: 1, retryId: 'r' }, 2)).toBe(false)
  })

  test('append 抛错 ⇒ 向调用方传播(由 apply 捕获后降级)', () => {
    const agent = {
      session: {
        id: 's1',
        append: () => {
          throw new Error('llm/retry must be appended inside an open step')
        },
      },
    }
    expect(() => appendRetryRecords(agent, { turn: 1, step: 1 }, { retry: 1, retryId: 'r' }, 2)).toThrow()
  })
})

describe('H. apply 注册的 agent/request-error(内容级重试的入口)', () => {
  const payload = (code: string, appended: any[]) => ({
    turn: 3,
    step: 2,
    provider: 'deepseek',
    failure: { message: 'bad args', code },
    agent: makeAgent(appended),
    signal: { aborted: false },
  })

  test('本插件失败码 ⇒ 写记录并返回 retry;预算耗尽 ⇒ next()', async () => {
    const appended: any[] = []
    const { ctx, listeners } = makeCtx(scripted(DSH_OK))
    apply(ctx)
    const handler = listeners['agent/request-error']
    expect(typeof handler).toBe('function')

    const p = payload(AGSH_TOOLCALL_RETRY_CODE, appended)
    const decision = await handler(p, () => 'NEXT')
    expect(decision).toEqual({ kind: 'retry' })
    expect(appended.map((a) => a.type)).toEqual(['llm/retry', 'llm/retry-started'])

    // 同一步骤第二次 ⇒ 预算(含首次 2)耗尽,交还下游
    const again = await handler(p, () => 'NEXT')
    expect(again).toBe('NEXT')
    expect(appended.length).toBe(2)
  })

  test('非本插件失败码 ⇒ 直接 next()(provider 自身的重试归 dsh-llm-retry)', async () => {
    const appended: any[] = []
    const { ctx, listeners } = makeCtx(scripted(DSH_OK))
    apply(ctx)
    const decision = await listeners['agent/request-error'](payload('SERVER', appended), () => 'NEXT')
    expect(decision).toBe('NEXT')
    expect(appended.length).toBe(0)
  })

  test('记录被宿主的 invariant 拒收 ⇒ 降级放行,不死循环', async () => {
    const { ctx, listeners } = makeCtx(scripted(DSH_OK))
    apply(ctx)
    const agent = {
      session: {
        id: 's1',
        append: () => {
          throw new Error('llm/retry must be appended inside an open step')
        },
      },
    }
    const decision = await listeners['agent/request-error'](
      {
        turn: 1,
        step: 1,
        provider: 'deepseek',
        failure: { message: 'x', code: AGSH_TOOLCALL_RETRY_CODE },
        agent,
        signal: { aborted: false },
      },
      () => 'NEXT',
    )
    expect(decision).toBe('NEXT')
  })
})

describe('I. 门禁:SELF 标记仍可用于防自我递归', () => {
  test('SELF 判定函数仍在(标记在 agshStream 构造 innerOptions 时完成)', () => {
    const options = INNER_OPTIONS()
    expect(isSelfInnerRequest(options)).toBe(false)
    expect(typeof options).toBe('object')
  })
})
