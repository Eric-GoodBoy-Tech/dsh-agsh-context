// src/index.ts
import { BlockAssembler, isAgentLoopRequest } from "@deepseek-ai/dsh-llm";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync, mkdirSync, appendFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
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
  const events = typeof session.snapshotEvents === "function" ? session.snapshotEvents() : session.events;
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
function historyHasToolResult(nodesPath, id, callId) {
  if (!id)
    return true;
  const raw = safeRead(join(nodesPath, id, "history"));
  if (!raw)
    return false;
  const lines = raw.split(`
`);
  for (let i = lines.length - 1;i >= 0; i--) {
    const t = lines[i].trim();
    if (!t)
      continue;
    try {
      const arr = JSON.parse(t);
      for (const m of arr)
        if (m?.role === "tool" && m.tool_call_id === callId)
          return true;
    } catch {}
  }
  return false;
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
        if (m.reasoning_content)
          blocks.push({ type: "reasoning", text: m.reasoning_content });
        if (m.content)
          blocks.push({ type: "text", text: m.content });
        for (const tc of m.tool_calls ?? []) {
          blocks.push({ type: "tool-call", id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments ?? "{}" });
        }
        const hasToolCalls = (m.tool_calls ?? []).length > 0;
        return {
          id,
          role: "assistant",
          content: blocks,
          source: {
            kind: "model",
            provider,
            model,
            replayState: {
              response: {
                kind: "pi-ai",
                version: 2,
                api: "openai-completions",
                provider,
                model,
                stopReason: hasToolCalls ? "toolUse" : "stop"
              },
              blocks: blocks.map((b) => b.type === "reasoning" ? { type: "reasoning", thinkingSignature: "reasoning_content" } : { type: b.type })
            }
          }
        };
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
  if (fromEnv && existsSync(join(fromEnv, "src", "cli.ts")))
    return fromEnv;
  const rel = join(cwd, "agent-shell");
  if (existsSync(join(rel, "src", "cli.ts")))
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
var SHELL_COMMANDS = new Set(["zsh", "bash", "sh", "dash", "ksh", "fish"]);
function isShellCommand(fg) {
  const name = String(fg ?? "").trim().split("/").pop() ?? "";
  return SHELL_COMMANDS.has(name);
}

class TerminalBusyError extends Error {
  foreground;
  constructor(foreground) {
    super(`terminal occupied by '${foreground || "unknown"}'; command not executed`);
    this.foreground = foreground;
    this.name = "TerminalBusyError";
  }
}
function terminalBusyMessage(fg) {
  const who = fg && !isShellCommand(fg) ? fg : "前台进程";
  return `[终端被占用] ${who} 正在等待输入(如 sudo/ssh/认证提示),本命令未执行。
` + `请先在持续终端处理该提示(sudo 认证、退出交互程序等),再重试本命令。`;
}
async function foregroundCommand(ctx, cwd, t) {
  const r = await runSh(ctx, cwd, `tmux -S ${sq(t.socket)} display-message -p -t ${sq(t.session)} '#{pane_current_command}' 2>/dev/null`, { timeoutMs: 1e4 });
  return r.stdout.trim();
}
function sentinelPath(tmpDir) {
  return join(tmpDir, `agsh_sent_${Date.now()}_${counter++}.txt`);
}
function sentinelTimeoutMs(env) {
  const n = Number(env?.AGSH_SENTINEL_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 4000;
}
async function waitSentinel(ctx, file, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  for (;; ) {
    if (existsSync(file))
      return true;
    if (signal?.aborted)
      return false;
    if (Date.now() >= deadline)
      return false;
    await ctx.timer.timeout(100);
  }
}
async function probeSentinel(ctx, cwd, t, tmpDir, signal) {
  const probe = sentinelPath(tmpDir);
  const r = await runSh(ctx, cwd, `tmux -S ${sq(t.socket)} send-keys -t ${sq(t.session)} -- ${sq(`: > ${sq(probe)}`)} Enter`, {
    timeoutMs: 15000,
    signal
  });
  if (r.exitCode !== 0)
    throw new Error(`tmux send-keys failed: ${r.stderr || r.stdout}`);
  const landed = await waitSentinel(ctx, probe, sentinelTimeoutMs(process.env), signal);
  try {
    rmSync(probe);
  } catch {}
  return landed;
}
async function tmuxSend(ctx, cwd, t, text, signal) {
  const tmpDir = join(cwd, ".agsh", "tmp");
  mkdirSync(tmpDir, { recursive: true });
  let fg = "";
  for (let i = 0;i < 5; i++) {
    fg = await foregroundCommand(ctx, cwd, t);
    if (fg === "" || isShellCommand(fg))
      break;
    await ctx.timer.timeout(200);
  }
  if (fg !== "" && !isShellCommand(fg))
    throw new TerminalBusyError(fg);
  if (!await probeSentinel(ctx, cwd, t, tmpDir, signal)) {
    throw new TerminalBusyError(await foregroundCommand(ctx, cwd, t));
  }
  const sentinel = sentinelPath(tmpDir);
  const line = `: > ${sq(sentinel)}; ${text}`;
  const r = await runSh(ctx, cwd, `tmux -S ${sq(t.socket)} send-keys -t ${sq(t.session)} -- ${sq(line)} Enter`, {
    timeoutMs: 15000,
    signal
  });
  if (r.exitCode !== 0)
    throw new Error(`tmux send-keys failed: ${r.stderr || r.stdout}`);
  const landed = await waitSentinel(ctx, sentinel, sentinelTimeoutMs(process.env), signal);
  try {
    rmSync(sentinel);
  } catch {}
  if (!landed)
    throw new TerminalBusyError(await foregroundCommand(ctx, cwd, t));
}
function escalateEnabled(env) {
  return env?.AGSH_TERMINAL_ESCALATE !== "0";
}
async function terminalAtShell(ctx, cwd, t) {
  const fg = await foregroundCommand(ctx, cwd, t);
  return fg === "" || isShellCommand(fg);
}
async function panePid(ctx, cwd, t) {
  const r = await runSh(ctx, cwd, `tmux -S ${sq(t.socket)} display-message -p -t ${sq(t.session)} '#{pane_pid}' 2>/dev/null`, { timeoutMs: 1e4 });
  const pid = r.stdout.trim();
  return /^\d+$/.test(pid) ? pid : "";
}
async function recoverTerminal(ctx, cwd, t, reason) {
  await runSh(ctx, cwd, `tmux -S ${sq(t.socket)} send-keys -t ${sq(t.session)} C-c`, { timeoutMs: 1e4 });
  await ctx.timer.timeout(500);
  if (await terminalAtShell(ctx, cwd, t))
    return;
  if (!escalateEnabled(process.env)) {
    console.error(`[agsh] terminal still occupied (${reason}); escalation disabled (AGSH_TERMINAL_ESCALATE=0)`);
    return;
  }
  const pid = await panePid(ctx, cwd, t);
  if (pid) {
    await runSh(ctx, cwd, `pkill -TERM -P ${pid} 2>/dev/null; sleep 0.3; pkill -KILL -P ${pid} 2>/dev/null; true`, { timeoutMs: 1e4 });
    await ctx.timer.timeout(500);
    if (await terminalAtShell(ctx, cwd, t)) {
      console.error(`[agsh] terminal recovered by killing foreground child of ${pid} (${reason})`);
      return;
    }
  }
  await runSh(ctx, cwd, `tmux -S ${sq(t.socket)} kill-session -t ${sq(t.session)} 2>/dev/null; true`, {
    timeoutMs: 1e4
  });
  console.error(`[agsh] terminal unusable (${reason}); session killed — rebuilt on next call`);
}
async function tmuxHas(ctx, cwd, t) {
  const r = await runSh(ctx, cwd, `tmux -S ${sq(t.socket)} has-session -t ${sq(t.session)} 2>/dev/null; echo "RC=$?"`, {
    timeoutMs: 1e4
  });
  return r.stdout.includes("RC=0");
}
function terminalRef(cwd, sessionId) {
  return {
    socket: join(cwd, ".agsh", "tmp", "dsh-tmux.sock"),
    session: "agsh-" + String(sessionId).replace(/[^A-Za-z0-9_-]/g, "_").slice(-40)
  };
}
var liveTerminals = new Set;
function terminalKey(t) {
  return `${t.socket}\x00${t.session}`;
}
function killTerminalSync(t) {
  try {
    execFileSync("tmux", ["-S", t.socket, "kill-session", "-t", t.session], { stdio: "ignore" });
  } catch {}
  try {
    const out = execFileSync("tmux", ["-S", t.socket, "list-sessions", "-F", "#{session_name}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    if (out.split(`
`).every((line) => !line.trim())) {
      execFileSync("tmux", ["-S", t.socket, "kill-server"], { stdio: "ignore" });
    }
  } catch {}
}
function teardownLiveTerminals(kill = killTerminalSync) {
  let n = 0;
  for (const key of liveTerminals) {
    const i = key.indexOf("\x00");
    kill({ socket: key.slice(0, i), session: key.slice(i + 1) });
    n++;
  }
  liveTerminals.clear();
  return n;
}
var CLEANUP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
var installedSignalHandlers = null;
var installedExitHandler = null;
function uninstallProcessCleanup() {
  if (installedSignalHandlers) {
    for (const { signal, handler } of installedSignalHandlers)
      process.removeListener(signal, handler);
    installedSignalHandlers = null;
  }
  if (installedExitHandler) {
    process.removeListener("exit", installedExitHandler);
    installedExitHandler = null;
  }
}
function installProcessCleanup(hooks = {}) {
  const teardown = hooks.teardown ?? (() => teardownLiveTerminals());
  const raise = hooks.raise ?? ((signal) => {
    process.kill(process.pid, signal);
  });
  uninstallProcessCleanup();
  const signalHandlers = [];
  for (const signal of CLEANUP_SIGNALS) {
    const handler = () => {
      teardown();
      uninstallProcessCleanup();
      raise(signal);
    };
    try {
      process.on(signal, handler);
    } catch {
      continue;
    }
    signalHandlers.push({ signal, handler });
  }
  const exitHandler = () => {
    teardown();
  };
  process.on("exit", exitHandler);
  installedSignalHandlers = signalHandlers;
  installedExitHandler = exitHandler;
  return () => {
    for (const { signal, handler } of signalHandlers)
      process.removeListener(signal, handler);
    process.removeListener("exit", exitHandler);
    if (installedSignalHandlers === signalHandlers)
      installedSignalHandlers = null;
    if (installedExitHandler === exitHandler)
      installedExitHandler = null;
  };
}
var OWNER_OPTION = "@agsh_owner";
var REAP_GRACE_MS = 60000;
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0)
    return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}
function parseTerminalList(stdout) {
  const out = [];
  for (const line of stdout.split(`
`)) {
    if (!line.trim())
      continue;
    const [session, owner, created] = line.split("\t");
    if (!session)
      continue;
    const pid = Number.parseInt((owner ?? "").trim(), 10);
    const epoch = Number.parseInt((created ?? "").trim(), 10);
    out.push({
      session,
      ownerPid: Number.isFinite(pid) ? pid : null,
      createdEpoch: Number.isFinite(epoch) ? epoch : null
    });
  }
  return out;
}
function selectOrphanTerminals(list, selfPid, nowEpoch, graceMs = REAP_GRACE_MS, isAlive = pidAlive) {
  const out = [];
  for (const it of list) {
    if (!it.session.startsWith("agsh-"))
      continue;
    if (it.ownerPid === selfPid)
      continue;
    if (it.ownerPid !== null) {
      if (!isAlive(it.ownerPid))
        out.push(it.session);
      continue;
    }
    if (it.createdEpoch !== null && nowEpoch - it.createdEpoch > Math.ceil(graceMs / 1000)) {
      out.push(it.session);
    }
  }
  return out;
}
async function tagTerminalOwner(ctx, cwd, t) {
  try {
    await runSh(ctx, cwd, `tmux -S ${sq(t.socket)} set-option -t ${sq(t.session)} ${OWNER_OPTION} ${process.pid} 2>/dev/null; ` + `tmux -S ${sq(t.socket)} set-option -s exit-empty on 2>/dev/null; true`, { timeoutMs: 1e4 });
  } catch {}
}
async function reapOrphanTerminals(ctx, cwd, socket, opts = {}) {
  const { keep = new Set, nowEpoch = Math.floor(Date.now() / 1000) } = opts;
  const isAlive = opts.isAlive ?? pidAlive;
  const kill = opts.kill ?? killTerminalSync;
  let list;
  try {
    const r = await runSh(ctx, cwd, `tmux -S ${sq(socket)} list-sessions -F '#{session_name}	#{@agsh_owner}	#{session_created}' 2>/dev/null; true`, { timeoutMs: 1e4 });
    list = parseTerminalList(r.stdout);
  } catch {
    return 0;
  }
  const orphans = selectOrphanTerminals(list, process.pid, nowEpoch, REAP_GRACE_MS, isAlive).filter((s) => !keep.has(s));
  for (const session of orphans) {
    kill({ socket, session });
    console.error(`[agsh] reaped orphan terminal ${session} (owner gone)`);
  }
  return orphans.length;
}
var reapedSockets = new Set;
async function reapOnce(ctx, cwd, t) {
  if (reapedSockets.has(t.socket))
    return;
  reapedSockets.add(t.socket);
  const keep = new Set([t.session]);
  for (const key of liveTerminals) {
    const i = key.indexOf("\x00");
    if (key.slice(0, i) === t.socket)
      keep.add(key.slice(i + 1));
  }
  try {
    await reapOrphanTerminals(ctx, cwd, t.socket, { keep });
  } catch {}
}
async function ensureTerminal(ctx, cwd, agentRoot, sessionId, signal) {
  const tmpDir = join(cwd, ".agsh", "tmp");
  mkdirSync(tmpDir, { recursive: true });
  const t = terminalRef(cwd, sessionId);
  if (await tmuxHas(ctx, cwd, t)) {
    liveTerminals.add(terminalKey(t));
    await tagTerminalOwner(ctx, cwd, t);
    await reapOnce(ctx, cwd, t);
    return t;
  }
  const created = await runSh(ctx, cwd, `tmux -S ${sq(t.socket)} new-session -d -s ${sq(t.session)} -c ${sq(cwd)} 'zsh -i'`, { timeoutMs: 15000, signal });
  if (created.exitCode !== 0)
    throw new Error(`tmux new-session failed: ${created.stderr}`);
  liveTerminals.add(terminalKey(t));
  await tagTerminalOwner(ctx, cwd, t);
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
  await reapOnce(ctx, cwd, t);
  return t;
}
async function readCredential(ctx, cwd, t, signal) {
  const tmpDir = join(cwd, ".agsh", "tmp");
  const file = join(tmpDir, `agsh_cred_${Date.now()}_${counter++}.txt`);
  try {
    await tmuxSend(ctx, cwd, t, `printf '%s' "${"${CREDENTIAL:-}"}" > ${sq(file)}`, signal);
  } catch (e) {
    if (e instanceof TerminalBusyError)
      return null;
    throw e;
  }
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
  const line = `export _AGENT_CAPTURE=1 _AGENT_ARTIFACT_DIR=${sq(artifactDir)} _AGENT_EXEC_TOOL_ID=${sq(callId)} ` + `_AGENT_CAPTURE_CRED_BEFORE=${sq(cred)}; ` + `exec 3>&1 4>&2; exec > >(tee ${sq(join(artifactDir, "output"))}) 2>&1; ` + `source ${sq(cmdfile)}; exec >&3 2>&4`;
  try {
    await tmuxSend(ctx, cwd, t, line, signal);
  } catch (e) {
    try {
      rmSync(artifactDir, { recursive: true, force: true });
    } catch {}
    try {
      rmSync(cmdfile);
    } catch {}
    if (e instanceof TerminalBusyError) {
      await recoverTerminal(ctx, cwd, t, e.foreground || "unknown");
      return terminalBusyMessage(e.foreground);
    }
    throw e;
  }
  const result = await waitHistoryTool(ctx, histFile, callId, initialSize, 120000, signal);
  try {
    rmSync(artifactDir, { recursive: true, force: true });
  } catch {}
  try {
    rmSync(cmdfile);
  } catch {}
  if (result)
    return result;
  await recoverTerminal(ctx, cwd, t, "history poll timed out");
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
  const r = await runSh(ctx, cwd, `bun run ${sq(join(agentRoot, "src", "cli.ts"))} context build --cred ${sq(target)} > ${sq(out)} 2>&1`, { timeoutMs: 60000, signal, env: { AGENT_NODES_PATH: join(cwd, ".agsh", "nodes") } });
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
  } catch {
    throw new Error(`agsh context build: invalid output: ${content.slice(-300)}`);
  }
}
async function ensureNodes(ctx, cwd, agentRoot, signal) {
  if (existsSync(join(cwd, ".agsh", "nodes", "root")))
    return;
  await runSh(ctx, cwd, `bun run ${sq(join(agentRoot, "src", "cli.ts"))} init`, {
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
    const r = await runSh(ctx, cwd, `bun run ${sq(join(agentRoot, "src", "cli.ts"))} node create --parent root --id ${sq(id)} --context ${sq(note)}`, { timeoutMs: 60000, signal, env: { AGENT_NODES_PATH: nodesPath } });
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
var SHELL_GUARD_SPEC = { tool: "shell", required: "cmd", aliases: ["command"] };
function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function nonEmptyString(v) {
  return typeof v === "string" && v.trim() !== "";
}
function parseArgs(rawArgs) {
  let obj = rawArgs;
  if (typeof rawArgs === "string") {
    try {
      obj = JSON.parse(rawArgs);
    } catch {
      return;
    }
  }
  return isPlainObject(obj) ? obj : undefined;
}
function classifyToolCall(rawArgs, toolName, spec = SHELL_GUARD_SPEC) {
  if (toolName !== spec.tool)
    return "not-shell";
  const obj = parseArgs(rawArgs);
  if (obj === undefined)
    return "invalid";
  if (nonEmptyString(obj[spec.required]))
    return "ok";
  for (const alias of spec.aliases) {
    if (nonEmptyString(obj[alias]))
      return "drift";
  }
  return "invalid";
}
function retryBudget(env = {}) {
  const raw = env["AGSH_API_RETRY_MAX"];
  if (raw === undefined || raw === null)
    return 2;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1)
    return 2;
  return n;
}
var SEVERITY = { ok: 0, "not-shell": 0, drift: 1, invalid: 2 };
function worstKind(a, b) {
  return SEVERITY[b] > SEVERITY[a] ? b : a;
}
function isSelfInnerRequest(options) {
  return SELF_INNER_REQUESTS.has(options);
}
var RETRY_LOG_PREFIX = "[agsh]";
var AGSH_TOOLCALL_RETRY_CODE = "AGSH_TOOLCALL";
var AGSH_RETRY_POLICY_KEY = "agsh-toolcall";
function classifyAttempt(blocks) {
  let kind = "ok";
  for (const b of blocks) {
    if (b?.type !== "tool-call")
      continue;
    kind = worstKind(kind, classifyToolCall(b.arguments, String(b.name ?? ""), SHELL_GUARD_SPEC));
  }
  return kind;
}
function shouldRetryAttempt(kind, finishReason) {
  return kind === "invalid" && finishReason?.kind !== "max-tokens";
}
function shouldWriteHistory(finish, substituted) {
  return !substituted && !!finish && finish.reason?.kind !== "error" && finish.reason?.kind !== "aborted";
}
function repairDriftChunk(chunk) {
  if (chunk?.type !== "block-end" || chunk?.block?.type !== "tool-call")
    return chunk;
  const block = chunk.block;
  if (classifyToolCall(block.arguments, String(block.name ?? ""), SHELL_GUARD_SPEC) !== "drift")
    return chunk;
  const obj = parseArgs(block.arguments);
  if (obj === undefined)
    return chunk;
  let value;
  for (const alias of SHELL_GUARD_SPEC.aliases) {
    if (nonEmptyString(obj[alias])) {
      value = obj[alias];
      break;
    }
  }
  if (value === undefined)
    return chunk;
  const repaired = { ...obj, [SHELL_GUARD_SPEC.required]: value };
  for (const alias of SHELL_GUARD_SPEC.aliases)
    delete repaired[alias];
  console.error(`${RETRY_LOG_PREFIX} shell tool-call drifted (${SHELL_GUARD_SPEC.aliases.join("/")} → ${SHELL_GUARD_SPEC.required}); repaired in place`);
  return { ...chunk, block: { ...block, arguments: JSON.stringify(repaired) } };
}
async function* streamInner(ctx, innerOptions, opts = {}) {
  const allowContentRetry = opts.allowContentRetry !== false;
  const assembler = new BlockAssembler;
  let finish;
  for await (const chunk of ctx.llm.stream(innerOptions)) {
    if (chunk?.type === "finish") {
      finish = chunk;
      continue;
    }
    const out = repairDriftChunk(chunk);
    try {
      assembler.push(out);
    } catch {}
    yield out;
  }
  let blocks = [];
  let assembleFailed = false;
  try {
    blocks = assembler.blocks();
  } catch {
    assembleFailed = true;
  }
  const substituted = allowContentRetry && !!finish && finish.reason?.kind !== "error" && finish.reason?.kind !== "aborted" && (assembleFailed || shouldRetryAttempt(classifyAttempt(blocks), finish.reason));
  const outFinish = substituted ? {
    type: "finish",
    reason: {
      kind: "error",
      failure: {
        message: "agsh: shell tool-call arguments were unusable (invalid JSON or no usable value)",
        code: AGSH_TOOLCALL_RETRY_CODE
      }
    }
  } : finish;
  if (outFinish) {
    try {
      assembler.push(outFinish);
    } catch {}
    yield outFinish;
  }
  return { assembler, finish: outFinish, substituted };
}
var retryLedger = new Map;
var turnRetries = new Map;
function retryLedgerKey(sessionId, turn, step) {
  return `${sessionId}:${String(turn)}:${String(step)}`;
}
function clearRetryLedger(sessionId) {
  const prefix = `${sessionId}:`;
  for (const key of [...retryLedger.keys()])
    if (key.startsWith(prefix))
      retryLedger.delete(key);
  turnRetries.delete(sessionId);
}
function appendRetryRecords(agent, payload, entry, maxRetries) {
  const session = agent?.session;
  if (!session || typeof session.append !== "function")
    return false;
  const raw = payload?.failure ?? {};
  const message = typeof raw.message === "string" && raw.message ? raw.message : "agsh inner attempt produced unusable output";
  const code = typeof raw.code === "string" && raw.code ? raw.code : AGSH_TOOLCALL_RETRY_CODE;
  session.append("llm/retry", {
    retryId: entry.retryId,
    turn: payload?.turn,
    step: payload?.step,
    provider: String(payload?.provider ?? ""),
    mode: "normal",
    policyKey: AGSH_RETRY_POLICY_KEY,
    retry: entry.retry,
    maxRetries,
    delayMs: 0,
    failure: { message, code }
  });
  session.append("llm/retry-started", {
    retryId: entry.retryId,
    turn: payload?.turn,
    step: payload?.step,
    retry: entry.retry
  });
  return true;
}
function decideStepRetry(payload, ledger, budget, mintId) {
  if (payload?.failure?.code !== AGSH_TOOLCALL_RETRY_CODE)
    return null;
  if (payload?.signal?.aborted)
    return null;
  const sessionId = String(payload?.agent?.session?.id ?? "");
  if (!sessionId)
    return null;
  const key = retryLedgerKey(sessionId, payload?.turn, payload?.step);
  const prev = ledger.get(key) ?? { retry: 0, retryId: mintId() };
  if (prev.retry + 1 >= budget)
    return null;
  return { retry: prev.retry + 1, retryId: prev.retryId };
}
async function* agshStream(ctx, options, cwd, agentRoot) {
  const nodesPath = join(cwd, ".agsh", "nodes");
  const sid = String(options.sessionId ?? "");
  try {
    await ensureNodes(ctx, cwd, agentRoot, options.signal);
    const t = await ensureTerminal(ctx, cwd, agentRoot, sid, options.signal);
    const cred = await readCredential(ctx, cwd, t, options.signal);
    const target = cred || lastCred.get(sid) || sessionNodeId(sid) || "root";
    stepNode.set(sid, target);
    if (cred)
      lastCred.set(sid, cred);
    const wire = await contextBuild(ctx, cwd, agentRoot, target, options.signal);
    const modelWire = wire.filter((m) => !(typeof m?.content === "string" && m.content.startsWith("<recover>")));
    const chain = modelWire.filter((m) => m.role === "system").map((m) => String(m.content ?? ""));
    const rest = modelWire.filter((m) => m.role !== "system");
    const innerOptions = {
      provider: options.provider,
      model: options.model,
      ...options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {},
      messages: fromWire([{ role: "system", content: [DSH_NOTE, ...chain].join(`

`) }, ...rest], options.provider, options.model),
      tools: [SHELL_TOOL_SCHEMA],
      signal: options.signal,
      sessionId: options.sessionId,
      purpose: "agsh-inner"
    };
    SELF_INNER_REQUESTS.add(innerOptions);
    const allowContentRetry = (turnRetries.get(sid) ?? 0) < retryBudget(process.env) - 1;
    const inner = streamInner(ctx, innerOptions, { allowContentRetry });
    let step = await inner.next();
    while (!step.done) {
      yield step.value;
      step = await inner.next();
    }
    const { assembler, finish, substituted } = step.value;
    if (shouldWriteHistory(finish, substituted)) {
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
var stepNode = new Map;
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
      const beforeCred = stepNode.get(sid) ?? await readCredential(ctx, cwd, t, exec.signal);
      let content = "";
      try {
        content = await execInTerminal(ctx, cwd, t, beforeCred ?? "", cmd, String(exec.callId), exec.signal);
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
      } catch (e) {
        content = `Error: ${e?.message ?? String(e)}`;
        throw e;
      } finally {
        if (!historyHasToolResult(join(cwd, ".agsh", "nodes"), beforeCred ?? "", String(exec.callId))) {
          appendHistory(join(cwd, ".agsh", "nodes"), beforeCred ?? "", [
            {
              role: "tool",
              tool_call_id: String(exec.callId),
              content: content || "[tool call produced no result]"
            }
          ]);
        }
      }
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
      clearRetryLedger(sid);
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
  ctx.on("agent/request-error", async (payload, next) => {
    const budget = retryBudget(process.env);
    const sid = String(payload?.agent?.session?.id ?? "");
    if (sid && (turnRetries.get(sid) ?? 0) + 1 > budget - 1)
      return next();
    const entry = decideStepRetry(payload, retryLedger, budget, () => randomUUID());
    if (!entry)
      return next();
    try {
      if (!appendRetryRecords(payload?.agent, payload, entry, budget))
        return next();
    } catch (e) {
      console.error(`${RETRY_LOG_PREFIX} llm/retry record rejected (${e?.message ?? String(e)}); passing the failure through`);
      return next();
    }
    retryLedger.set(retryLedgerKey(sid, payload?.turn, payload?.step), entry);
    turnRetries.set(sid, (turnRetries.get(sid) ?? 0) + 1);
    console.error(`${RETRY_LOG_PREFIX} unusable shell tool-call output; re-running step ${payload?.turn}/${payload?.step} (retry ${entry.retry}/${budget - 1})`);
    return { kind: "retry" };
  });
  ctx.on("session/disposed", (session) => {
    if (!isAgentShellSession(session))
      return;
    const cwd = session?.header?.cwd;
    const agentRoot = cwd && agentRootOf(cwd);
    if (!cwd || !agentRoot)
      return;
    const sid = String(session.id);
    const t = terminalRef(cwd, sid);
    (async () => {
      try {
        const had = await tmuxHas(ctx, cwd, t);
        let dropped = false;
        if (had) {
          try {
            await tmuxSend(ctx, cwd, t, "credential drop", undefined);
            dropped = true;
          } catch (e) {
            console.error(`[agsh] session ${sid}: credential drop skipped (${e?.message ?? String(e)})`);
          }
          await runSh(ctx, cwd, `tmux -S ${sq(t.socket)} kill-session -t ${sq(t.session)} 2>/dev/null; true`, { timeoutMs: 1e4 });
        }
        liveTerminals.delete(terminalKey(t));
        lastCred.delete(sid);
        stepNode.delete(sid);
        segmentEnded.delete(sid);
        clearRetryLedger(sid);
        console.error(`[agsh] session ${sid} disposed: terminal ${had ? "torn down" : "absent"}, ` + `credential ${dropped ? "dropped" : "not dropped"}`);
      } catch (e) {
        console.error(`[agsh] session disposed cleanup: ${e?.message ?? String(e)}`);
      }
    })();
  });
  const uninstallCleanup = installProcessCleanup();
  ctx.effect(() => () => {
    uninstallCleanup();
    teardownLiveTerminals();
  });
}
export {
  AGSH_RETRY_POLICY_KEY,
  AGSH_TOOLCALL_RETRY_CODE,
  REAP_GRACE_MS,
  SHELL_GUARD_SPEC,
  TerminalBusyError,
  appendRetryRecords,
  apply,
  classifyToolCall,
  decideStepRetry,
  ensureTerminal,
  escalateEnabled,
  inject,
  installProcessCleanup,
  isAgentShellSession,
  isSelfInnerRequest,
  isShellCommand,
  name,
  parseTerminalList,
  pidAlive,
  reapOrphanTerminals,
  recoverTerminal,
  repairDriftChunk,
  retryBudget,
  selectOrphanTerminals,
  sentinelTimeoutMs,
  shouldRetryAttempt,
  shouldWriteHistory,
  streamInner,
  teardownLiveTerminals,
  terminalBusyMessage,
  terminalRef,
  tmuxSend,
  uninstallProcessCleanup
};
