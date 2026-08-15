# AgentShell 运行件安装(agsh 预设在任何目录可用)

**分离发布**:DSH 插件(本包)随 git 分发;AgentShell 框架独立发布;工作目录零安装。

## 0. 前置(未装过 AgentShell / 缺依赖时从这里开始)

```bash
command -v bun && command -v jq && command -v tmux
```

- `bun`(构建/运行 CLI)、`jq`(JSON 解析)、`tmux`(持续终端)——机器前置依赖,与 DSH 无关。
- 任一缺失:先安装(`brew install oven-sh/bun/bun jq tmux`,Linux 用发行版包管理器),再继续。
- 从未装过 AgentShell:第 1、2 节就是完整从零安装路径。AgentShell 框架独立发布、不随本插件打包,需要先取得 agent-shell 发布物(`git clone` 仓库或发行包解压目录)。

## 1. 安装 AgentShell 运行件

`S` = AgentShell 发布物路径(仓库 clone / 发行包解压目录):

```bash
S=<agent-shell 发布物路径> && mkdir -p ~/.agsh && cp -R "$S/src" ~/.agsh/ && cp "$S/agent.zsh" ~/.agsh/ && (cd ~/.agsh && bun build src/cli.ts --outdir dist --target=bun) && ls ~/.agsh/dist/cli.js
```

装到哪都行,`AGSH_ROOT` 指向它即可。`dist/cli.js` 必须先构建一次——插件门禁:`AGSH_ROOT/dist/cli.js`,或工作目录下的 `agent-shell/dist/cli.js`,二者其一。DSH 嵌入模式下终端不打 API,无需配 key。

## 2. 注册根目录并重启 DSH

```bash
echo 'export AGSH_ROOT="$HOME/.agsh"' >> ~/.zshrc && source ~/.zshrc
```

重启 DSH 进程(`npx @deepseek-ai/dsh web` 必须继承 `AGSH_ROOT`)。

> [需用户确认] 写入 `~/.zshrc` 与重启 DSH(中断运行中会话)两步,执行前先征得用户同意。

## 3. 需要用户确认的关键步骤

以下步骤会改动用户机器状态,执行前必须把「即将执行的命令 + 影响范围 + 回退方式」列给用户、得到明确同意:

| 步骤 | 改动 | 回退 |
| :--- | :--- | :--- |
| 选定安装路径并复制运行件(默认 `~/.agsh`) | 用户家目录新增目录 | `rm -rf` 该目录 |
| 写入 `~/.zshrc`(`export AGSH_ROOT=...`) | 用户 shell 配置 | 删掉写入的那一行 |
| 重启 DSH 进程 | 中断所有运行中会话 | —(重启前让用户保存工作) |
| `git clone` 到稳定 checkout 路径(默认 `~/dsh-agsh-context`) | 用户家目录新增目录 | `rm -rf` 该目录 |

无需确认(只写 checkout 内 / 官方机制可逆 / 不影响运行中 DSH):`bun install`、`bun run build`、`dsh plugin --profile <name> add <目录>`、preset 部署。插件挂载发生在 DSH 启动时,安装与改挂载对运行中会话无影响,新会话生效。

## 4. 插件安装(git 分发)

见 [README.md](./README.md)「安装(git 分发)」:

1. `git clone https://github.com/Eric-GoodBoy-Tech/dsh-agsh-context /path/to/dsh-agsh-context`
2. `cd /path/to/dsh-agsh-context && bun install && bun run build`
3. `dsh plugin --profile <name> add /path/to/dsh-agsh-context`(官方安装口,转发 pnpm 到 profile 目录;link: 语义——profile 里的 `dsh-agsh-context` 是指向 checkout 的符号链接,安装后保留 checkout 目录)
4. `mkdir -p ~/.dsh/.agent-presets/agsh && cp preset/preset.yml preset/agent.cordis.yml ~/.dsh/.agent-presets/agsh/`(挂载行已是裸包名)
5. 在 profile 目录验证裸名导入(见 README 验证行)

卸载/回退:`dsh plugin --profile <name> remove dsh-agsh-context`,预设挂载行改回绝对路径。

## 5. 给安装/排障 Agent 的提示词模板

把下面整段复制给任意 DSH Agent(普通会话,非 agsh 预设),它可独立完成安装与排障:

```
请在本机安装 dsh-agsh-context 插件(git 分发,来源:https://github.com/Eric-GoodBoy-Tech/dsh-agsh-context)。逐条执行并给出验证输出,失败时按排查表处理,不要跳过任何一步。每个 [需用户确认] 的步骤,先把具体命令与影响范围列给用户并等待明确同意;未确认不得执行。

1. 前置检查:
   command -v bun jq tmux; echo "AGSH_ROOT=$AGSH_ROOT"; ls "$AGSH_ROOT/dist/cli.js"
   [需用户确认] bun/jq/tmux 任一缺失 → 列安装命令请用户确认后执行。
   [需用户确认] AGSH_ROOT 缺失或没有 dist/cli.js → 按仓库 INSTALL.md 第 1、2 节安装运行件;其中写 ~/.zshrc 与重启 DSH 两步先征得用户同意。
2. 取代码并构建(稳定路径,装后保留;不要用会被清理的临时目录):
   [需用户确认] clone 目标路径(默认 ~/dsh-agsh-context);若路径已存在,先询问用户如何处理。
   git clone https://github.com/Eric-GoodBoy-Tech/dsh-agsh-context ~/dsh-agsh-context && cd ~/dsh-agsh-context && bun install && bun run build && ls dist/index.js
3. 官方安装:
   dsh plugin --profile web add "$(pwd)" && ls ~/.dsh/profiles/web/node_modules/dsh-agsh-context
4. 注册预设:
   mkdir -p ~/.dsh/.agent-presets/agsh && cp preset/preset.yml preset/agent.cordis.yml ~/.dsh/.agent-presets/agsh/
   grep -n "name:" ~/.dsh/.agent-presets/agsh/agent.cordis.yml | head -3   # 挂载行应为裸名 dsh-agsh-context
5. 验证导入(必须 cd 到 profile 目录):
   cd ~/.dsh/profiles/web
   node --input-type=module -e "import('dsh-agsh-context').then(m=>console.log('NODE',m.name,typeof m.isAgentShellSession,typeof m.inject,typeof m.apply))"
   bun -e "const m=await import('dsh-agsh-context');console.log('BUN',m.name,typeof m.isAgentShellSession,typeof m.inject,typeof m.apply)"
   期望:BUN/NODE 均输出 agsh-context function object function
6. 收尾:
   保留 checkout(~/dsh-agsh-context)——profile 里的 dsh-agsh-context 是指向它的链接,删除即插件失效。
   [需用户确认] 若步骤 1 安装/更新了运行件并写了 ~/.zshrc:重启 DSH 使 AGSH_ROOT 生效(不重启则新会话可能降级成普通 agent)。重启前让用户保存当前工作。
   新开会话选 agsh 预设发首条消息,应自动建 .agsh/nodes、起持续终端。

失败排查表:
| 症状 | 原因 | 处理 |
| :--- | :--- | :--- |
| Cannot find package 'dsh-agsh-context' | 裸名解析锚点 = profile 目录 + DSH 安装目录;插件没进 profile | 重跑步骤 3,确认 profile/node_modules 下有包或链接 |
| Cannot find module '@deepseek-ai/cordis' / '@deepseek-ai/dsh-llm' | link: 安装下 ESM 加载器按链接真实路径解析,依赖必须来自 checkout 的 node_modules(bun install);DSH 启动后的 healProfilesModuleFallback 平铺 symlink 只覆盖 --preserve-symlinks 路径 | 核对版本对齐 cordis 4.0.1 / dsh-llm 0.1.0-rc.6;在 checkout 目录重跑 bun install |
| dist/index.js 不存在 | 没构建或构建目标错 | 重跑 bun run build(node 目标) |
| ERR_REQUIRE_ESM / 入口加载报错 | 入口没指 dist;type: module 缺失(ESM-CJS) | 核对 package.json main/exports 指向 dist/index.js |
| 会话降级成普通 agent(shell 报 no agent-shell workspace) | AGSH_ROOT 未设 / DSH 未重启 / 缺 dist/cli.js | 见本文件第 1、2 节 |
| 安装后插件失效 / profile 里 dsh-agsh-context 是坏链接 | checkout 目录被删除或移动(link: 指向它) | 恢复 checkout 目录,或重新 clone + bun install + 重跑步骤 3 |
| 终端起不来 | tmux 未装或 socket 目录无权限 | 见第 0 节 |
```

## 6. 任何目录使用

1. `cd` 到任意目录;
2. DSH Web → 新会话 → 预设选 **agsh**;
3. 发首条消息,自动完成:建 `.agsh/nodes`(root init)→ 起持续终端 → 节点链协议即用;
4. 每目录一棵独立节点树;git 项目 `.gitignore` 加 `.agsh/`。

## 7. 验证

在任意新目录的 agsh 会话里让 agent 执行:

```bash
pwd && echo "CREDENTIAL=[$CREDENTIAL]" && ls .agsh/nodes/
```

预期:CREDENTIAL 非空,`root` 节点存在。

## 8. 排查

| 症状 | 原因 |
|---|---|
| 会话降级成普通 agent(shell 报 `no agent-shell workspace`) | `AGSH_ROOT` 未设 / DSH 未重启 / 指向目录缺 `dist/cli.js` |
| CLI 不工作,提示 `bun not found` | bun 不在 DSH 进程 PATH |
| 终端起不来 | tmux 未装或 socket 目录无权限 |
