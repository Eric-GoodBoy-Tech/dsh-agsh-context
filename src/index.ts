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
import { readFileSync, existsSync, mkdirSync, appendFileSync, writeFileSync, rmSync, statSync } from 'node:fs'
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
// 语义镜像官方 resolveSessionPreset:最新 agent-preset/selected 事件胜出,
// 回退 session.header.agentPreset。session/header/events 缺失 → false。
export function isAgentShellSession(session: any): boolean {
  if (!session) return false
  const events = session.events
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
        const blocks: any[] = []
        if (m.content) blocks.push({ type: 'text', text: m.content })
        if (m.reasoning_content) blocks.push({ type: 'reasoning', text: m.reasoning_content })
        for (const tc of m.tool_calls ?? []) {
          blocks.push({ type: 'tool-call', id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments ?? '{}' })
        }
        return { id, role: 'assistant', content: blocks, source: { kind: 'model', provider, model } }
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
  if (fromEnv && existsSync(join(fromEnv, 'dist', 'cli.js'))) return fromEnv
  const rel = join(cwd, 'agent-shell')
  if (existsSync(join(rel, 'dist', 'cli.js'))) return rel
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

async function tmuxSend(ctx: Context, cwd: string, t: TmuxRef, text: string, signal?: AbortSignal): Promise<void> {
  const r = await runSh(ctx, cwd, `tmux -S ${sq(t.socket)} send-keys -t ${sq(t.session)} -- ${sq(text)} Enter`, {
    timeoutMs: 15000,
    signal,
  })
  if (r.exitCode !== 0) throw new Error(`tmux send-keys failed: ${r.stderr || r.stdout}`)
}

async function tmuxHas(ctx: Context, cwd: string, t: TmuxRef): Promise<boolean> {
  const r = await runSh(ctx, cwd, `tmux -S ${sq(t.socket)} has-session -t ${sq(t.session)} 2>/dev/null; echo "RC=$?"`, {
    timeoutMs: 10000,
  })
  return r.stdout.includes('RC=0')
}

async function ensureTerminal(
  ctx: Context,
  cwd: string,
  agentRoot: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<TmuxRef> {
  const tmpDir = join(cwd, '.agsh', 'tmp')
  mkdirSync(tmpDir, { recursive: true })
  const t: TmuxRef = {
    socket: join(tmpDir, 'dsh-tmux.sock'),
    session: 'agsh-' + String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_').slice(-40),
  }
  if (await tmuxHas(ctx, cwd, t)) return t

  // 首次启动:zsh -i → AGENT_HEADLESS → source agent.zsh
  const created = await runSh(
    ctx,
    cwd,
    `tmux -S ${sq(t.socket)} new-session -d -s ${sq(t.session)} -c ${sq(cwd)} 'zsh -i'`,
    { timeoutMs: 15000, signal },
  )
  if (created.exitCode !== 0) throw new Error(`tmux new-session failed: ${created.stderr}`)
  await ctx.timer.timeout(800)
  await tmuxSend(ctx, cwd, t, 'export AGENT_HEADLESS=1', signal)
  await ctx.timer.timeout(300)
  await tmuxSend(ctx, cwd, t, `source ${sq(join(agentRoot, 'agent.zsh'))}`, signal)

  // 等 prompt([none] 前缀)出现
  const deadline = Date.now() + 60000
  for (;;) {
    if (signal?.aborted) throw new Error('aborted')
    await ctx.timer.timeout(1000)
    const cap = await runSh(ctx, cwd, `tmux -S ${sq(t.socket)} capture-pane -p -t ${sq(t.session)} 2>/dev/null`, {
      timeoutMs: 10000,
    })
    if (cap.stdout.includes('[none]')) break
    if (Date.now() > deadline) break
  }
  return t
}

/** 读 CREDENTIAL:持续终端当前 env(纯 env 读取;权威在 agent.zsh 的 CREDENTIAL 变量) */
async function readCredential(ctx: Context, cwd: string, t: TmuxRef, signal?: AbortSignal): Promise<string> {
  const tmpDir = join(cwd, '.agsh', 'tmp')
  const file = join(tmpDir, `agsh_cred_${Date.now()}_${counter++}.txt`)
  await tmuxSend(ctx, cwd, t, `printf '%s' "${'${CREDENTIAL:-}'}" > ${sq(file)}`, signal)
  const deadline = Date.now() + 8000
  for (;;) {
    const v = safeRead(file)
    if (v !== '' || existsSync(file)) {
      try {
        rmSync(file)
      } catch {
        /* ignore */
      }
      return v.trim()
    }
    if (Date.now() >= deadline) {
      try {
        rmSync(file)
      } catch {
        /* ignore */
      }
      return ''
    }
    await ctx.timer.timeout(300)
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
    `_AGENT_CAPTURE_CRED_BEFORE="\${CREDENTIAL:-}"; ` +
    `exec 3>&1 4>&2; exec > >(tee ${sq(join(artifactDir, 'output'))}) 2>&1; ` +
    `source ${sq(cmdfile)}; exec >&3 2>&4`
  await tmuxSend(ctx, cwd, t, line, signal)

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
  // 超时/中止:发 Ctrl-C;zsh 仍会走尾调,把部分输出写进 history 后再取一次
  await runSh(ctx, cwd, `tmux -S ${sq(t.socket)} send-keys -t ${sq(t.session)} C-c`, { timeoutMs: 10000 })
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
    `bun run ${sq(join(agentRoot, 'dist', 'cli.js'))} context build --cred ${sq(target)} > ${sq(out)} 2>&1`,
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
  } catch (e) {
    throw new Error(`agsh context build: invalid output: ${content.slice(-300)}`)
  }
}

async function ensureNodes(ctx: Context, cwd: string, agentRoot: string, signal?: AbortSignal): Promise<void> {
  if (existsSync(join(cwd, '.agsh', 'nodes', 'root'))) return
  await runSh(ctx, cwd, `bun run ${sq(join(agentRoot, 'dist', 'cli.js'))} init`, {
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
      `bun run ${sq(join(agentRoot, 'dist', 'cli.js'))} node create --parent root --id ${sq(id)} --context ${sq(note)}`,
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

async function* agshStream(ctx: Context, options: any, cwd: string, agentRoot: string): AsyncIterable<any> {
  const nodesPath = join(cwd, '.agsh', 'nodes')
  const sid = String(options.sessionId ?? '')
  try {
    await ensureNodes(ctx, cwd, agentRoot, options.signal)
    const t = await ensureTerminal(ctx, cwd, agentRoot, sid, options.signal)
    // 目标跟随终端真实凭证;drop 后(空)沿用上一节点,不自动 claim。
    const cred = await readCredential(ctx, cwd, t, options.signal)
    const target = cred || lastCred.get(sid) || sessionNodeId(sid) || 'root'
    if (cred) lastCred.set(sid, cred)
    const wire = await contextBuild(ctx, cwd, agentRoot, target, options.signal)
    // 过滤框架注入的 <recover> 违规提示:原生意为"纯文本 assistant = 违规",
    // 但 DSH 回合模型下纯文本回复是回合的正常终点;不滤则每轮结束后下一轮
    // 上下文都指控模型违规,且会在 history 里累积误导模型。
    const modelWire = wire.filter(
      (m: any) => !(m?.role === 'system' && typeof m?.content === 'string' && m.content.startsWith('<recover>')),
    )

    const innerOptions: any = {
      provider: options.provider,
      model: options.model,
      ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
      messages: fromWire([{ role: 'system', content: DSH_NOTE }, ...modelWire], options.provider, options.model),
      tools: [SHELL_TOOL_SCHEMA],
      signal: options.signal,
      sessionId: options.sessionId,
      purpose: 'agsh-inner',
    }
    // 双保险:本地 WeakSet 标记(门禁三分判定最优先放行)+ purpose 字段
    // (即使漏 mark,shape 谓词的 purpose===undefined 条件也不会误吞)。
    SELF_INNER_REQUESTS.add(innerOptions)
    const inner = ctx.llm.stream(innerOptions)

    const assembler = new BlockAssembler()
    for await (const chunk of inner) {
      try {
        assembler.push(chunk)
      } catch {
        /* ignore malformed chunk */
      }
      yield chunk
    }
    const finish = assembler.finish
    if (finish && finish.kind !== 'error' && finish.kind !== 'aborted') {
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

/** 每会话最近一次非空凭证(供 drop 后沿用目标节点,不自动 claim) */
const lastCred = new Map<string, string>()

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
      const beforeCred = await readCredential(ctx, cwd, t, exec.signal)
      // 执行前凭证 = 结果落点节点(尾调按 _cred_before 归属);也是轮询目标。
      // 为空(段结束/落点失败)时命令执行但结果无人记录,轮询会超时兜底。
      const content = await execInTerminal(ctx, cwd, t, beforeCred, cmd, String(exec.callId), exec.signal)
      const afterCred = await readCredential(ctx, cwd, t, exec.signal)
      // ── 检测 drop:命令释放了凭证 → 本节点段立即结束 ──
      // drop 结果已由终端尾调按 _cred_before 写回释放前节点;插件置段结束态。
      if (beforeCred && !afterCred) {
        segmentEnded.set(sid, true)
        return { content: `${content}\n\n[节点段已结束] 凭证已释放(${beforeCred})。请直接给出最终回复;下一条用户消息将回到本节点继续。` }
      }
      return { content }
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

  // 4. 会话生命周期收尾:会话结束时释放凭证 + 销毁持续终端。
  //    官方 agent-shell 以 credential drop 结束;DSH 代理 loop 后,Duration
  //    归 DSH 所有,因此在 session/end-seed(会话关闭/归档)时由插件代为
  //    释放凭证并 kill 终端——同时修复 tmux 客户端泄漏(Risk #1)。
  ctx.on('session/event', (session: any, event: any) => {
    if (!isAgentShellSession(session)) return
    if (event?.type !== 'session/end-seed') return
    const cwd = session?.header?.cwd
    const agentRoot = cwd && agentRootOf(cwd)
    if (!cwd || !agentRoot) return
    const sid = String(session.id)
    void (async () => {
      try {
        const t = await ensureTerminal(ctx, cwd, agentRoot, sid, undefined)
        await tmuxSend(ctx, cwd, t, 'credential drop', undefined)
        await runSh(
          ctx,
          cwd,
          `tmux -S ${sq(t.socket)} kill-session -t ${sq(t.session)} 2>/dev/null; true`,
          { timeoutMs: 10000 },
        )
        lastCred.delete(sid)
        console.error(`[agsh] session ${sid} ended: credential dropped, terminal torn down`)
      } catch (e: any) {
        console.error(`[agsh] session-end cleanup: ${e?.message ?? String(e)}`)
      }
    })()
  })
}
