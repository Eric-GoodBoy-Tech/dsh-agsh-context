# dsh-agsh-context

AgentShell 嵌入 DSH 的桥插件(Path B:请求接管)。git 分发,官方 `dsh plugin` 安装,预设挂载用裸包名。

## 它做什么

在 agsh 预设下,DSH 负责调度与 API 调用,AgentShell 持续终端是凭证/节点/history 的唯一权威:

1. **唯一模型工具 `shell`** — 指向持续终端(tmux PTY + agent.zsh headless);执行走注入协议,工具结果由终端 precmd 尾调写入节点 history,插件轮询 history 取结果(History 即同步通道)。
2. **agent/pre-step** — 用户消息按落点规则写入目标节点 history:有凭证沿用;drop 后自然回到上一节点 claim 继续(claim 被其他会话锁挡下则回退会话专属节点);仅首句落会话专属节点。
3. **llm/stream 短路接管** — 循环主请求替换为 `agsh context build --cred <id>` 上下文 + 一次全新 one-shot 调用;回合模型:回合结束无需 drop,凭证跨轮保留,执行 drop 则本节点段立即结束。

非 agsh 会话零侵入(全部钩子带预设/目录门禁)。

## 依赖

- 运行时依赖:`@deepseek-ai/cordis` ^4.0.1、`@deepseek-ai/dsh-llm` ^0.1.0-rc.6。第 2 步 `bun install` 把它们装进 checkout 的 `node_modules`;`dsh plugin add <目录>` 是 link: 语义(profile 里的 `dsh-agsh-context` 是指向 checkout 的符号链接),ESM 加载器按链接真实路径解析,所以裸名 import 时依赖从 checkout 的 `node_modules` 命中
- DSH 启动时会用 healProfilesModuleFallback 把 harness 依赖平铺 symlink 到 `$DSH_HOME/profiles/node_modules`,是 `--preserve-symlinks` 路径下的第二解析锚点
- AgentShell 运行件(`agent.zsh` + `src/` + `dist/cli.js`)通过 `AGSH_ROOT` 定位(或工作目录下的 `agent-shell/dist/cli.js`)——从未装过先按 [INSTALL.md](./INSTALL.md) 第 0-2 节从零安装(写 `~/.zshrc` 与重启 DSH 两步需用户确认);AgentShell 框架独立发布,不随本包分发
- 机器前置:bun、jq、tmux

## 安装(git 分发)

机器上还没有 AgentShell 运行件或 bun/jq/tmux?先按 [INSTALL.md](./INSTALL.md) 第 0-2 节准备(关键步骤需用户确认),再从下表「取代码」开始。

| 步骤 | 命令 | 落地 |
| :--- | :--- | :--- |
| 取代码 | `git clone https://github.com/Eric-GoodBoy-Tech/dsh-agsh-context /path/to/dsh-agsh-context`(稳定路径,装后保留) | 源码 + `preset/` + `dist/` |
| 装依赖并构建 | `cd /path/to/dsh-agsh-context && bun install && bun run build` | `dist/index.js`(node 目标) |
| 官方安装进 profile | `dsh plugin --profile web add /path/to/dsh-agsh-context` | profile 目录内裸名 `dsh-agsh-context` 可解析 |
| 注册预设 | `mkdir -p ~/.dsh/.agent-presets/agsh && cp preset/preset.yml preset/agent.cordis.yml ~/.dsh/.agent-presets/agsh/` | 挂载行已是裸包名 |
| 验证 | 在 profile 目录:`node --input-type=module -e "import('dsh-agsh-context').then(m=>console.log(m.name,typeof m.isAgentShellSession,typeof m.inject,typeof m.apply))"` | `agsh-context function object function` |
| 回退 | 预设挂载行改回绝对路径,`dsh plugin --profile web remove dsh-agsh-context` | 恢复开发态挂载 |

不想手动装?把 [INSTALL.md](./INSTALL.md) 里的「给安装/排障 Agent 的提示词模板」整段复制给你的 DSH Agent,让它替你完成上表全部步骤。

> **链接安装注意**:`dsh plugin add <目录>` 安装为符号链接(link:),profile 的 `node_modules/dsh-agsh-context` 指向 checkout 目录本身——安装后不要移动或删除 checkout,否则插件立即失效(恢复目录或重新 `bun install` 后重跑 `dsh plugin --profile <name> add <目录>` 即可修复)。

## 在预设中挂载

开发态(本地源码路径):

```yaml
- id: agsh-context
  name: '/path/to/dsh-agsh-context/src/index.ts'
```

发布后(裸包名,`dsh plugin add` 安装):

```yaml
- id: agsh-context
  name: 'dsh-agsh-context'
```

## 开发

```bash
bun install          # 装依赖
bun run build        # node 目标构建 dist/index.js(external @deepseek-ai/*)
```

发布入口 `main`/`exports` 指向 `dist/index.js`。git 分发,无 npm 发布步骤。
