// src/index.ts
import { BlockAssembler, isAgentLoopRequest } from "@deepseek-ai/dsh-llm";
import { readFileSync, existsSync, mkdirSync, appendFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
var name = "agsh-context";
var inject = ["llm", "shell", "timer", "tools", "sessions"];
var SHELL_TOOL_SCHEMA = {
  name: "shell",
  description: "在持续终端(真实交互式 zsh,已加载 agent-shell)中执行 shell 命令。" + "cd、export、文件写入在调用间持久。节点协议(credential claim/drop、prompt)在这里原生可用。",
  parameters: {
    type: "object",
    properties: {
      cmd: { type: "string", description: "要执行的 shell 命令" }
    },
    required: ["cmd"]
  }
};
function isAgentShellSession(session) {
  if (!session)
    return false;
  const events = session.events;
  if (Array.isArray(events)) {
    for (let i = events.length - 1;i >= 0; i--) {
      const e = events[i];
      if (e?.type === "agent-preset/selected")
        return e.data?.agentPreset === "agsh";
    }
  }
  return session.header?.agentPreset === "agsh";
}
var SELF_INNER_REQUESTS = new WeakSet;
function looksLikeAgentLoopRequest(options) {
  return options !== null && typeof options === "object" && options.purpose === undefined && typeof options.provider === "string" && options.provider.length > 0 && typeof options.model === "string" && options.model.length > 0 && Array.isArray(options.messages) && options.messages.length > 0 && options.messages.every((m) => m !== null && typeof m === "object" && typeof m.role === "string") && typeof options.sessionId === "string" && options.sessionId.length > 0;
}
function safeRead(p) {
  try {
    return readFileSync(p, "utf-8");
  } catch {
    return "";
  }
}
function appendHistory(nodesPath, id, msgs) {
  if (!msgs || msgs.length === 0)
    return;
  const dir = join(nodesPath, id);
  if (!existsSync(dir)) {
    console.error(`[agsh] appendHistory: node '${id}' does not exist — history write skipped`);
    return;
  }
  try {
    appendFileSync(join(dir, "history"), JSON.stringify(msgs) + `
`, "utf-8");
  } catch {}
}
function fromWire(msgs, provider, model) {
  let n = 0;
  return msgs.map((m) => {
    const id = `agsh-${Date.now()}-${n++}`;
    switch (m.role) {
      case "system":
        return {
          id,
          role: "system",
          content: [{ type: "text", text: m.content ?? "" }],
          source: { kind: "plugin", plugin: "agsh-context" }
        };
      case "user":
        return { id, role: "user", content: [{ type: "text", text: m.content ?? "" }], source: { kind: "user" } };
      case "tool":
        return {
          id,
          role: "user",
          content: [
            {
              type: "tool-result",
              toolCallId: m.tool_call_id,
              content: [{ type: "text", text: m.content ?? "" }]
            }
          ],
          source: { kind: "tool", callId: m.tool_call_id }
        };
      case "assistant": {
        const blocks = [];
        if (m.content)
          blocks.push({ type: "text", text: m.content });
        if (m.reasoning_content)
          blocks.push({ type: "reasoning", text: m.reasoning_content });
        for (const tc of m.tool_calls ?? []) {
          blocks.push({ type: "tool-call", id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments ?? "{}" });
        }
        return { id, role: "assistant", content: blocks, source: { kind: "model", provider, model } };
      }
      default:
        return { id, role: "user", content: [{ type: "text", text: JSON.stringify(m) }], source: { kind: "user" } };
    }
  });
}
function toWireAssistant(blocks) {
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
  const reasoning = blocks.filter((b) => b.type === "reasoning").map((b) => b.text).join("");
  const toolCalls = blocks.filter((b) => b.type === "tool-call").map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: b.arguments } }));
  const out = { role: "assistant", content: text || null, reasoning_content: reasoning || null };
  if (toolCalls.length)
    out.tool_calls = toolCalls;
  return out;
}
function textOfMessage(m) {
  const blocks = Array.isArray(m?.content) ? m.content : [];
  return blocks.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}
function agentRootOf(cwd) {
  const fromEnv = typeof process !== "undefined" && process.env.AGSH_ROOT ? process.env.AGSH_ROOT : undefined;
  if (fromEnv && existsSync(join(fromEnv, "dist", "cli.js")))
    return fromEnv;
  const rel = join(cwd, "agent-shell");
  if (existsSync(join(rel, "dist", "cli.js")))
    return rel;
  return null;
}
var counter = 0;
async function runSh(ctx, cwd, command, opts = {}) {
  const shell = ctx.get("shell");
  const policy = ctx.get("sandboxPolicy")?.resolve?.({ mode: "danger-full-access" });
  const spec = shell.resolve({
    command,
    workdir: cwd,
    timeoutMs: opts.timeoutMs ?? 30000,
    ...opts.signal ? { signal: opts.signal } : {},
    ...opts.env ? { env: opts.env } : {},
    ...policy ? { sandboxPolicy: policy } : {}
  });
  const r = await shell.run(spec);
  return { exitCode: r.exitCode, stdout: r.stdout?.text ?? "", stderr: r.stderr?.text ?? "" };
}
function sq(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
async function tmuxSend(ctx, cwd, t, text, signal) {
  const r = await runSh(ctx, cwd, `tmux -S ${sq(t.socket)} send-keys -t ${sq(t.session)} -- ${sq(text)} Enter`, {
    timeoutMs: 15000,
    signal
  });
  if (r.exitCode !== 0)
    throw new Error(`tmux send-keys failed: ${r.stderr || r.stdout}`);
}
async function tmuxHas(ctx, cwd, t) {
  const r = await runSh(ctx, cwd, `tmux -S ${sq(t.socket)} has-session -t ${sq(t.session)} 2>/dev/null; echo "RC=$?"`, {
    timeoutMs: 1e4
  });
  return r.stdout.includes("RC=0");
}
async function ensureTerminal(ctx, cwd, agentRoot, sessionId, signal) {
  const tmpDir = join(cwd, ".agsh", "tmp");
  mkdirSync(tmpDir, { recursive: true });
  const t = {
    socket: join(tmpDir, "dsh-tmux.sock"),
    session: "agsh-" + String(sessionId).replace(/[^A-Za-z0-9_-]/g, "_").slice(-40)
  };
  if (await tmuxHas(ctx, cwd, t))
    return t;
  const created = await runSh(ctx, cwd, `tmux -S ${sq(t.socket)} new-session -d -s ${sq(t.session)} -c ${sq(cwd)} 'zsh -i'`, { timeoutMs: 15000, signal });
  if (created.exitCode !== 0)
    throw new Error(`tmux new-session failed: ${created.stderr}`);
  await ctx.timer.timeout(800);
  await tmuxSend(ctx, cwd, t, "export AGENT_HEADLESS=1", signal);
  await ctx.timer.timeout(300);
  await tmuxSend(ctx, cwd, t, `source ${sq(join(agentRoot, "agent.zsh"))}`, signal);
  const deadline = Date.now() + 60000;
  let ready = false;
  for (;; ) {
    if (signal?.aborted)
      throw new Error("aborted");
    await ctx.timer.timeout(1000);
    const cap = await runSh(ctx, cwd, `tmux -S ${sq(t.socket)} capture-pane -p -t ${sq(t.session)} 2>/dev/null`, {
      timeoutMs: 1e4
    });
    if (cap.stdout.includes("[none]")) {
      ready = true;
      break;
    }
    if (Date.now() > deadline)
      break;
  }
  if (ready) {
    const prev = lastCred.get(sessionId);
    if (prev) {
      try {
        await tmuxSend(ctx, cwd, t, `credential claim ${sq(prev)}`, signal);
        const after = await readCredential(ctx, cwd, t, signal);
        if (after === prev) {
          console.error(`[agsh] ensureTerminal: 重建终端已自动 re-claim ${prev}`);
        } else {
          console.error(`[agsh] ensureTerminal: re-claim ${prev} 未生效(读回 ${JSON.stringify(after)};可能被其他会话锁挡下),终端保持无凭证`);
        }
      } catch (e) {
        console.error(`[agsh] ensureTerminal: re-claim 失败: ${e?.message ?? String(e)}`);
      }
    }
  }
  return t;
}
async function readCredential(ctx, cwd, t, signal) {
  const tmpDir = join(cwd, ".agsh", "tmp");
  const file = join(tmpDir, `agsh_cred_${Date.now()}_${counter++}.txt`);
  await tmuxSend(ctx, cwd, t, `printf '%s' "${"${CREDENTIAL:-}"}" > ${sq(file)}`, signal);
  const deadline = Date.now() + 8000;
  let emptySince = 0;
  for (;; ) {
    const v = safeRead(file);
    if (v !== "") {
      try {
        rmSync(file);
      } catch {}
      return v.trim();
    }
    if (existsSync(file)) {
      if (!emptySince)
        emptySince = Date.now();
      if (Date.now() - emptySince > 1200) {
        try {
          rmSync(file);
        } catch {}
        return null;
      }
    } else {
      emptySince = 0;
    }
    if (Date.now() >= deadline) {
      try {
        rmSync(file);
      } catch {}
      return null;
    }
    await ctx.timer.timeout(300);
  }
}
async function credentialBound(cwd, cred) {
  const lockFile = join(cwd, ".agsh", "nodes", cred, ".lock");
  const raw = safeRead(lockFile).trim();
  if (!raw)
    return false;
  const pid = Number(raw);
  if (!Number.isFinite(pid) || pid <= 0)
    return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function execInTerminal(ctx, cwd, t, cred, cmd, callId, signal) {
  const tmpDir = join(cwd, ".agsh", "tmp");
  const tag = `${Date.now()}_${counter++}`;
  const cmdfile = join(tmpDir, `agsh_cmd_${tag}.zsh`);
  const artifactDir = join(tmpDir, `agsh_inj_${tag}`);
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(cmdfile, cmd, "utf-8");
  const histFile = join(cwd, ".agsh", "nodes", cred, "history");
  const initialSize = existsSync(histFile) ? statSync(histFile).size : 0;
  const line = `export _AGENT_CAPTURE=1 _AGENT_ARTIFACT_DIR=${sq(artifactDir)} _AGENT_EXEC_TOOL_ID=${sq(callId)} ` + `_AGENT_CAPTURE_CRED_BEFORE="\${CREDENTIAL:-}"; ` + `exec 3>&1 4>&2; exec > >(tee ${sq(join(artifactDir, "output"))}) 2>&1; ` + `source ${sq(cmdfile)}; exec >&3 2>&4`;
  await tmuxSend(ctx, cwd, t, line, signal);
  const result = await waitHistoryTool(ctx, histFile, callId, initialSize, 120000, signal);
  try {
    rmSync(artifactDir, { recursive: true, force: true });
  } catch {}
  try {
    rmSync(cmdfile);
  } catch {}
  if (result)
    return result;
  await runSh(ctx, cwd, `tmux -S ${sq(t.socket)} send-keys -t ${sq(t.session)} C-c`, { timeoutMs: 1e4 });
  const partial = await waitHistoryTool(ctx, histFile, callId, initialSize, 15000, signal);
  return partial || `Timed out after 120s`;
}
async function waitHistoryTool(ctx, histFile, callId, initialSize, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  for (;; ) {
    if (signal?.aborted)
      return "";
    const raw = safeRead(histFile);
    if (Buffer.byteLength(raw, "utf-8") > initialSize) {
      for (const line of raw.split(`
`).reverse()) {
        const t = line.trim();
        if (!t)
          continue;
        try {
          const arr = JSON.parse(t);
          for (const m of arr) {
            if (m?.role === "tool" && m.tool_call_id === callId)
              return String(m.content ?? "");
          }
        } catch {}
      }
    }
    if (Date.now() >= deadline)
      return "";
    await ctx.timer.timeout(300);
  }
}
async function contextBuild(ctx, cwd, agentRoot, target, signal) {
  const tmpDir = join(cwd, ".agsh", "tmp");
  const out = join(tmpDir, `agsh_ctx_${Date.now()}_${counter++}.json`);
  const r = await runSh(ctx, cwd, `bun run ${sq(join(agentRoot, "dist", "cli.js"))} context build --cred ${sq(target)} > ${sq(out)} 2>&1`, { timeoutMs: 60000, signal, env: { AGENT_NODES_PATH: join(cwd, ".agsh", "nodes") } });
  const content = safeRead(out);
  try {
    rmSync(out);
  } catch {}
  if (r.exitCode !== 0)
    throw new Error(`agsh context build failed: ${content.slice(-500)}`);
  try {
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed))
      throw new Error("not an array");
    return parsed;
  } catch (e) {
    throw new Error(`agsh context build: invalid output: ${content.slice(-300)}`);
  }
}
async function ensureNodes(ctx, cwd, agentRoot, signal) {
  if (existsSync(join(cwd, ".agsh", "nodes", "root")))
    return;
  await runSh(ctx, cwd, `bun run ${sq(join(agentRoot, "dist", "cli.js"))} init`, {
    timeoutMs: 60000,
    signal,
    env: { AGENT_NODES_PATH: join(cwd, ".agsh", "nodes") }
  });
}
function sessionNodeId(sessionId) {
  const s = String(sessionId ?? "").replace(/[^A-Za-z0-9_-]/g, "_").slice(-40);
  return s ? `agsh-${s}` : "";
}
async function ensureSessionNode(ctx, cwd, agentRoot, sessionId, t, signal) {
  const id = sessionNodeId(sessionId);
  if (!id)
    return "root";
  const nodesPath = join(cwd, ".agsh", "nodes");
  if (!existsSync(join(nodesPath, id))) {
    const note = `DSH 会话 ${sessionId} 专属节点:首句自动落点,parent=root,隔离多会话。
` + `
` + `传递语义(重要):前缀链只携带链上各节点的 context 文件;本节点的 history——` + `包括用户的原始指令——不会随链传递到下一个节点。claim 到工作节点后,` + `那个节点看不到本节点的对话记录,任务要求必须由你写进新节点的 context(Todo)` + `才会继续生效。本节点的 context 本身会作为祖先随链传递。`;
    const r = await runSh(ctx, cwd, `bun run ${sq(join(agentRoot, "dist", "cli.js"))} node create --parent root --id ${sq(id)} --context ${sq(note)}`, { timeoutMs: 60000, signal, env: { AGENT_NODES_PATH: nodesPath } });
    if (r.exitCode !== 0)
      throw new Error(`agsh auto-node create failed: ${r.stderr || r.stdout}`);
  }
  await tmuxSend(ctx, cwd, t, `credential claim ${sq(id)}`, signal);
  const after = await readCredential(ctx, cwd, t, signal);
  if (!after) {
    console.error(`[agsh] ensureSessionNode: claim ${id} did not take effect (locked or failed)`);
  }
  return id;
}
var DSH_NOTE = "DSH embed mode: a turn ends when you produce your final text reply — you do not need to drop between turns. " + "Your credential binding persists across turns; the next turn continues at the same node. " + "To move work to another node, use `credential claim <name>` (it auto-releases the current binding). " + "If you do `credential drop`, the node segment ends immediately: no further commands will execute until the next user message, " + "which returns to this node and continues here.";
async function* agshStream(ctx, options, cwd, agentRoot) {
  const nodesPath = join(cwd, ".agsh", "nodes");
  const sid = String(options.sessionId ?? "");
  try {
    await ensureNodes(ctx, cwd, agentRoot, options.signal);
    const t = await ensureTerminal(ctx, cwd, agentRoot, sid, options.signal);
    const cred = await readCredential(ctx, cwd, t, options.signal);
    const target = cred || lastCred.get(sid) || sessionNodeId(sid) || "root";
    if (cred)
      lastCred.set(sid, cred);
    const wire = await contextBuild(ctx, cwd, agentRoot, target, options.signal);
    const modelWire = wire.filter((m) => !(m?.role === "system" && typeof m?.content === "string" && m.content.startsWith("<recover>")));
    const innerOptions = {
      provider: options.provider,
      model: options.model,
      ...options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {},
      messages: fromWire([{ role: "system", content: DSH_NOTE }, ...modelWire], options.provider, options.model),
      tools: [SHELL_TOOL_SCHEMA],
      signal: options.signal,
      sessionId: options.sessionId,
      purpose: "agsh-inner"
    };
    SELF_INNER_REQUESTS.add(innerOptions);
    const inner = ctx.llm.stream(innerOptions);
    const assembler = new BlockAssembler;
    for await (const chunk of inner) {
      try {
        assembler.push(chunk);
      } catch {}
      yield chunk;
    }
    const finish = assembler.finish;
    if (finish && finish.kind !== "error" && finish.kind !== "aborted") {
      appendHistory(nodesPath, target, [toWireAssistant(assembler.blocks())]);
    }
  } catch (e) {
    console.error(`[agsh] ${e?.message ?? String(e)}`);
    yield {
      type: "finish",
      reason: { kind: "error", failure: { message: String(e?.message ?? e), code: "UNKNOWN" } }
    };
  }
}
var lastCred = new Map;
var segmentEnded = new Map;
function apply(ctx) {
  ctx.tools.register({
    ...SHELL_TOOL_SCHEMA,
    output: {
      schema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] },
      render: (args, value) => [{ type: "text", text: String(value?.content ?? "") }]
    },
    execute: async (args, exec) => {
      const agent = exec?.agent;
      if (!isAgentShellSession(agent?.session))
        throw new Error("shell tool is only available to the agsh preset");
      const cwd = agent?.session?.header?.cwd;
      const agentRoot = cwd && agentRootOf(cwd);
      if (!cwd || !agentRoot)
        throw new Error("agsh shell tool: no agent-shell workspace");
      const cmd = args?.cmd;
      if (typeof cmd !== "string" || !cmd.trim())
        throw new Error("shell: cmd is required");
      const t = await ensureTerminal(ctx, cwd, agentRoot, String(agent.session.id), exec.signal);
      const sid = String(agent.session.id);
      if (segmentEnded.get(sid)) {
        return { content: "[节点段已结束] 本节点已 credential drop,本轮不再执行命令。请直接给出最终回复;下一条用户消息将回到本节点继续。" };
      }
      const beforeCred = await readCredential(ctx, cwd, t, exec.signal);
      const content = await execInTerminal(ctx, cwd, t, beforeCred ?? "", cmd, String(exec.callId), exec.signal);
      let afterCred = await readCredential(ctx, cwd, t, exec.signal);
      if (beforeCred && afterCred === null) {
        afterCred = await readCredential(ctx, cwd, t, exec.signal);
      }
      if (beforeCred && afterCred === null) {
        if (!await credentialBound(cwd, beforeCred)) {
          segmentEnded.set(sid, true);
          return { content: `${content}

[节点段已结束] 凭证已释放(${beforeCred})。请直接给出最终回复;下一条用户消息将回到本节点继续。` };
        }
      }
      return { content };
    }
  });
  ctx.on("agent/pre-step", async (payload, next) => {
    const agent = payload?.agent;
    if (!isAgentShellSession(agent?.session))
      return next();
    const cwd = agent?.session?.header?.cwd;
    const agentRoot = cwd && agentRootOf(cwd);
    if (!cwd || !agentRoot)
      return next();
    const userMsgs = (payload?.messages ?? []).filter((m) => m?.role === "user");
    if (userMsgs.length === 0)
      return next();
    const texts = userMsgs.map(textOfMessage).filter(Boolean);
    if (texts.length === 0)
      return next();
    try {
      await ensureNodes(ctx, cwd, agentRoot, payload.signal);
      const t = await ensureTerminal(ctx, cwd, agentRoot, String(agent.session.id), payload.signal);
      const sid = String(agent.session.id);
      segmentEnded.delete(sid);
      const cred = await readCredential(ctx, cwd, t, payload.signal);
      let target = cred;
      if (!target) {
        const prev = lastCred.get(sid);
        if (prev) {
          await tmuxSend(ctx, cwd, t, `credential claim ${sq(prev)}`, payload.signal);
          const after = await readCredential(ctx, cwd, t, payload.signal);
          if (after === prev) {
            target = prev;
          } else {
            target = await ensureSessionNode(ctx, cwd, agentRoot, sid, t, payload.signal);
            lastCred.set(sid, target);
          }
        } else {
          target = await ensureSessionNode(ctx, cwd, agentRoot, sid, t, payload.signal);
        }
      }
      if (cred)
        lastCred.set(sid, cred);
      appendHistory(join(cwd, ".agsh", "nodes"), target, [{ role: "user", content: texts.join(`
`) }]);
    } catch (e) {
      console.error(`[agsh] pre-step: ${e?.message ?? String(e)}`);
    }
    return next();
  });
  ctx.on("llm/stream", (options, next) => {
    if (SELF_INNER_REQUESTS.has(options))
      return next();
    if (!isAgentLoopRequest(options) && !looksLikeAgentLoopRequest(options))
      return next();
    const session = ctx.get("sessions")?.get(options.sessionId);
    if (!isAgentShellSession(session))
      return next();
    const cwd = session?.header?.cwd;
    const agentRoot = cwd && agentRootOf(cwd);
    if (!cwd || !agentRoot)
      return next();
    return agshStream(ctx, options, cwd, agentRoot);
  });
  ctx.on("session/event", (session, event) => {
    if (!isAgentShellSession(session))
      return;
    if (event?.type !== "session/end-seed")
      return;
    const cwd = session?.header?.cwd;
    const agentRoot = cwd && agentRootOf(cwd);
    if (!cwd || !agentRoot)
      return;
    const sid = String(session.id);
    (async () => {
      try {
        const t = await ensureTerminal(ctx, cwd, agentRoot, sid, undefined);
        await tmuxSend(ctx, cwd, t, "credential drop", undefined);
        await runSh(ctx, cwd, `tmux -S ${sq(t.socket)} kill-session -t ${sq(t.session)} 2>/dev/null; true`, { timeoutMs: 1e4 });
        lastCred.delete(sid);
        console.error(`[agsh] session ${sid} ended: credential dropped, terminal torn down`);
      } catch (e) {
        console.error(`[agsh] session-end cleanup: ${e?.message ?? String(e)}`);
      }
    })();
  });
}
export {
  name,
  isAgentShellSession,
  inject,
  apply
};
