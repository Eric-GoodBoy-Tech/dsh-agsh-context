/**
 * dsh-agsh-context — 节点链桥插件(Path B:请求接管)
 *
 * 定案架构:
 *   DSH = 调度 + API 调用 + 指向持续终端的 shell 工具。
 *   agent-shell headless(AGENT_HEADLESS)持续终端 = 凭证/节点权威;
 *   工具结果 history 由终端 precmd 尾调(_record_tool_result,_cred_before
 *   按命令捕获)写入——history 权威在框架,DSH 记录与终端永不冲突。
 *
 * 机制(全部走 DSH 官方扩展点,循环本身不动):
 *   1. 注册唯一模型工具 `shell`——指向持续终端(tmux PTY + agent.zsh headless)。
 *      执行走注入协议(单行:export 捕获变量 + 行级重定向捕获输出);
 *      终端 precmd 尾调写 history;插件轮询 history 取结果(History 即同步通道)。
 *   2. agent/pre-step:user 消息以 Message 结构追加到当前目标节点 history
 *      (无凭证时回到上一节点 claim 继续;仅首句落会话专属节点)。
 *   3. llm/stream 短路接管:循环主请求(isAgentLoopRequest)被替换为
 *      `agsh context build --cred <id>` 上下文(前插 DSH 嵌入模式说明)+
 *      一次全新 one-shot 调用;流结束后 assistant 消息写入目标节点 history。
 *      内层调用**实时放行**(思维链/正文/工具调用以模型生成速度到达 UI);
 *      参数漂移就地改写;内容级不可用则合成 error 收尾,经 agent/request-error
 *      请求 DSH 重跑本 step(见下「实时放行 + 漂移就地改写 + step 级重试」)。
 *
 *   DSH 回合模型:回合以最终回复结束,不需要每轮 drop,凭证跨轮保留;
 *   切换节点用 claim(自动释放旧绑定);执行 drop 则本节点段立即结束,
 *   本轮不再执行命令(原生 drop 后 precmd 停 loop 的同语义,插件中介);
 *   下一条用户消息自然回到本节点 claim 继续(不落会话节点,不新开段;
 *   claim 被其他会话锁挡下则回退本会话专属节点);
 *   会话结束时插件代为 drop + 销毁终端。
 */
import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync, mkdirSync, appendFileSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

export const name = 'agsh-context'
export const inject = ['llm', 'shell', 'timer', 'tools', 'sessions']

// ── 模型侧唯一工具:shell,与 agent-shell 的 SHELL_TOOL 同构 ──
const SHELL_TOOL_SCHEMA = {
  name: 'shell',
  description:
    '在持续终端(真实交互式 zsh,已加载 agent-shell)中执行 shell 命令。' +
    'cd、export、文件写入在调用间持久。节点协议(credential claim/drop、prompt)在这里原生可用。',
  parameters: {
    type: 'object',
    properties: {
      cmd: { type: 'string', description: '要执行的 shell 命令' },
    },
    required: ['cmd'],
  },
}

// ── 门禁:仅 agsh 预设参与侵入(零侵入其他模式)────────────────────────
// 语义镜像官方 agentPreset 投影(agentPresetProjectionDefinition):
// 最新 agent-preset/selected 事件胜出,回退 session.header.agentPreset。
// 事件源优先取 session.snapshotEvents()(公开访问器,含 fork 继承前缀,
// 与官方 buildCell 的全量折叠一致);Session 无该访问器时回退旧字段。
// session/header/事件源缺失 → false。
export function isAgentShellSession(session: any): boolean {
  if (!session) return false
  const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : session.events
  if (Array.isArray(events)) {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      if (e?.type === 'agent-preset/selected') return e.data?.agentPreset === 'agsh'
    }
  }
  return session.header?.agentPreset === 'agsh'
}

// ── 双重实例免疫:llm/stream 门禁三分判定(SELF_INNER → identity → shape)──
// 背景:isAgentLoopRequest 基于 dsh-llm 每物理拷贝一份的 WeakSet 身份匹配;
// 插件与 harness 解析到不同物理拷贝(标准 bun install 落地)时恒 false,
// llm/stream 永不接管、静默降级。shape 谓词做跨实例回退:harness 循环主
// 请求无 purpose 字段;其余 llm.stream 调用者仅 dsh-compaction-basic
// (purpose:"compaction") 与 dsh-session-title-llm(purpose:"session-title")。
// 插件自身 one-shot inner 调用由本地 WeakSet 先行放行 + purpose 双保险,
// 避免 shape 谓词误吞造成递归。
const SELF_INNER_REQUESTS = new WeakSet<object>()

function looksLikeAgentLoopRequest(options: any): boolean {
  return (
    options !== null &&
    typeof options === 'object' &&
    options.purpose === undefined &&
    typeof options.provider === 'string' &&
    options.provider.length > 0 &&
    typeof options.model === 'string' &&
    options.model.length > 0 &&
    Array.isArray(options.messages) &&
    options.messages.length > 0 &&
    options.messages.every((m: any) => m !== null && typeof m === 'object' && typeof m.role === 'string') &&
    typeof options.sessionId === 'string' &&
    options.sessionId.length > 0
  )
}

// ── 工具 ────────────────────────────────────────────────────────────────

function safeRead(p: string): string {
  try {
    return readFileSync(p, 'utf-8')
  } catch {
    return ''
  }
}

function appendHistory(nodesPath: string, id: string, msgs: any[]): void {
  if (!msgs || msgs.length === 0) return
  const dir = join(nodesPath, id)
  // D2: never create a node implicitly. A missing dir means the target is
  // invalid (stale credential / deleted node) — writing history would spawn
  // a ghost node with no context/parent and silently mix runs. Log and skip.
  if (!existsSync(dir)) {
    console.error(`[agsh] appendHistory: node '${id}' does not exist — history write skipped`)
    return
  }
  try {
    appendFileSync(join(dir, 'history'), JSON.stringify(msgs) + '\n', 'utf-8')
  } catch {
    /* ignore */
  }
}

/** 健康补全的幂等判定:该 callId 在节点 history 中是否已有 tool 结果。
 *  id 为空(无落点节点)时返回 true —— 此时补写无意义。 */
function historyHasToolResult(nodesPath: string, id: string, callId: string): boolean {
  if (!id) return true
  const raw = safeRead(join(nodesPath, id, 'history'))
  if (!raw) return false
  const lines = raw.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim()
    if (!t) continue
    try {
      const arr = JSON.parse(t)
      for (const m of arr) if (m?.role === 'tool' && m.tool_call_id === callId) return true
    } catch {
      /* ignore */
    }
  }
  return false
}

/** agent-shell wire 格式 → harness Message 格式(适配器只认 block 数组;id/source 必填) */
function fromWire(msgs: any[], provider: string, model: string): any[] {
  let n = 0
  return msgs.map((m) => {
    const id = `agsh-${Date.now()}-${n++}`
    switch (m.role) {
      case 'system':
        return {
          id,
          role: 'system',
          content: [{ type: 'text', text: m.content ?? '' }],
          source: { kind: 'plugin', plugin: 'agsh-context' },
        }
      case 'user':
        return { id, role: 'user', content: [{ type: 'text', text: m.content ?? '' }], source: { kind: 'user' } }
      case 'tool':
        return {
          id,
          role: 'user',
          content: [
            {
              type: 'tool-result',
              toolCallId: m.tool_call_id,
              content: [{ type: 'text', text: m.content ?? '' }],
            },
          ],
          source: { kind: 'tool', callId: m.tool_call_id },
        }
      case 'assistant': {
        // 块序按生成顺序:思考在前、正文在后。
        const blocks: any[] = []
        if (m.reasoning_content) blocks.push({ type: 'reasoning', text: m.reasoning_content })
        if (m.content) blocks.push({ type: 'text', text: m.content })
        for (const tc of m.tool_calls ?? []) {
          blocks.push({ type: 'tool-call', id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments ?? '{}' })
        }
        const hasToolCalls = (m.tool_calls ?? []).length > 0
        return {
          id,
          role: 'assistant',
          content: blocks,
          source: {
            kind: 'model',
            provider,
            model,
            // 适配器私有回放信封。没有它,适配器走 foreignAssistant(api 硬编码
            // "dsh-foreign"),pi-ai 的同模型判定因 api 不符恒假,思考被折进正文、
            // reasoning_content 被清空 —— 模型的思考被当成它自己的答复回灌。
            // 签名即 wire 的字段名:convertMessages 只在该签名命中 reasoning 字段时才写回。
            replayState: {
              response: {
                kind: 'pi-ai', version: 2, api: 'openai-completions', provider, model,
                stopReason: hasToolCalls ? 'toolUse' : 'stop',
              },
              blocks: blocks.map((b) => (b.type === 'reasoning' ? { type: 'reasoning', thinkingSignature: 'reasoning_content' } : { type: b.type })),
            },
          },
        }
      }
      default:
        return { id, role: 'user', content: [{ type: 'text', text: JSON.stringify(m) }], source: { kind: 'user' } }
    }
  })
}

/** harness assistant blocks → wire 格式 assistant 消息(写 history 用) */
function toWireAssistant(blocks: any[]): any {
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('')
  const reasoning = blocks.filter((b) => b.type === 'reasoning').map((b) => b.text).join('')
  const toolCalls = blocks
    .filter((b) => b.type === 'tool-call')
    .map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: b.arguments } }))
  const out: any = { role: 'assistant', content: text || null, reasoning_content: reasoning || null }
  if (toolCalls.length) out.tool_calls = toolCalls
  return out
}

/** user 消息 → 纯文本(agent-shell 是纯文本协议) */
function textOfMessage(m: any): string {
  const blocks = Array.isArray(m?.content) ? m.content : []
  return blocks
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('')
    .trim()
}

// ── 配置解析 ─────────────────────────────────────────────────────────────

function agentRootOf(cwd: string): string | null {
  const fromEnv =
    typeof process !== 'undefined' && process.env.AGSH_ROOT ? process.env.AGSH_ROOT : undefined
  if (fromEnv && existsSync(join(fromEnv, 'src', 'cli.ts'))) return fromEnv
  const rel = join(cwd, 'agent-shell')
  if (existsSync(join(rel, 'src', 'cli.ts'))) return rel
  return null
}

// ── shell 原语 ───────────────────────────────────────────────────────────

let counter = 0

async function runSh(
  ctx: Context,
  cwd: string,
  command: string,
  opts: { timeoutMs?: number; signal?: AbortSignal; env?: Record<string, string> } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const shell = ctx.get('shell')
  // 持续终端是 agent-shell 的执行面(零拦截定案);tmux 的 daemon 结构在 seatbelt 下无法运行。
  // 插件基建命令(tmux/bun CLI)一律显式走无沙箱策略。
  const policy: any = ctx.get('sandboxPolicy')?.resolve?.({ mode: 'danger-full-access' })
  const spec = shell.resolve({
    command,
    workdir: cwd,
    timeoutMs: opts.timeoutMs ?? 30000,
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.env ? { env: opts.env } : {}),
    ...(policy ? { sandboxPolicy: policy } : {}),
  })
  const r = await shell.run(spec)
  return { exitCode: r.exitCode, stdout: r.stdout?.text ?? '', stderr: r.stderr?.text ?? '' }
}

/** shell 单引号转义 */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

// ── 持续终端(tmux PTY)───────────────────────────────────────────────────

interface TmuxRef {
  socket: string
  session: string
}

// ── 注入门禁(三道)──────────────────────────────────────────────────────
// 背景(2026-09-22 r24-plan 事故):注入协议假设「终端停在 shell 提示符等输入」,
// 但该前提从未被验证。当 sudo 在等认证(阻塞在 PAM/系统层)时,整条注入行被
// 前台进程当作输入吃掉 —— 命令从未执行、history 永不落盘、插件空转 120s;
// 而 120s 后补发的 C-c 也打不断 PAM 层认证(PTY 里的 0x03 够不着它)。
// 另有两处结构性缺口:AGENT_EXEC_TIMEOUT 默认 0(看门狗关),且它由 _agent_preexec
// 启动 —— preexec 先于注入行执行,看不到行内才 export 的 _AGENT_CAPTURE,故对本
// 注入路径永远不生效。三道门禁因此全部落在插件侧(DSH 官方扩展点):
//   门禁一 注入前探前台进程:非 shell 则拒绝注入(兼安全:不把注入行喂成 sudo 的密码尝试)
//   门禁二 sentinel 探针:行首写哨兵文件;缺席 = 该行没落到 shell(兜住门禁一看不见的内建 read)
//   门禁三 恢复升级:C-c → 杀前台子进程 → 仍卡则销毁终端(默认开),使【下一条命令】可用

/** 可接受注入的 shell 前台进程名(门禁一判据) */
const SHELL_COMMANDS = new Set(['zsh', 'bash', 'sh', 'dash', 'ksh', 'fish'])

export function isShellCommand(fg: string): boolean {
  const name = String(fg ?? '').trim().split('/').pop() ?? ''
  return SHELL_COMMANDS.has(name)
}

/** 终端被占用(前台不是 shell)时抛出:命令未执行,不空转。 */
export class TerminalBusyError extends Error {
  constructor(public readonly foreground: string) {
    super(`terminal occupied by '${foreground || 'unknown'}'; command not executed`)
    this.name = 'TerminalBusyError'
  }
}

/** 终端被占用时的诚实错误文案:说明命令未执行 + 如何恢复。 */
export function terminalBusyMessage(fg: string): string {
  const who = fg && !isShellCommand(fg) ? fg : '前台进程'
  return (
    `[终端被占用] ${who} 正在等待输入(如 sudo/ssh/认证提示),本命令未执行。\n` +
    `请先在持续终端处理该提示(sudo 认证、退出交互程序等),再重试本命令。`
  )
}

/** 终端前台进程名(tmux pane_current_command);失败/空返回 ''(= 无法判定,放行)。 */
async function foregroundCommand(ctx: Context, cwd: string, t: TmuxRef): Promise<string> {
  const r = await runSh(
    ctx,
    cwd,
    `tmux -S ${sq(t.socket)} display-message -p -t ${sq(t.session)} '#{pane_current_command}' 2>/dev/null`,
    { timeoutMs: 10000 },
  )
  return r.stdout.trim()
}

/** 注入探针路径(每次注入唯一) */
function sentinelPath(tmpDir: string): string {
  return join(tmpDir, `agsh_sent_${Date.now()}_${counter++}.txt`)
}

/** sentinel 等待上限(ms):慢机器/高负载可调大,非法值回落 4000。 */
export function sentinelTimeoutMs(env: Record<string, string | undefined>): number {
  const n = Number(env?.AGSH_SENTINEL_TIMEOUT_MS)
  return Number.isFinite(n) && n > 0 ? n : 4000
}

/** 等 sentinel 落地:出现 = 注入行确实执行到了 shell。 */
async function waitSentinel(ctx: Context, file: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (existsSync(file)) return true
    if (signal?.aborted) return false
    if (Date.now() >= deadline) return false
    await ctx.timer.timeout(100)
  }
}

/** 发一条无害短行 `: > <哨兵>` 探路;落地 = 终端确实停在 shell 提示符、能接收注入。
 *  真行因此在任何情况下都不会被 reader 吃掉:内建 read 时 pane_current_command
 *  仍报 zsh(门禁一看不见),若直接把真行发进去,reader 会拿到含节点 id/路径的
 *  一整行 —— 探路把这一步提到注入【之前】。 */
async function probeSentinel(
  ctx: Context,
  cwd: string,
  t: TmuxRef,
  tmpDir: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const probe = sentinelPath(tmpDir)
  const r = await runSh(ctx, cwd, `tmux -S ${sq(t.socket)} send-keys -t ${sq(t.session)} -- ${sq(`: > ${sq(probe)}`)} Enter`, {
    timeoutMs: 15000,
    signal,
  })
  if (r.exitCode !== 0) throw new Error(`tmux send-keys failed: ${r.stderr || r.stdout}`)
  const landed = await waitSentinel(ctx, probe, sentinelTimeoutMs(process.env), signal)
  try {
    rmSync(probe)
  } catch {
    /* ignore */
  }
  return landed
}

/** 门禁一 + 门禁二。任一不过 ⇒ TerminalBusyError(命令未执行)。 */
export async function tmuxSend(
  ctx: Context,
  cwd: string,
  t: TmuxRef,
  text: string,
  signal?: AbortSignal,
): Promise<void> {
  const tmpDir = join(cwd, '.agsh', 'tmp')
  mkdirSync(tmpDir, { recursive: true })

  // ── 门禁一:前台必须是 shell ──
  // 非 shell(sudo/ssh/长命令)⇒ 不注入。除了避免静默挂死,更因为把注入行
  // (含凭证 id、路径)送进认证提示会变成一次「密码尝试」,可能触发锁定。
  // 空应答视为无法判定 → 放行,交给门禁二兜底。短暂外部进程(如终端尾调的
  // bun)会被下面的重试窗口吸收,不误判。
  let fg = ''
  for (let i = 0; i < 5; i++) {
    fg = await foregroundCommand(ctx, cwd, t)
    if (fg === '' || isShellCommand(fg)) break
    await ctx.timer.timeout(200)
  }
  if (fg !== '' && !isShellCommand(fg)) throw new TerminalBusyError(fg)

  // ── 门禁二:探路哨兵(注入之前)──
  if (!(await probeSentinel(ctx, cwd, t, tmpDir, signal))) {
    throw new TerminalBusyError(await foregroundCommand(ctx, cwd, t))
  }

  // ── 门禁二续:真行自带哨兵,确认确实落到了 shell(覆盖探路→真行之间的窄窗口)──
  const sentinel = sentinelPath(tmpDir)
  const line = `: > ${sq(sentinel)}; ${text}`
  const r = await runSh(ctx, cwd, `tmux -S ${sq(t.socket)} send-keys -t ${sq(t.session)} -- ${sq(line)} Enter`, {
    timeoutMs: 15000,
    signal,
  })
  if (r.exitCode !== 0) throw new Error(`tmux send-keys failed: ${r.stderr || r.stdout}`)
  const landed = await waitSentinel(ctx, sentinel, sentinelTimeoutMs(process.env), signal)
  try {
    rmSync(sentinel)
  } catch {
    /* ignore */
  }
  if (!landed) throw new TerminalBusyError(await foregroundCommand(ctx, cwd, t))
}

/** 恢复升级开关:默认开;AGSH_TERMINAL_ESCALATE=0 关闭(只保留 C-c)。 */
export function escalateEnabled(env: Record<string, string | undefined>): boolean {
  return env?.AGSH_TERMINAL_ESCALATE !== '0'
}

/** 终端是否已回到 shell(空应答视为无法判定 → 当作已恢复,不误伤)。 */
async function terminalAtShell(ctx: Context, cwd: string, t: TmuxRef): Promise<boolean> {
  const fg = await foregroundCommand(ctx, cwd, t)
  return fg === '' || isShellCommand(fg)
}

/** pane 内 shell 的 PID(用于精准杀前台子进程)。取不到返回 ''。 */
async function panePid(ctx: Context, cwd: string, t: TmuxRef): Promise<string> {
  const r = await runSh(
    ctx,
    cwd,
    `tmux -S ${sq(t.socket)} display-message -p -t ${sq(t.session)} '#{pane_pid}' 2>/dev/null`,
    { timeoutMs: 10000 },
  )
  const pid = r.stdout.trim()
  return /^\d+$/.test(pid) ? pid : ''
}

/** 门禁三:恢复升级(逐级,默认开)。目标是让【下一条命令】直接可用:
 *   1. C-c —— 与手动中断同路径,对普通前台作业足够(ISIG 有效时)
 *   2. 杀掉 shell 的前台子进程(sudo/ssh/长命令)—— 不销毁终端,cwd/env 保留
 *   3. 仍卡(内建 read:shell 自己阻塞,无子进程可杀)⇒ 销毁终端,
 *      下次 ensureTerminal 重建并自动 re-claim 凭证(节点/history 权威在文件里)。
 *  AGSH_TERMINAL_ESCALATE=0 时只做第 1 步。 */
export async function recoverTerminal(ctx: Context, cwd: string, t: TmuxRef, reason: string): Promise<void> {
  // 1. C-c
  await runSh(ctx, cwd, `tmux -S ${sq(t.socket)} send-keys -t ${sq(t.session)} C-c`, { timeoutMs: 10000 })
  await ctx.timer.timeout(500)
  if (await terminalAtShell(ctx, cwd, t)) return

  if (!escalateEnabled(process.env)) {
    console.error(`[agsh] terminal still occupied (${reason}); escalation disabled (AGSH_TERMINAL_ESCALATE=0)`)
    return
  }

  // 2. 精准杀前台子进程:只杀 shell 的子进程,shell 本身与凭证都不动。
  const pid = await panePid(ctx, cwd, t)
  if (pid) {
    await runSh(
      ctx,
      cwd,
      `pkill -TERM -P ${pid} 2>/dev/null; sleep 0.3; pkill -KILL -P ${pid} 2>/dev/null; true`,
      { timeoutMs: 10000 },
    )
    await ctx.timer.timeout(500)
    if (await terminalAtShell(ctx, cwd, t)) {
      console.error(`[agsh] terminal recovered by killing foreground child of ${pid} (${reason})`)
      return
    }
  }

  // 3. shell 自身卡在内建 read ⇒ 销毁终端,下次重建 + re-claim
  await runSh(ctx, cwd, `tmux -S ${sq(t.socket)} kill-session -t ${sq(t.session)} 2>/dev/null; true`, {
    timeoutMs: 10000,
  })
  console.error(`[agsh] terminal unusable (${reason}); session killed — rebuilt on next call`)
}

async function tmuxHas(ctx: Context, cwd: string, t: TmuxRef): Promise<boolean> {
  const r = await runSh(ctx, cwd, `tmux -S ${sq(t.socket)} has-session -t ${sq(t.session)} 2>/dev/null; echo "RC=$?"`, {
    timeoutMs: 10000,
  })
  return r.stdout.includes('RC=0')
}

/** 会话 → 持续终端坐标(纯函数,不创建)。命名是 ensureTerminal 的契约,收尾路径
 *  据此定位既有终端,避免为了销毁而先把终端创建出来。 */
export function terminalRef(cwd: string, sessionId: string): TmuxRef {
  return {
    socket: join(cwd, '.agsh', 'tmp', 'dsh-tmux.sock'),
    session: 'agsh-' + String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_').slice(-40),
  }
}

/** 本插件起过/用过的终端(socket\0session)。插件卸载或宿主退出时据此收尾,
 *  否则 tmux server 会变成孤儿常驻。 */
const liveTerminals = new Set<string>()

function terminalKey(t: TmuxRef): string {
  return `${t.socket}\u0000${t.session}`
}

/** 销毁一个终端(best-effort,收尾路径专用:不抛、不依赖 ctx)。 */
function killTerminalSync(t: TmuxRef): void {
  try {
    execFileSync('tmux', ['-S', t.socket, 'kill-session', '-t', t.session], { stdio: 'ignore' })
  } catch {
    /* 终端早已不在:无妨 */
  }
  // 只杀会话是不够的:tmux 的 `exit-empty` 一旦是 off(本机 ~/.tmux.conf:29 正是
  // `set -g exit-empty off`),server 在会话杀光后【仍会常驻】并留下 socket 文件 ——
  // 泄漏的第二半。在确认【本 socket 已无任何会话】后补一刀 kill-server。
  // 必须先确认为空:同一 cwd 下可能有其它 DSH 会话正用着同一个 socket。
  try {
    const out = execFileSync('tmux', ['-S', t.socket, 'list-sessions', '-F', '#{session_name}'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (out.split('\n').every((line) => !line.trim())) {
      execFileSync('tmux', ['-S', t.socket, 'kill-server'], { stdio: 'ignore' })
    }
  } catch {
    /* server 已不在:正是想要的结果 */
  }
}

/** 卸载收尾:销毁本插件用过的全部终端并清空登记,返回销毁个数。
 *  kill 可注入(测试用);默认走同步直接调用 —— 宿主退出路径上 ctx 可能已不可用。 */
export function teardownLiveTerminals(kill: (t: TmuxRef) => void = killTerminalSync): number {
  let n = 0
  for (const key of liveTerminals) {
    const i = key.indexOf('\u0000')
    kill({ socket: key.slice(0, i), session: key.slice(i + 1) })
    n++
  }
  liveTerminals.clear()
  return n
}

// ── 进程级收尾:Ctrl-C 关服务器时销毁终端 ─────────────────────────────────
//
// 背景(2026-09-25 实测):`ctx.effect` 只绑 cordis 的 fiber.dispose(),**不绑任何
// 进程事件**;而 dsh 整条启动链(bin.js / dsh-app-boot / dsh-web-app)没有任何
// SIGINT / SIGTERM 处理器。于是 Ctrl-C 时走 Node 的【信号默认终止】—— 进程被信号
// 直接杀掉(退出码 128+n),既不触发 'exit' 事件(实测:注册了 process.on('exit')
// 也不会执行),也没有 fiber.dispose()。结果:session/disposed 与 ctx.effect 两条
// 收尾路径都不走,tmux 终端原地变成孤儿。
// 结论:必须显式接管进程信号,且必须用【同步】销毁(异步回调在终止路径上跑不完)。

/** 进程收尾钩子的可注入点(测试用)。 */
export interface ProcessCleanupHooks {
  /** 收尾动作,默认销毁本插件用过的全部终端。 */
  teardown?: () => number
  /** 补发信号以还原宿主原有终止语义;测试注入假实现,避免真杀掉测试进程。 */
  raise?: (signal: NodeJS.Signals) => void
}

const CLEANUP_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']

let installedSignalHandlers: { signal: NodeJS.Signals; handler: () => void }[] | null = null
let installedExitHandler: (() => void) | null = null

/** 摘除本模块安装的全部进程收尾钩子(信号路径与插件卸载共用)。 */
export function uninstallProcessCleanup(): void {
  if (installedSignalHandlers) {
    for (const { signal, handler } of installedSignalHandlers) process.removeListener(signal, handler)
    installedSignalHandlers = null
  }
  if (installedExitHandler) {
    process.removeListener('exit', installedExitHandler)
    installedExitHandler = null
  }
}

/**
 * 安装进程级收尾:SIGINT / SIGTERM / SIGHUP + 正常 exit。
 *
 * 幂等(插件 reload 会重复 apply,先摘旧的再装,不叠加处理器)。
 *
 * 信号处理器自己摘掉再原样补发该信号:宿主若另装了处理器就交给它,否则回到默认
 * 终止,退出码与不接管时一致(128+n)—— 接管收尾不改变宿主对 Ctrl-C 的可观测行为。
 *
 * @returns 仅摘除本次安装的处理器
 */
export function installProcessCleanup(hooks: ProcessCleanupHooks = {}): () => void {
  const teardown = hooks.teardown ?? ((): number => teardownLiveTerminals())
  const raise =
    hooks.raise ??
    ((signal: NodeJS.Signals): void => {
      process.kill(process.pid, signal)
    })

  uninstallProcessCleanup()

  const signalHandlers: { signal: NodeJS.Signals; handler: () => void }[] = []
  for (const signal of CLEANUP_SIGNALS) {
    const handler = (): void => {
      teardown()
      uninstallProcessCleanup()
      raise(signal)
    }
    try {
      process.on(signal, handler)
    } catch {
      continue // 平台不支持该信号:跳过,不影响其余钩子
    }
    signalHandlers.push({ signal, handler })
  }

  // 正常退出(进程自然结束 / 显式 process.exit)也收尾。
  const exitHandler = (): void => {
    teardown()
  }
  process.on('exit', exitHandler)

  installedSignalHandlers = signalHandlers
  installedExitHandler = exitHandler

  return (): void => {
    for (const { signal, handler } of signalHandlers) process.removeListener(signal, handler)
    process.removeListener('exit', exitHandler)
    if (installedSignalHandlers === signalHandlers) installedSignalHandlers = null
    if (installedExitHandler === exitHandler) installedExitHandler = null
  }
}

// ── 硬杀 / 崩溃后的残留回收(开机自检)────────────────────────────────────
//
// 信号钩子覆盖不了 SIGKILL、崩溃、断电 —— 那些路径上没有任何 JS 能执行。故每个
// 终端在创建/复用时打上属主标记(@agsh_owner = 宿主 pid),下次有 DSH 在同一
// socket 上起终端时,回收「属主已死」或「无标记且已过宽限期」的同类会话。
// 只动本插件命名的 agsh- 会话,绝不碰用户自己的 tmux 会话。

/** 打标记用的 tmux 会话级用户选项名。 */
const OWNER_OPTION = '@agsh_owner'

/** 无标记会话的宽限期:避免误杀正在并发创建终端的兄弟进程。 */
export const REAP_GRACE_MS = 60_000

/** tmux 一条会话的属主信息。 */
export interface TerminalOwnerInfo {
  session: string
  /** 属主宿主 pid;无标记/无法解析为 null。 */
  ownerPid: number | null
  /** 会话创建时刻(epoch 秒);无法解析为 null。 */
  createdEpoch: number | null
}

/** pid 是否存活(信号 0 探测;EPERM = 活着但不属本用户,按存活处理)。 */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e: any) {
    return e?.code === 'EPERM'
  }
}

/** 解析 `list-sessions -F '#{session_name}\t#{@agsh_owner}\t#{session_created}'`。 */
export function parseTerminalList(stdout: string): TerminalOwnerInfo[] {
  const out: TerminalOwnerInfo[] = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    const [session, owner, created] = line.split('\t')
    if (!session) continue
    const pid = Number.parseInt((owner ?? '').trim(), 10)
    const epoch = Number.parseInt((created ?? '').trim(), 10)
    out.push({
      session,
      ownerPid: Number.isFinite(pid) ? pid : null,
      createdEpoch: Number.isFinite(epoch) ? epoch : null,
    })
  }
  return out
}

/**
 * 从会话列表中挑出残留终端(纯函数)。判据:
 *  · 只认本插件的 agsh- 前缀;
 *  · 属主是本进程 ⇒ 在用,保留;
 *  · 有属主标记且属主已死 ⇒ 残留(宿主被硬杀,标记成为唯一遗言);
 *  · 无标记 ⇒ 只有熬过宽限期的才算残留(并发启动中的兄弟进程尚未来得及打标记)。
 */
export function selectOrphanTerminals(
  list: TerminalOwnerInfo[],
  selfPid: number,
  nowEpoch: number,
  graceMs: number = REAP_GRACE_MS,
  isAlive: (pid: number) => boolean = pidAlive,
): string[] {
  const out: string[] = []
  for (const it of list) {
    if (!it.session.startsWith('agsh-')) continue
    if (it.ownerPid === selfPid) continue
    if (it.ownerPid !== null) {
      if (!isAlive(it.ownerPid)) out.push(it.session)
      continue
    }
    if (it.createdEpoch !== null && nowEpoch - it.createdEpoch > Math.ceil(graceMs / 1000)) {
      out.push(it.session)
    }
  }
  return out
}

/**
 * 认领终端:打属主标记 + 让本 socket 的 server 在最后一个会话消失时自退。
 *
 * 两件事共一次往返,因为都是「这个终端/server 归本插件管」的登记:
 *  · `@agsh_owner`:宿主被硬杀后唯一能指认「这个终端已无主」的遗言(回收用);
 *  · `exit-empty on`:tmux 真实默认是 on,但本机 ~/.tmux.conf 设成了 off,插件
 *    的 server 会继承 —— 于是会话杀光后 server 常驻 + socket 文件残留。这里按
 *    【本 socket】改回 on(server 级选项,只影响插件自己的 socket,不动用户的 tmux)。
 *
 * 失败不影响主流程:终端照常可用,只是回收/自退少一层保障。
 */
async function tagTerminalOwner(ctx: Context, cwd: string, t: TmuxRef): Promise<void> {
  try {
    await runSh(
      ctx,
      cwd,
      `tmux -S ${sq(t.socket)} set-option -t ${sq(t.session)} ${OWNER_OPTION} ${process.pid} 2>/dev/null; ` +
        `tmux -S ${sq(t.socket)} set-option -s exit-empty on 2>/dev/null; true`,
      { timeoutMs: 10000 },
    )
  } catch {
    /* 登记失败:终端照常可用,仅下轮回收/自退可能漏掉它 */
  }
}

/** 回收的可注入点(测试用)。 */
export interface ReapOptions {
  /** 这些会话名一律保留(本进程正在用的终端)。 */
  keep?: Set<string>
  /** 判定「现在」的 epoch 秒。 */
  nowEpoch?: number
  /** 活跃性探测。 */
  isAlive?: (pid: number) => boolean
  /** 销毁动作,默认同步 tmux kill-session。 */
  kill?: (t: TmuxRef) => void
}

/** 回收同一 socket 上属主已死的残留终端,返回回收个数。 */
export async function reapOrphanTerminals(
  ctx: Context,
  cwd: string,
  socket: string,
  opts: ReapOptions = {},
): Promise<number> {
  const { keep = new Set<string>(), nowEpoch = Math.floor(Date.now() / 1000) } = opts
  const isAlive = opts.isAlive ?? pidAlive
  const kill = opts.kill ?? killTerminalSync

  let list: TerminalOwnerInfo[]
  try {
    const r = await runSh(
      ctx,
      cwd,
      `tmux -S ${sq(socket)} list-sessions -F '#{session_name}\t#{@agsh_owner}\t#{session_created}' 2>/dev/null; true`,
      { timeoutMs: 10000 },
    )
    list = parseTerminalList(r.stdout)
  } catch {
    return 0
  }
  const orphans = selectOrphanTerminals(list, process.pid, nowEpoch, REAP_GRACE_MS, isAlive).filter(
    (s) => !keep.has(s),
  )
  for (const session of orphans) {
    kill({ socket, session })
    console.error(`[agsh] reaped orphan terminal ${session} (owner gone)`)
  }
  return orphans.length
}

/** 每个 socket 只自检一次:回收不该挂在每条 shell 命令的执行路径上。 */
const reapedSockets = new Set<string>()

async function reapOnce(ctx: Context, cwd: string, t: TmuxRef): Promise<void> {
  if (reapedSockets.has(t.socket)) return
  reapedSockets.add(t.socket)
  const keep = new Set<string>([t.session])
  for (const key of liveTerminals) {
    const i = key.indexOf('\u0000')
    if (key.slice(0, i) === t.socket) keep.add(key.slice(i + 1))
  }
  try {
    await reapOrphanTerminals(ctx, cwd, t.socket, { keep })
  } catch {
    /* 回收是尽力而为:失败不影响终端可用性 */
  }
}

export async function ensureTerminal(
  ctx: Context,
  cwd: string,
  agentRoot: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<TmuxRef> {
  const tmpDir = join(cwd, '.agsh', 'tmp')
  mkdirSync(tmpDir, { recursive: true })
  const t: TmuxRef = terminalRef(cwd, sessionId)
  if (await tmuxHas(ctx, cwd, t)) {
    liveTerminals.add(terminalKey(t))
    // 复用既有终端:补打属主标记(旧版本创建的终端没有标记),再做一次残留自检。
    await tagTerminalOwner(ctx, cwd, t)
    await reapOnce(ctx, cwd, t)
    return t
  }

  // 首次启动:zsh -i → AGENT_HEADLESS → source agent.zsh
  const created = await runSh(
    ctx,
    cwd,
    `tmux -S ${sq(t.socket)} new-session -d -s ${sq(t.session)} -c ${sq(cwd)} 'zsh -i'`,
    { timeoutMs: 15000, signal },
  )
  if (created.exitCode !== 0) throw new Error(`tmux new-session failed: ${created.stderr}`)
  liveTerminals.add(terminalKey(t))
  // 出生即打属主标记:这是宿主被 SIGKILL 后唯一能指认「这个终端已无主」的遗言。
  await tagTerminalOwner(ctx, cwd, t)
  await ctx.timer.timeout(800)
  await tmuxSend(ctx, cwd, t, 'export AGENT_HEADLESS=1', signal)
  await ctx.timer.timeout(300)
  await tmuxSend(ctx, cwd, t, `source ${sq(join(agentRoot, 'agent.zsh'))}`, signal)

  // 等 prompt([none] 前缀)出现
  const deadline = Date.now() + 60000
  let ready = false
  for (;;) {
    if (signal?.aborted) throw new Error('aborted')
    await ctx.timer.timeout(1000)
    const cap = await runSh(ctx, cwd, `tmux -S ${sq(t.socket)} capture-pane -p -t ${sq(t.session)} 2>/dev/null`, {
      timeoutMs: 10000,
    })
    if (cap.stdout.includes('[none]')) {
      ready = true
      break
    }
    if (Date.now() > deadline) break
  }

  // ── 终端死亡重建后自动 re-claim 上次凭证(2026-08-18 MC 事故的确定性预防)──
  // 仅重建分支执行:tmuxHas 命中(会话仍在,含 drop 后的 [none] 提示符)绝不自动
  // claim,防止复活已释放的凭证。锁冲突时 claim 被 CLI 4 层校验 Layer5 挡下
  // ("credential locked"),读回 !== prev 仅告警、终端保持无凭证,不阻塞原行为。
  if (ready) {
    const prev = lastCred.get(sessionId)
    if (prev) {
      try {
        await tmuxSend(ctx, cwd, t, `credential claim ${sq(prev)}`, signal)
        // 按键同队列顺序执行,printf 在 claim 完成后才写文件,读到的即 claim 后真实状态。
        const after = await readCredential(ctx, cwd, t, signal)
        if (after === prev) {
          console.error(`[agsh] ensureTerminal: 重建终端已自动 re-claim ${prev}`)
        } else {
          console.error(
            `[agsh] ensureTerminal: re-claim ${prev} 未生效(读回 ${JSON.stringify(after)};可能被其他会话锁挡下),终端保持无凭证`,
          )
        }
      } catch (e: any) {
        console.error(`[agsh] ensureTerminal: re-claim 失败: ${e?.message ?? String(e)}`)
      }
    }
  }
  // 终端就绪后做一次残留自检:回收被硬杀的宿主留下的同类终端(本 socket 仅一次)。
  await reapOnce(ctx, cwd, t)
  return t
}

/** 读 CREDENTIAL:持续终端当前 env(纯 env 读取;权威在 agent.zsh 的 CREDENTIAL 变量)。
 *  返回 null = 读取失败(8s 超时,或空文件持续 >1.2s 判为真空凭证),与真实值不再混同;
 *  调用方必须区分「失败」与「凭证为空」。 */
async function readCredential(ctx: Context, cwd: string, t: TmuxRef, signal?: AbortSignal): Promise<string | null> {
  const tmpDir = join(cwd, '.agsh', 'tmp')
  const file = join(tmpDir, `agsh_cred_${Date.now()}_${counter++}.txt`)
  try {
    await tmuxSend(ctx, cwd, t, `printf '%s' "${'${CREDENTIAL:-}'}" > ${sq(file)}`, signal)
  } catch (e) {
    // 终端被占用(门禁一/二):读不到凭证,按本函数的契约返回 null(读取失败)。
    // 调用方随后执行命令时会在 execInTerminal 拿到同一判定并给出诚实错误。
    if (e instanceof TerminalBusyError) return null
    throw e
  }
  const deadline = Date.now() + 8000
  let emptySince = 0
  for (;;) {
    const v = safeRead(file)
    if (v !== '') {
      try {
        rmSync(file)
      } catch {
        /* ignore */
      }
      return v.trim()
    }
    if (existsSync(file)) {
      // 文件已存在但为空:shell 重定向先建空文件、后写内容,竞态窗口微秒级;
      // 因此「空」不立即判失败,而是继续等。持续为空 >1.2s 视为真空凭证
      // (真实 credential drop 后 CREDENTIAL 为空),提前返回 null,不干等 8s。
      if (!emptySince) emptySince = Date.now()
      if (Date.now() - emptySince > 1200) {
        try {
          rmSync(file)
        } catch {
          /* ignore */
        }
        return null
      }
    } else {
      emptySince = 0
    }
    if (Date.now() >= deadline) {
      try {
        rmSync(file)
      } catch {
        /* ignore */
      }
      return null
    }
    await ctx.timer.timeout(300)
  }
}

/** 交叉验证凭证是否仍绑定:节点 .lock 由 agent.zsh credential claim 写入(内容为申领它的
 *  zsh PID),credential drop 删除。锁在且 PID 存活 = 凭证仍在,读凭证失败是误报。 */
async function credentialBound(cwd: string, cred: string): Promise<boolean> {
  const lockFile = join(cwd, '.agsh', 'nodes', cred, '.lock')
  const raw = safeRead(lockFile).trim()
  if (!raw) return false
  const pid = Number(raw)
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 在持续终端执行一条命令(注入协议,History 即同步通道):
 *  单行注入:export 捕获变量(cred 快照在 source 前取到)→ 行内装 tee →
 *  source cmdfile → 行内恢复 fd。终端 precmd 尾调(与原生同一代码路径)
 *  把工具结果写进节点 history;DSH 轮询 history 里该 callId 的 tool 消息,
 *  终端写什么就取什么,无 status/done 工件协议。 */
async function execInTerminal(
  ctx: Context,
  cwd: string,
  t: TmuxRef,
  cred: string,
  cmd: string,
  callId: string,
  signal?: AbortSignal,
): Promise<string> {
  const tmpDir = join(cwd, '.agsh', 'tmp')
  const tag = `${Date.now()}_${counter++}`
  const cmdfile = join(tmpDir, `agsh_cmd_${tag}.zsh`)
  const artifactDir = join(tmpDir, `agsh_inj_${tag}`)
  mkdirSync(artifactDir, { recursive: true })
  writeFileSync(cmdfile, cmd, 'utf-8')
  const histFile = join(cwd, '.agsh', 'nodes', cred, 'history')
  const initialSize = existsSync(histFile) ? statSync(histFile).size : 0
  // 行内装 tee:fd 3/4 由本行自己保存,preexec(行执行前触发)看不到捕获变量
  // 不做任何事;尾调的 exec >&3 2>&4 因此永远拿到有效 fd,claim 等任意命令
  // 都不会出现 bad file descriptor 崩溃。
  const line =
    `export _AGENT_CAPTURE=1 _AGENT_ARTIFACT_DIR=${sq(artifactDir)} _AGENT_EXEC_TOOL_ID=${sq(callId)} ` +
    `_AGENT_CAPTURE_CRED_BEFORE=${sq(cred)}; ` +
    `exec 3>&1 4>&2; exec > >(tee ${sq(join(artifactDir, 'output'))}) 2>&1; ` +
    `source ${sq(cmdfile)}; exec >&3 2>&4`
  try {
    await tmuxSend(ctx, cwd, t, line, signal)
  } catch (e) {
    try {
      rmSync(artifactDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    try {
      rmSync(cmdfile)
    } catch {
      /* ignore */
    }
    if (e instanceof TerminalBusyError) {
      // 门禁一/二拦下:命令从未执行(注入行被前台进程吃掉),不空转 120s。
      await recoverTerminal(ctx, cwd, t, e.foreground || 'unknown')
      return terminalBusyMessage(e.foreground)
    }
    throw e
  }

  const result = await waitHistoryTool(ctx, histFile, callId, initialSize, 120000, signal)
  try {
    rmSync(artifactDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  try {
    rmSync(cmdfile)
  } catch {
    /* ignore */
  }
  if (result) return result
  // 超时/中止:门禁三恢复(C-c,必要时按 AGSH_TERMINAL_ESCALATE 重建终端);
  // zsh 仍会走尾调,把部分输出写进 history 后再取一次。
  await recoverTerminal(ctx, cwd, t, 'history poll timed out')
  const partial = await waitHistoryTool(ctx, histFile, callId, initialSize, 15000, signal)
  return partial || `Timed out after 120s`
}

/** 轮询节点 history:等待并取出该 callId 的 tool 消息(终端尾调写入) */
async function waitHistoryTool(
  ctx: Context,
  histFile: string,
  callId: string,
  initialSize: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (signal?.aborted) return ''
    const raw = safeRead(histFile)
    // 字节对字节:raw.length 是 UTF-16 字符数,中文内容(3 字节/字)下永远
    // 小于 initialSize(字节数),闸门会永不开 → 全部打满超时。
    if (Buffer.byteLength(raw, 'utf-8') > initialSize) {
      for (const line of raw.split('\n').reverse()) {
        const t = line.trim()
        if (!t) continue
        try {
          const arr = JSON.parse(t)
          for (const m of arr) {
            if (m?.role === 'tool' && m.tool_call_id === callId) return String(m.content ?? '')
          }
        } catch {
          /* ignore */
        }
      }
    }
    if (Date.now() >= deadline) return ''
    await ctx.timer.timeout(300)
  }
}

// ── agsh CLI ─────────────────────────────────────────────────────────────

async function contextBuild(ctx: Context, cwd: string, agentRoot: string, target: string, signal?: AbortSignal): Promise<any[]> {
  const tmpDir = join(cwd, '.agsh', 'tmp')
  const out = join(tmpDir, `agsh_ctx_${Date.now()}_${counter++}.json`)
  const r = await runSh(
    ctx,
    cwd,
    `bun run ${sq(join(agentRoot, 'src', 'cli.ts'))} context build --cred ${sq(target)} > ${sq(out)} 2>&1`,
    { timeoutMs: 60000, signal, env: { AGENT_NODES_PATH: join(cwd, '.agsh', 'nodes') } },
  )
  const content = safeRead(out)
  try {
    rmSync(out)
  } catch {
    /* ignore */
  }
  if (r.exitCode !== 0) throw new Error(`agsh context build failed: ${content.slice(-500)}`)
  try {
    const parsed = JSON.parse(content)
    if (!Array.isArray(parsed)) throw new Error('not an array')
    return parsed
  } catch {
    throw new Error(`agsh context build: invalid output: ${content.slice(-300)}`)
  }
}

async function ensureNodes(ctx: Context, cwd: string, agentRoot: string, signal?: AbortSignal): Promise<void> {
  if (existsSync(join(cwd, '.agsh', 'nodes', 'root'))) return
  await runSh(ctx, cwd, `bun run ${sq(join(agentRoot, 'src', 'cli.ts'))} init`, {
    timeoutMs: 60000,
    signal,
    env: { AGENT_NODES_PATH: join(cwd, '.agsh', 'nodes') },
  })
}

// ── 会话专属节点(首句自动落点;不污染 root;多会话隔离)──────────────────

/** DSH 会话 → 专属节点 id(与终端命名一致) */
function sessionNodeId(sessionId: string): string {
  const s = String(sessionId ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(-40)
  return s ? `agsh-${s}` : ''
}

/**
 * 确保会话专属节点存在并 claim(终端 CREDENTIAL 落到该节点)。
 * 仅在首句落点(无上一节点)时调用;drop 后新消息回到上一节点,中途不自动 claim。
 */
async function ensureSessionNode(
  ctx: Context,
  cwd: string,
  agentRoot: string,
  sessionId: string,
  t: TmuxRef,
  signal?: AbortSignal,
): Promise<string> {
  const id = sessionNodeId(sessionId)
  if (!id) return 'root'
  const nodesPath = join(cwd, '.agsh', 'nodes')
  if (!existsSync(join(nodesPath, id))) {
    const note =
      `DSH 会话 ${sessionId} 专属节点:首句自动落点,parent=root,隔离多会话。\n` +
      `\n` +
      `传递语义(重要):前缀链只携带链上各节点的 context 文件;本节点的 history——` +
      `包括用户的原始指令——不会随链传递到下一个节点。claim 到工作节点后,` +
      `那个节点看不到本节点的对话记录,任务要求必须由你写进新节点的 context(Todo)` +
      `才会继续生效。本节点的 context 本身会作为祖先随链传递。`
    const r = await runSh(
      ctx,
      cwd,
      `bun run ${sq(join(agentRoot, 'src', 'cli.ts'))} node create --parent root --id ${sq(id)} --context ${sq(note)}`,
      { timeoutMs: 60000, signal, env: { AGENT_NODES_PATH: nodesPath } },
    )
    if (r.exitCode !== 0) throw new Error(`agsh auto-node create failed: ${r.stderr || r.stdout}`)
  }
  // claim 凭证到该节点(节点已存在,4 层校验必过)
  await tmuxSend(ctx, cwd, t, `credential claim ${sq(id)}`, signal)
  // 校验 claim 是否真正生效(节点可能被其他会话终端锁住)
  const after = await readCredential(ctx, cwd, t, signal)
  if (!after) {
    console.error(`[agsh] ensureSessionNode: claim ${id} did not take effect (locked or failed)`)
  }
  return id
}

// ── llm/stream 短路:循环主请求 → agsh 上下文 one-shot ──────────────────

/** DSH 嵌入模式说明:回合以最终文字回复结束,不需要每轮 credential drop;
 *  凭证绑定跨轮保留,下一轮在同一节点继续;切换节点用 claim(自动释放旧绑定)。
 *  执行 credential drop 则本节点段立即结束,本轮不再执行命令。 */
const DSH_NOTE =
  'DSH embed mode: a turn ends when you produce your final text reply — you do not need to drop between turns. ' +
  'Your credential binding persists across turns; the next turn continues at the same node. ' +
  'To move work to another node, use `credential claim <name>` (it auto-releases the current binding). ' +
  'If you do `credential drop`, the node segment ends immediately: no further commands will execute until the next user message, ' +
  'which returns to this node and continues here.'

// ── 实时放行 + 漂移就地改写 + step 级重试 ────────────────────────────────
// 定案(2026-09-15):重试不再在流内重发。
//   流内重发必须先把整次调用的全部 chunk 攥在手里才能决定丢不丢,代价是思维链被
//   压到流末尾一次性倾泻(UI 全程静默)。实测同一 provider/模型:agsh 会话每块间隔
//   0.03ms、整段思维链 28ms 内到齐;标准预设 78ms/块、铺开 10 秒。
//   改为:内层调用实时放行;需要重发时把本次尝试以 error 收尾,交给 DSH 原生
//   step 重试通道(agent/request-error → 重跑本 step)。前端只认 llm/retry 事件擦掉
//   本 step 已流出的内容(resetForRetry),故重试记录由本插件按 dsh-llm-retry 的
//   持久化契约写入(见 appendRetryRecords)。
//
// 三类处置:
//   drift(参数名漂移,如把 cmd 写成 command) ⇒ block-end 参数就地改写,不重发;
//   invalid(非法 JSON / 无有效值)            ⇒ error 收尾 + step 级重试(预算内);
//   finish.kind === 'error'                  ⇒ 原样放行,交给 DSH 原生 dsh-llm-retry。
// 预算 AGSH_API_RETRY_MAX(含首次,默认 2 ⇒ 每用户回合最多重发 1 次),按会话记、
// 新用户消息清零;耗尽后不再合成 error,坏参数原样走到工具边界(工具报错 → 模型
// 下一步自纠),回合不会因为"重试用完"而失败。
//
// 分类规格镜像 agsh-stdlib/api-retry-core.ts(仅指针,无跨仓 import);该 core 供
// 标准模式的 api-retry.ts 适配器使用,与本插件各自独立。
//
// 安全边界:失败尝试一律不写节点 history(见 agshStream 的 substituted 分支),
// 命令执行发生在流成功结束之后 ⇒ 重发时命令未执行、history 未写 = 幂等/安全。

interface GuardSpec {
  tool: string
  required: string
  aliases: string[]
}

/** shell 工具的唯一规格:参数名 cmd,模型偶尔漂移成 command */
export const SHELL_GUARD_SPEC: GuardSpec = { tool: 'shell', required: 'cmd', aliases: ['command'] }

/** 分类结果:合规 / 漂移(可用别名救回)/ 非法(不可救)/ 非本工具 */
export type ToolCallClass = 'ok' | 'drift' | 'invalid' | 'not-shell'

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== ''
}

/** rawArgs 可为 JSON 字符串或已解析对象;解析失败 / 非普通对象 ⇒ undefined */
function parseArgs(rawArgs: unknown): Record<string, unknown> | undefined {
  let obj: unknown = rawArgs
  if (typeof rawArgs === 'string') {
    try {
      obj = JSON.parse(rawArgs)
    } catch {
      return undefined
    }
  }
  return isPlainObject(obj) ? obj : undefined
}

/**
 * 分类一次 tool-call 的 arguments。
 * - toolName !== spec.tool                       ⇒ 'not-shell'
 * - required 键为非空字符串(trim 后)            ⇒ 'ok'
 * - aliases 里首个非空字符串值可作 required      ⇒ 'drift'(可由调用方归一化)
 * - 其余(非法 JSON / 非普通对象 / 无有效值)      ⇒ 'invalid'
 */
export function classifyToolCall(
  rawArgs: unknown,
  toolName: string,
  spec: GuardSpec = SHELL_GUARD_SPEC,
): ToolCallClass {
  if (toolName !== spec.tool) return 'not-shell'
  const obj = parseArgs(rawArgs)
  if (obj === undefined) return 'invalid'
  if (nonEmptyString(obj[spec.required])) return 'ok'
  for (const alias of spec.aliases) {
    if (nonEmptyString(obj[alias])) return 'drift'
  }
  return 'invalid'
}

/**
 * 重试预算(含首次):读 AGSH_API_RETRY_MAX,默认 2,非法值回落 2。
 * 下限 1(0 / 负数 / 非整数 / 非数字 ⇒ 2)。默认 2 ⇒ 内容级重试最多 1 次。
 * 命名空间归属本桥插件(标准库用 STDLIB_API_RETRY_MAX)。
 */
export function retryBudget(env: Record<string, string | undefined> = {}): number {
  const raw = env['AGSH_API_RETRY_MAX']
  if (raw === undefined || raw === null) return 2
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return 2
  return n
}

// 单次尝试内可能观察到多个 classification,取「最坏」者驱动决策。
// ok / not-shell = 无需干预;drift = 参数漂移;invalid = 不可救 / 瞬时错误。
const SEVERITY: Record<ToolCallClass, number> = { ok: 0, 'not-shell': 0, drift: 1, invalid: 2 }

function worstKind(a: ToolCallClass, b: ToolCallClass): ToolCallClass {
  return SEVERITY[b] > SEVERITY[a] ? b : a
}

/** 测试/门禁用:该 options 是否为桥自身发起的内层请求(已记入 SELF_INNER_REQUESTS)。 */
export function isSelfInnerRequest(options: any): boolean {
  return SELF_INNER_REQUESTS.has(options)
}

const RETRY_LOG_PREFIX = '[agsh]'

// ── 实时放行(收尾判定)───────────────────────────────────────────────────

/** 内容级不可用的失败码:参数非法 JSON / 无有效值时由本插件合成 error 收尾,
 *  agent/request-error 按它认领并请求 DSH 重跑本 step。 */
export const AGSH_TOOLCALL_RETRY_CODE = 'AGSH_TOOLCALL'

/** 本插件写入 llm/retry 时使用的 policyKey —— 与 provider 自身策略各记各的账。 */
export const AGSH_RETRY_POLICY_KEY = 'agsh-toolcall'

/** 汇总一次尝试里全部 tool-call 的分类,取最坏者。drift 已在 repairDriftChunk
 *  就地救回,故这里只会剩 ok / not-shell / invalid。 */
function classifyAttempt(blocks: any[]): ToolCallClass {
  let kind: ToolCallClass = 'ok'
  for (const b of blocks) {
    if (b?.type !== 'tool-call') continue
    kind = worstKind(kind, classifyToolCall(b.arguments, String(b.name ?? ''), SHELL_GUARD_SPEC))
  }
  return kind
}

/** 本次尝试是否值得重发:参数不可用,且不是 max-tokens 截断(截断重发只会再截断)。 */
export function shouldRetryAttempt(kind: ToolCallClass, finishReason: any): boolean {
  return kind === 'invalid' && finishReason?.kind !== 'max-tokens'
}

/**
 * 本次尝试是否该写进节点 history。
 *
 * 收尾块的真实形状是 `{ type: 'finish', reason: FinishReason }`(dsh-llm
 * types.d.ts:385-389)——**没有顶层 `kind`**,kind 在 `reason.kind` 里。写守卫时
 * 若误用 `finish.kind`,两处比较恒为 `undefined !== '…'` 即恒真,守卫退化成空操作,
 * 于是被传输中断(TRANSPORT / TIMEOUT)或 aborted 的**截断流**会被当成一次完整回复
 * 落盘 —— 模型只输出了一半,却被写进 history 当作它的完整输出。
 *
 * 故此处一律走 `finish.reason?.kind`。
 */
export function shouldWriteHistory(finish: any, substituted: boolean): boolean {
  return !substituted && !!finish && finish.reason?.kind !== 'error' && finish.reason?.kind !== 'aborted'
}

/**
 * drift 就地改写:tool-call 的 block-end 参数名漂移(如把 cmd 写成 command、
 * 且 cmd 为空串)时,把别名值写进规格键并删掉别名键。
 *
 * 改写对三处同时生效:本插件的 assembler、前端渲染、落库 history —— 三者都以
 * block-end 的 block 为准(dsh-llm 的 BlockAssembler 直接采用该 block,客户端
 * toAssistantBlock 亦然);dsh-llm 的流 invariant 只校验语法(索引 / 块类型 /
 * 顺序),不校验 block-end 与 tool-call-delta 是否逐字一致,故改写安全。
 */
export function repairDriftChunk(chunk: any): any {
  if (chunk?.type !== 'block-end' || chunk?.block?.type !== 'tool-call') return chunk
  const block = chunk.block
  if (classifyToolCall(block.arguments, String(block.name ?? ''), SHELL_GUARD_SPEC) !== 'drift') return chunk
  const obj = parseArgs(block.arguments)
  if (obj === undefined) return chunk
  let value: string | undefined
  for (const alias of SHELL_GUARD_SPEC.aliases) {
    if (nonEmptyString(obj[alias])) {
      value = obj[alias] as string
      break
    }
  }
  if (value === undefined) return chunk
  const repaired: Record<string, unknown> = { ...obj, [SHELL_GUARD_SPEC.required]: value }
  for (const alias of SHELL_GUARD_SPEC.aliases) delete repaired[alias]
  console.error(
    `${RETRY_LOG_PREFIX} shell tool-call drifted (${SHELL_GUARD_SPEC.aliases.join('/')} → ${SHELL_GUARD_SPEC.required}); repaired in place`,
  )
  return { ...chunk, block: { ...block, arguments: JSON.stringify(repaired) } }
}

/** streamInner 的收尾结果。 */
export interface InnerStreamResult {
  assembler: BlockAssembler
  /** 放行给 DSH 的收尾块(可能是本插件合成的 error 收尾)。 */
  finish: any
  /** 是否由本插件合成 error 收尾(调用方据此跳过 history 写入)。 */
  substituted: boolean
}

/**
 * 内层调用实时放行:每个 chunk 收到即 yield —— 思维链 / 正文 / 工具调用都以模型
 * 生成速度到达 UI(DSH 收到即发 agent/assistant-stream 帧,前端逐块追加)。
 *
 * 唯一被扣住的是收尾块 finish:判定要看完整次尝试,而它在流的最末尾,扣它不影响
 * 任何实时性。收尾时若参数不可用(非法 JSON / 无有效值 / 块装不起来),不放行原
 * finish,改放一条合成的 error 收尾 —— 由 apply 里的 agent/request-error 走
 * step 级重试。流以 error 收尾时原样放行,交给 DSH 原生 dsh-llm-retry。
 *
 * allowContentRetry=false(预算耗尽)时**不合成**:坏参数原样放行到工具边界,
 * 由工具报错、模型下一步自纠 —— 与旧版「末次降级放行」同语义。合成必须在
 * 这里就按预算闸住:一旦合成 error,agent/request-error 拒绝重试就等于让回合
 * 以错误收场,那就把可自纠的坏参数升级成了失败。
 *
 * 返回 assembler(含收尾块)供调用方写 history。
 */
export async function* streamInner(
  ctx: any,
  innerOptions: any,
  opts: { allowContentRetry?: boolean } = {},
): AsyncGenerator<any, InnerStreamResult, void> {
  const allowContentRetry = opts.allowContentRetry !== false
  const assembler = new BlockAssembler()
  let finish: any
  for await (const chunk of ctx.llm.stream(innerOptions)) {
    if (chunk?.type === 'finish') {
      finish = chunk // 扣住:等流走完再决定放行原件还是合成 error
      continue
    }
    const out = repairDriftChunk(chunk)
    try {
      assembler.push(out)
    } catch {
      /* ignore malformed chunk */
    }
    yield out
  }
  let blocks: any[] = []
  let assembleFailed = false
  try {
    blocks = assembler.blocks()
  } catch {
    assembleFailed = true
  }
  const substituted =
    allowContentRetry &&
    !!finish &&
    finish.reason?.kind !== 'error' &&
    finish.reason?.kind !== 'aborted' &&
    (assembleFailed || shouldRetryAttempt(classifyAttempt(blocks), finish.reason))
  const outFinish = substituted
    ? {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: 'agsh: shell tool-call arguments were unusable (invalid JSON or no usable value)',
            code: AGSH_TOOLCALL_RETRY_CODE,
          },
        },
      }
    : finish
  if (outFinish) {
    try {
      assembler.push(outFinish)
    } catch {
      /* ignore malformed chunk */
    }
    yield outFinish
  }
  return { assembler, finish: outFinish, substituted }
}

// ── step 级重试(内容级不可用)─────────────────────────────────────────────
// 前端只认 llm/retry 事件来擦掉本 step 已流出的内容(resetForRetry);因此本插件
// 按 @deepseek-ai/dsh-llm-retry 的持久化契约写两条记录后,再请求重跑本 step:
//   llm/retry         排定的重试(delayMs = 0,本插件不等待)
//   llm/retry-started 等待完成、下一次尝试即将开始
// 字段逐条对齐该包的 invariant:turn/step 必须在开启中的 step、provider 必须等于
// 该 step 的路由、retry 序号按 provider + policyKey 递增、failure.message/code 非空。
// 任何一条被拒 ⇒ 放弃重试、原样放行错误(降级,不死循环)。

/** 每 step 的重试账本:`${sessionId}:${turn}:${step}` → 已重试次数与链路 id。
 *  llm/retry 的 retry 序号必须按 provider + policyKey 在**同一 turn+step 内**
 *  递增,故记录用的账按 step 记。 */
const retryLedger = new Map<string, { retry: number; retryId: string }>()

/** 每会话(每用户回合)已用掉的内容级重试次数 —— 决定还能不能再合成 error 收尾。
 *  agshStream 拿不到 turn/step(llm/stream 的 options 里没有),故预算按会话记、
 *  在写入新用户消息时清零:语义即「每个用户回合最多自动重发 budget-1 次」。 */
const turnRetries = new Map<string, number>()

function retryLedgerKey(sessionId: string, turn: unknown, step: unknown): string {
  return `${sessionId}:${String(turn)}:${String(step)}`
}

/** 清零某会话的重试账:新用户回合、会话结束时调用。 */
function clearRetryLedger(sessionId: string): void {
  const prefix = `${sessionId}:`
  for (const key of [...retryLedger.keys()]) if (key.startsWith(prefix)) retryLedger.delete(key)
  turnRetries.delete(sessionId)
}

/** 写入一次重试的持久化记录。返回 false = 宿主不支持,调用方降级放行。 */
export function appendRetryRecords(
  agent: any,
  payload: any,
  entry: { retry: number; retryId: string },
  maxRetries: number,
): boolean {
  const session = agent?.session
  if (!session || typeof session.append !== 'function') return false
  const raw = payload?.failure ?? {}
  const message =
    typeof raw.message === 'string' && raw.message ? raw.message : 'agsh inner attempt produced unusable output'
  const code = typeof raw.code === 'string' && raw.code ? raw.code : AGSH_TOOLCALL_RETRY_CODE
  session.append('llm/retry', {
    retryId: entry.retryId,
    turn: payload?.turn,
    step: payload?.step,
    provider: String(payload?.provider ?? ''),
    mode: 'normal',
    policyKey: AGSH_RETRY_POLICY_KEY,
    retry: entry.retry,
    maxRetries,
    delayMs: 0,
    failure: { message, code },
  })
  session.append('llm/retry-started', {
    retryId: entry.retryId,
    turn: payload?.turn,
    step: payload?.step,
    retry: entry.retry,
  })
  return true
}

/**
 * 内容级重试决策(纯逻辑,供 agent/request-error 使用):
 * 认领本插件的失败码,预算内 ⇒ 给出本次重试记录;否则 ⇒ null(调用方 next())。
 * budget 含首次(默认 2 ⇒ 最多重试 1 次)。
 */
export function decideStepRetry(
  payload: any,
  ledger: Map<string, { retry: number; retryId: string }>,
  budget: number,
  mintId: () => string,
): { retry: number; retryId: string } | null {
  if (payload?.failure?.code !== AGSH_TOOLCALL_RETRY_CODE) return null
  if (payload?.signal?.aborted) return null
  const sessionId = String(payload?.agent?.session?.id ?? '')
  if (!sessionId) return null
  const key = retryLedgerKey(sessionId, payload?.turn, payload?.step)
  const prev = ledger.get(key) ?? { retry: 0, retryId: mintId() }
  if (prev.retry + 1 >= budget) return null
  return { retry: prev.retry + 1, retryId: prev.retryId }
}


async function* agshStream(ctx: Context, options: any, cwd: string, agentRoot: string): AsyncIterable<any> {
  const nodesPath = join(cwd, '.agsh', 'nodes')
  const sid = String(options.sessionId ?? '')
  try {
    await ensureNodes(ctx, cwd, agentRoot, options.signal)
    const t = await ensureTerminal(ctx, cwd, agentRoot, sid, options.signal)
    // 目标跟随终端真实凭证;drop 后(空)沿用上一节点,不自动 claim。
    const cred = await readCredential(ctx, cwd, t, options.signal)
    const target = cred || lastCred.get(sid) || sessionNodeId(sid) || 'root'
    stepNode.set(sid, target)
    if (cred) lastCred.set(sid, cred)
    const wire = await contextBuild(ctx, cwd, agentRoot, target, options.signal)
    // 过滤框架注入的 <recover> 违规提示:原生意为"纯文本 assistant = 违规",
    // 但 DSH 回合模型下纯文本回复是回合的正常终点;不滤则每轮结束后下一轮
    // 上下文都指控模型违规,且会在 history 里累积误导模型。
    // 注意:不按 role 过滤 —— 内核侧该消息的 role 已从 system 改为 user,
    // 按内容前缀 <recover> 识别,避免内核调整角色后过滤器失配。
    const modelWire = wire.filter(
      (m: any) => !(typeof m?.content === 'string' && m.content.startsWith('<recover>')),
    )

    // 节点链(AgentShell 原生发成多条 system)与嵌入说明合并成**一条**前导 system:
    // DSH 只认一条,其余每条 system 都会被折成 user 轮,节点 context 就整体降级了。
    const chain = modelWire.filter((m: any) => m.role === 'system').map((m: any) => String(m.content ?? ''))
    const rest = modelWire.filter((m: any) => m.role !== 'system')

    const innerOptions: any = {
      provider: options.provider,
      model: options.model,
      ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
      messages: fromWire([{ role: 'system', content: [DSH_NOTE, ...chain].join('\n\n') }, ...rest], options.provider, options.model),
      tools: [SHELL_TOOL_SCHEMA],
      signal: options.signal,
      sessionId: options.sessionId,
      purpose: 'agsh-inner',
    }
    // 双保险:本地 WeakSet 标记(门禁三分判定最优先放行)+ purpose 字段
    // (即使漏 mark,shape 谓词的 purpose===undefined 条件也不会误吞)。
    SELF_INNER_REQUESTS.add(innerOptions)

    // 实时放行:每个 chunk 收到即 yield;判定所需的收尾块被扣到最后(见 streamInner)。
    // 预算闸放在合成之前:回合内重试已用完时不再合成 error 收尾,让坏参数原样走到
    // 工具边界(工具报错 → 模型下一步自纠),而不是把回合拖成失败。
    const allowContentRetry = (turnRetries.get(sid) ?? 0) < retryBudget(process.env) - 1
    const inner = streamInner(ctx, innerOptions, { allowContentRetry })
    let step = await inner.next()
    while (!step.done) {
      yield step.value
      step = await inner.next()
    }
    const { assembler, finish, substituted } = step.value
    // substituted = 本次尝试内容不可用,已改放 error 收尾 ⇒ 交给 apply 里的
    // agent/request-error 走 step 级重试;不写 history(失败尝试不留痕)。
    // 判定走 shouldWriteHistory —— 收尾块无顶层 kind,必须看 finish.reason.kind。
    if (shouldWriteHistory(finish, substituted)) {
      // assistant 消息(wire 格式)由 DSH 侧写入目标节点 history
      appendHistory(nodesPath, target, [toWireAssistant(assembler.blocks())])
    }
  } catch (e: any) {
    console.error(`[agsh] ${e?.message ?? String(e)}`)
    yield {
      type: 'finish',
      reason: { kind: 'error', failure: { message: String(e?.message ?? e), code: 'UNKNOWN' } },
    }
  }
}

// ── 插件 ─────────────────────────────────────────────────────────────────

/** 每会话最近一次非空凭证(供 drop 后沿用目标节点;终端死亡重建时由 ensureTerminal 自动 re-claim) */
const lastCred = new Map<string, string>()
/** 每会话当前 step 的节点 = 本轮 assistant 消息所在节点(agshStream 写入 target 时登记)。
 *  本 step 的全部 tool 结果与 assistant 消息强制同节点:step 中途 claim 只在下一步生效。
 *  与 lastCred 同生命周期,键为 sessionId。 */
const stepNode = new Map<string, string>()

/** 节点段结束态:模型执行 credential drop 后置位,本轮 shell 拒绝执行;
 *  下一条用户消息清除(开启新节点段)。原生靠 precmd 停 loop,DSH 由插件中介。 */
const segmentEnded = new Map<string, boolean>()

export function apply(ctx: Context) {
  // 1. 唯一模型工具:shell(指向持续终端)。
  //    执行走注入协议,工具结果 history 由终端 precmd 尾调
  //    (_record_tool_result,_cred_before 按命令捕获)写入,插件零写入。
  ctx.tools.register({
    ...SHELL_TOOL_SCHEMA,
    output: {
      schema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] },
      render: (args: any, value: any) => [{ type: 'text', text: String(value?.content ?? '') }],
    },
    execute: async (args: any, exec: any) => {
      const agent = exec?.agent
      if (!isAgentShellSession(agent?.session))
        throw new Error('shell tool is only available to the agsh preset')
      const cwd = agent?.session?.header?.cwd
      const agentRoot = cwd && agentRootOf(cwd)
      if (!cwd || !agentRoot) throw new Error('agsh shell tool: no agent-shell workspace')
      const cmd = args?.cmd
      if (typeof cmd !== 'string' || !cmd.trim()) throw new Error('shell: cmd is required')
      const t = await ensureTerminal(ctx, cwd, agentRoot, String(agent.session.id), exec.signal)
      const sid = String(agent.session.id)
      // ── 段结束语义:本节点段已 credential drop,本轮不再执行任何命令 ──
      // (原生:drop 后 precmd 循环停机;DSH 循环归 DSH,由插件拦截同语义)
      if (segmentEnded.get(sid)) {
        return { content: '[节点段已结束] 本节点已 credential drop,本轮不再执行命令。请直接给出最终回复;下一条用户消息将回到本节点继续。' }
      }
      const beforeCred = stepNode.get(sid) ?? (await readCredential(ctx, cwd, t, exec.signal))
      // 执行前凭证 = 结果落点节点(尾调按 _cred_before 归属);也是轮询目标。
      // 读取失败(null)时命令仍执行,但结果无人记录,轮询会超时兜底。
      let content = ''
      try {
        content = await execInTerminal(ctx, cwd, t, beforeCred ?? '', cmd, String(exec.callId), exec.signal)
        let afterCred = await readCredential(ctx, cwd, t, exec.signal)
        // ── 检测 drop:命令释放了凭证 → 本节点段立即结束 ──
        // 空读 ≠ drop(读凭证有竞态/超时两种失败模式):先重试一次;仍为空则用
        // .lock/PID 交叉验证(真实 drop 会删锁)。凭证仍绑定时不结束段,静默沿用。
        if (beforeCred && afterCred === null) {
          afterCred = await readCredential(ctx, cwd, t, exec.signal)
        }
        if (beforeCred && afterCred === null) {
          if (!(await credentialBound(cwd, beforeCred))) {
            segmentEnded.set(sid, true)
            return { content: `${content}\n\n[节点段已结束] 凭证已释放(${beforeCred})。请直接给出最终回复;下一条用户消息将回到本节点继续。` }
          }
        }
        return { content }
      } catch (e: any) {
        content = `Error: ${e?.message ?? String(e)}`
        throw e
      } finally {
        // ── 健康补全(DSH 层) ──
        // 本次调用在节点 history 里没有留下 tool 结果时,补一条配对结果。
        // 终端死亡 / 超时 / 任何异常都会走到这里 → 不再产生孤儿 assistant(tool_calls),
        // 后续回合也就不会再被 API 以 400 insufficient tool messages 卡死。
        // 幂等:正常路径下结果已由终端 precmd 尾调写入,这里什么都不做(仍是终端单写)。
        if (!historyHasToolResult(join(cwd, '.agsh', 'nodes'), beforeCred ?? '', String(exec.callId))) {
          appendHistory(join(cwd, '.agsh', 'nodes'), beforeCred ?? '', [
            {
              role: 'tool',
              tool_call_id: String(exec.callId),
              content: content || '[tool call produced no result]',
            },
          ])
        }
      }
    },
  })

  // 2. pre-step:user 消息 → 当前目标节点 history(无凭证时落到会话专属节点开新段)
  ctx.on('agent/pre-step', async (payload: any, next: any) => {
    const agent = payload?.agent
    if (!isAgentShellSession(agent?.session)) return next()
    const cwd = agent?.session?.header?.cwd
    const agentRoot = cwd && agentRootOf(cwd)
    if (!cwd || !agentRoot) return next()
    const userMsgs = (payload?.messages ?? []).filter((m: any) => m?.role === 'user')
    if (userMsgs.length === 0) return next()
    const texts = userMsgs.map(textOfMessage).filter(Boolean)
    if (texts.length === 0) return next()
    try {
      await ensureNodes(ctx, cwd, agentRoot, payload.signal)
      const t = await ensureTerminal(ctx, cwd, agentRoot, String(agent.session.id), payload.signal)
      const sid = String(agent.session.id)
      // 新用户消息 = 新节点段:清除 drop 结束态,重新进入可用状态
      segmentEnded.delete(sid)
      const cred = await readCredential(ctx, cwd, t, payload.signal)
      // 新用户消息落点:有凭证沿用;drop 后(凭证空)自然回到上一节点 claim 继续;
      // 仅首句(无上一节点)落到会话专属节点开新段
      let target = cred
      if (!target) {
        const prev = lastCred.get(sid)
        if (prev) {
          await tmuxSend(ctx, cwd, t, `credential claim ${sq(prev)}`, payload.signal)
          // 严格锁语义:claim 被其他会话的锁挡下时,绝不写/读该节点,回退本会话专属节点。
          // 按键同队列顺序执行,printf 在 claim 完成后才写文件,读到的即 claim 后真实状态。
          const after = await readCredential(ctx, cwd, t, payload.signal)
          if (after === prev) {
            target = prev
          } else {
            target = await ensureSessionNode(ctx, cwd, agentRoot, sid, t, payload.signal)
            lastCred.set(sid, target)
          }
        } else {
          target = await ensureSessionNode(ctx, cwd, agentRoot, sid, t, payload.signal)
        }
      }
      if (cred) lastCred.set(sid, cred)
      clearRetryLedger(sid) // 新用户回合:内容级重试预算与账本清零
      appendHistory(join(cwd, '.agsh', 'nodes'), target, [{ role: 'user', content: texts.join('\n') }])
    } catch (e: any) {
      console.error(`[agsh] pre-step: ${e?.message ?? String(e)}`)
    }
    return next()
  })

  // 3. llm/stream:短路接管循环主请求
  ctx.on('llm/stream', (options: any, next: any) => {
    if (SELF_INNER_REQUESTS.has(options)) return next()
    if (!isAgentLoopRequest(options) && !looksLikeAgentLoopRequest(options)) return next()
    const session = ctx.get('sessions')?.get(options.sessionId)
    if (!isAgentShellSession(session)) return next()
    const cwd = session?.header?.cwd
    const agentRoot = cwd && agentRootOf(cwd)
    if (!cwd || !agentRoot) return next()
    return agshStream(ctx, options, cwd, agentRoot)
  })

  // 4. 内容级重试:本插件合成的失败码 ⇒ 写重试记录 + 请求 DSH 重跑本 step。
  //    重跑由 DSH 原生循环执行(新 attempt、新一次 llm/stream ⇒ 本插件再接管,
  //    重发一次全新内层调用);前端收到 llm/retry 会擦掉失败尝试已流出的内容,
  //    所以"实时显示"与"重试"不再互相牺牲(流内重发做不到这一点)。
  //    只认本插件自己的失败码,不碰 provider 自身的错误重试(那是 dsh-llm-retry 的活)。
  //    预算闸与 agshStream 合成前的判定同源(每用户回合 budget-1 次):真到这里
  //    却已耗尽(理论上不可达)就放行,绝不让回合因为"重试用完"而失败。
  ctx.on('agent/request-error', async (payload: any, next: any) => {
    const budget = retryBudget(process.env)
    const sid = String(payload?.agent?.session?.id ?? '')
    if (sid && (turnRetries.get(sid) ?? 0) + 1 > budget - 1) return next()
    const entry = decideStepRetry(payload, retryLedger, budget, () => randomUUID())
    if (!entry) return next()
    try {
      if (!appendRetryRecords(payload?.agent, payload, entry, budget)) return next()
    } catch (e: any) {
      // 记录形状被拒(DSH 版本变更等):降级为放行错误,不死循环。
      console.error(`${RETRY_LOG_PREFIX} llm/retry record rejected (${e?.message ?? String(e)}); passing the failure through`)
      return next()
    }
    retryLedger.set(retryLedgerKey(sid, payload?.turn, payload?.step), entry)
    turnRetries.set(sid, (turnRetries.get(sid) ?? 0) + 1)
    console.error(
      `${RETRY_LOG_PREFIX} unusable shell tool-call output; re-running step ${payload?.turn}/${payload?.step} (retry ${entry.retry}/${budget - 1})`,
    )
    return { kind: 'retry' }
  })

  // 5. 会话生命周期收尾:会话 disposed(关闭/归档)时释放凭证 + 销毁持续终端。
  //
  //    为什么不是 session/end-seed(原实现的 bug):那个事件是【构造期 seed 边界
  //    标记】——只在恢复/fork 带 seed 构造时写入,且写入发生在 Session 构造期间,
  //    此时 session 尚未 attach,append() 的 entry 为 undefined ⇒ 【永不发布到
  //    session/event 火线】(上游注释:"constructor seeds do not emit")。所以原
  //    钩子是从不触发的死代码,终端因此永不销毁 = tmux 泄漏的真根因。
  //    语义也不对:end-seed 出现在会话【开启】(恢复/fork)时,不是在结束时。
  //
  //    真正的配对收尾事件是 session/disposed(session-store 在 detach 一个已
  //    announced 的会话时发出)。只用 announced 的会话发 ⇒ 创建回滚(从未 announce)
  //    不会误触发,不会在没起来的会话上做收尾。
  ctx.on('session/disposed', (session: any) => {
    if (!isAgentShellSession(session)) return
    const cwd = session?.header?.cwd
    const agentRoot = cwd && agentRootOf(cwd)
    if (!cwd || !agentRoot) return
    const sid = String(session.id)
    // 纯坐标 + 先探存在:绝不为「销毁」而先把终端创建出来。
    const t = terminalRef(cwd, sid)
    void (async () => {
      try {
        const had = await tmuxHas(ctx, cwd, t)
        let dropped = false
        if (had) {
          // 凭证释放是 best-effort:终端被占用时门禁会拒绝注入,但【销毁必须发生】,
          // 否则又回到泄漏。故 drop 失败不影响下面的 kill。
          try {
            await tmuxSend(ctx, cwd, t, 'credential drop', undefined)
            dropped = true
          } catch (e: any) {
            console.error(`[agsh] session ${sid}: credential drop skipped (${e?.message ?? String(e)})`)
          }
          await runSh(
            ctx,
            cwd,
            `tmux -S ${sq(t.socket)} kill-session -t ${sq(t.session)} 2>/dev/null; true`,
            { timeoutMs: 10000 },
          )
        }
        liveTerminals.delete(terminalKey(t))
        lastCred.delete(sid)
        stepNode.delete(sid)
        segmentEnded.delete(sid)
        clearRetryLedger(sid)
        console.error(
          `[agsh] session ${sid} disposed: terminal ${had ? 'torn down' : 'absent'}, ` +
            `credential ${dropped ? 'dropped' : 'not dropped'}`,
        )
      } catch (e: any) {
        console.error(`[agsh] session disposed cleanup: ${e?.message ?? String(e)}`)
      }
    })()
  })

  // 6. 收尾三层 —— 必须分别覆盖三条互不重叠的退出路径,少一层就漏:
  //    · session/disposed:单个会话被关闭/归档(见上);
  //    · 进程信号 + exit:整个 DSH 进程退出(Ctrl-C / SIGTERM / 关终端窗口)。
  //      这一层是 2026-09-25 补的:dsh 自身不处理信号,Node 的信号默认终止既不跑
  //      'exit' 也不跑 cordis dispose,故 session/disposed 与 ctx.effect 都不走
  //      —— Ctrl-C 关服务器后 tmux 常驻,正是这个洞(见 installProcessCleanup);
  //    · ctx.effect:插件 reload / fiber 卸载。
  //    剩余无法覆盖的只有 SIGKILL/崩溃,由 ensureTerminal 里的属主标记自检兜底。
  const uninstallCleanup = installProcessCleanup()
  ctx.effect(() => () => {
    uninstallCleanup()
    teardownLiveTerminals()
  })
}
