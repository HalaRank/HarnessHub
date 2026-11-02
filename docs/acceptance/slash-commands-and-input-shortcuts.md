# 输入快捷键与 ACP Slash Commands 定向验收

日期：2026-11-02。本次属于现有 MVP 的定向优化，不开启新阶段。

## 修改前审查（实施前记录）

调用链：终端字节 / Kitty 按键 → OpenTUI KeyHandler → 所有全局 `useKeyboard`（注册顺序）→ focused Renderable 的 `onKeyDown` → textarea `keyBindings` → `onSubmit`。`preventDefault` 只阻止 Renderable 默认动作；`stopPropagation` 才能阻止后续全局监听器。OS SIGINT 直接进入 App 的 interruptTui，与 Ctrl+C 共用选区→清空→退出规则。

| 入口 | 修改前行为 / 冲突 |
| --- | --- |
| App useKeyboard | Ctrl+P 切换 palette，关闭后没有恢复 message 焦点；Ctrl+B 切侧栏；Esc 无条件清 form；导航字母以 form 保护，但不检查修饰键或事件是否已处理 |
| AgentPane useKeyboard | Ctrl+D 在 message 中关闭输入并切 Changes，覆盖 textarea 的 delete；Ctrl+Y 没有模态优先级；m/a/h/c/x/f 依赖共享 form，无传播保护 |
| CommandPalette useKeyboard / input submit | 上下选择，Enter 执行；没有输入焦点恢复契约 |
| textarea keyBindings / submit | Enter send、Shift+Enter / Ctrl+J newline；默认 Ctrl+D delete、Ctrl+B left，与全局冲突；默认 Meta+Enter 也能 submit；无 Slash 拦截 |
| NativeEvents / ChangesPane useKeyboard | 无 form 时历史工具/原文/分页或文件导航；通过 disabled 避开编辑，但未检查已消费事件 |
| SourceViewer / RawEvents useKeyboard | Esc / Enter copy / 分页，与父级 Esc 和 Ctrl+分页存在重复处理可能 |
| DeleteConfirmation useKeyboard | Tab/方向/Enter/Delete；自身 stopPropagation，但父级没有统一模态路由 |
| ProjectPathInput onKeyDown / onSubmit | Tab 路径补全，Enter 注册；受 App 全局键影响 |
| 其他 input/select onSubmit/onSelect | Project、rename、shortcuts、approval、settings、handoff 等，依赖 focused 与 form；需要防止全局菜单抢键 |
| App SIGINT / CLI agent SIGINT / Daemon SIGINT | App 仅退出 TUI；CLI agent 是独立命令的受控结束；Daemon 是独立进程的受控关闭，不能混为 Ctrl+C cancel |
| shortcutInput | 只检查字符串重复、少量 reserved；Ctrl+A/K/U 等编辑命令可配置成全局命令而被抢走，别名/无效键名未充分检查 |
| available_commands_update | raw / normalized 事件已经落库，但未投影到 NativeSession，UI 无候选来源 |

## 修改后的按键优先级

1. App 顶层 router 使用 `prependListener`，先处理 Ctrl+C / SIGINT：有效屏幕或编辑器选区→复制并清除选区；否则有输入→清空；否则保存草稿后退出。Ctrl+C 不映射到 cancel。鼠标 selection 自动复制入口保留。已有错误状态 Ctrl+Q 紧急退出保留。
2. 当前模态框独占自己的编辑、方向、Enter、Tab、Esc；背后的 Agent/历史/Changes 不处理已经消费的事件。Ctrl+P 只在普通聊天/导航中打开面板，面板内重复按关闭；Esc 同样关闭，恢复原 message 焦点。textarea 不卸载、不重置，光标/草稿保留。其他模态框内不抢 Ctrl+P/B/Y。
3. Slash Popup 打开时，普通 ↑↓ 选候选；Tab / Enter 只补全；零匹配 Enter 只提示。Esc 首次关闭候选并保留文本/焦点，第二次退出编辑。补全关闭状态按实际文本记录，避免延迟 content-change 重新打开候选。鼠标点击同样只补全，不发送。
4. textarea 保留原生编辑：普通字母、↑↓、选区、Ctrl+D delete、Tab 原有行为、Enter send、Shift+Enter newline、Ctrl+J 默认备用 newline（仍可配置，既有 Meta+Enter newline 配置兼容）。粘贴通过原生 bracketed-paste，不拆分 Emoji。Ctrl+Y 只有真实选区时复制；没有选区则不消费编辑指令。
5. 普通聊天中的 Ctrl+P、Ctrl+B 是明确支持的全局入口；两者均不修改草稿/光标。Changes 快捷键仅在非输入、非模态状态生效。
6. m/a/h/c/x/f/p/n/o/q 等单字母只在无输入焦点且无模态框时有效；修饰键不冒充单字母操作。鼠标点击输入框会进入 message 焦点。工作区同期另有导航态 Enter 恢复编辑至草稿末尾的修改及 `mouse-sidebar.test.tsx` 配套测试，已保留并纳入最终回归，不作为本项独立新增功能申报。

快捷键校验同时检查有效键名、Ctrl/Meta 格式、terminal alias、编辑键语义和有效配置重复。拒绝把 Ctrl+A/E/K/U/W/D/J、导航键、Enter/Esc/Ctrl+C/quit 等配置成不相容操作；Ctrl+B sidebar、Ctrl+D 导航态 Changes、Ctrl+J newline 是有明确上下文的例外。不会通过配置把 Enter/Tab/上下方向键变成全局命令。

## ACP 命令数据链路与发送

锁定 SDK `@agentclientprotocol/sdk@2.2.0` 的 v1 类型，并核对 [ACP v1 Slash Commands 官方说明](https://agentclientprotocol.com/protocol/v1/slash-commands)：`available_commands_update` 发布当前命令，命令文本经 `session/prompt` 发送；不从 `session/new` 臆造初始命令字段，不兼容猜测 v2 draft 结构。

`Worker wire tap` → `Runtime.wire` 校验 v1 `availableCommands` 与 agentSessionId → `Live.commands` → `NativeSession.capabilities.commands` JSON 落 SQLite；原始 wire 与 normalized update 继续落 events → 现有 WS / seq 补拉 → AgentPane 重新读取当前 sessions 与 Conversation → `sessionCommands` → Slash Popup。

每次更新完整替换，`[]` 清空；错误结构不覆盖最后有效状态，raw 仍保留。允许 `session/new` 响应前发布更新，最终快照的 agentSessionId 必须匹配响应。后续错误 sessionId 更新不污染当前命令。没有数据库 migration 或新 Runtime。可靠快照可供另一个 TUI 或重新打开的 TUI 读取；已有历史与 raw 不被改写。并发刷新使用 generation 防止旧 HTTP 响应覆盖新状态。

候选只使用当前 Conversation 的 activeNativeSessionId，且 Harness 匹配、无未完成 Handoff、NativeSession 为 READY / endedAt=null、Daemon 已连接。Pending Switch、返回原 Harness 后新建的 NativeSession、CLOSED/INTERRUPTED、Daemon 重启和离线均不能使用旧命令；首次 `/` 不创建 Session、Prompt 或 Handoff。全局面板中的 **Initialize ACP session (no Prompt)** 复用现有 sessions 接口，只 initialize/new，已有 Handoff/活动操作/UNCERTAIN 保护不变。

输入触发区由 `textarea.getTextRange(0, cursorOffset)` 的真实光标前缀判断，只识别消息首 token；忽略普通文本/后续行/代码中的斜杠和多段路径。Bracketed paste 默认不打开候选。列表保留原始 name / description / input.hint，显示时仅前置 `/`。补全使用 OpenTUI `measureText` 原生显示偏移，只替换命令 token，保留参数与 undo。候选位于输入框上方，按终端可用高度限制，支持独立滚轮和自动滚入高亮项。

已发布命令经原 DraftSession.prepare → Draft CAS → requestId → turns → 原 Turn/审批/取消/UNCERTAIN 流程。新增可选 `nativeCommand: {nativeSessionId,name}`，作为同一提交的幂等内容落入 pendingSubmission 和 user.message；Runtime 在创建 Turn 前复核会话及最新发布列表，过期则 409，绝不重新选择 Session 执行。已接受 requestId 仍先按原幂等规则返回，不因后续 Session 失效而重放。

未知 `/xxx` 不自动发送。关闭候选后按发送，会进入明确的 **Unadvertised slash text** 选择：默认继续编辑；只有用户选 **Send original text as ordinary Prompt** 才发送原文，并明确告知可能触发模型 Turn / 已选目标 Handoff。不把它计作原生命令成功。ACP settings 入口明确标识为 **HarnessHub ACP settings**，不伪装成固定的 `/model` 或 `/permissions`。

真实 ACP PromptResponse 仍原样记录；已发布命令若没有文本/思考/工具/plan 可观察事件，补充 `runtime.command_result`，UI 明确提示返回的 stopReason 和“效果未确认”，不以 end_turn 推断命令已完成预期效果。

## 修改文件

| 文件 | 用途 |
| --- | --- |
| `apps/tui/src/index.tsx` | 顶层键盘路由、模态优先、palette 焦点恢复、显式初始化入口 |
| `apps/tui/src/agent-pane.tsx` | NativeSession 隔离、事件刷新、编辑器与候选接线、原文发送选择、受控发送 |
| `apps/tui/src/slash-commands.tsx` | 光标触发判断、名称筛选、原生描述/参数提示、可滚动鼠标候选 |
| `apps/tui/src/{clipboard,command-palette,source-viewer,delete-confirmation,native-events,changes-pane,transcript}.*` | 选区复制及事件传播、模态/浏览按键保护、无输出命令提示 |
| `apps/tui/src/draft-session.ts` | 同一 CAS/请求预留包含可选原生命令会话标识 |
| `packages/shared/src/{native-commands,runtime,session-state,index}.ts` | v1 命令投影、提交元数据、上下文快捷键校验 |
| `packages/core/src/runtime.ts` / `packages/storage/src/runtime.ts` | 快照持久化、发送前复核、可观察输出查询 |
| `scripts/{test.ts,verify-acp-commands.mjs}` | 标准回归入口、显式真实 ACP 无 Prompt 探针 |
| `tests/fixtures/mock-acp/server.mjs` | 可控制发布/替换/清空及无输出响应 |
| `tests/e2e/{slash-commands.test.tsx,slash-terminal.py}` | 真实 renderer/Daemon/SQLite/Mock ACP 与 Linux PTY |

## 自动化及 Linux PTY

14 项新增测试独立通过（最终 87 个断言，`/tmp/hhu-slash-ui-final.log`）。包括：

| 用户要求 | 证据 |
| --- | --- |
| `/`、`/co`、hint、Tab、Enter | 使用真实 OpenTUI renderer；候选选择后 **0 user Turn**，再次 Enter 后 **1 user Turn / 1 wire session/prompt**；重复相同 requestId 不增加 Turn |
| Esc 两步、空匹配 | 第一 Esc 只关候选，第二退出编辑，文本不丢；无匹配 Enter 不提交 |
| 字母/编辑、Ctrl+D、Ctrl+Y、换行 | 普通 m/a/h/c/x/f/p/n/o/q、delete、无选区 copy、↑编辑光标、Shift+Enter、Ctrl+J、中文/Emoji |
| Ctrl+P / Ctrl+B | palette 内 Ctrl+D 不切 Changes；关闭后相同草稿、原光标；sidebar 不改内容 |
| Ctrl+C 三态 | 编辑器有效选区先复制、有内容清空、空输入退出；Daemon 与原 NativeSession 保持 READY；不 cancel |
| `/path` 与多行粘贴 | 不打开候选/自动执行；Enter 默认不发，明确选择原文才发送一次，Unicode 原文一致 |
| 完整替换与清空 | publish → fresh 替换 → []；另一 Conversation 的 B 命令不变 |
| 多客户端与恢复 | 两个独立 WS 消费者同时更新；重开 TUI 从快照恢复；Daemon stop/start 重连且不重发 |
| A → B → A | pending 不出现源列表；另一客户端选定目标后源会话命令提交也被拒绝；返回 A 的新 NativeSession 不出现旧 fresh；旧 nativeSessionId 提交被拒绝 |
| 未初始化、未发布、已关闭 | 精确状态，显式初始化不产生 Turn；关闭/重启后保留历史快照但不可执行 |
| 长列表/鼠标/窄屏 | 高亮滚入、滚轮、点击补全不发送；35×12 resize 不崩溃 |
| 静默响应 | raw end_turn 响应保留；空文本 chunk 不算可观察输出，无输出状态明确为效果未确认 |

真实 Linux PTY 执行：

```bash
python3 tests/e2e/slash-terminal.py /home/clj/.local/bin/bun /home/clj/HarnessHub/HarnessHub/dist/cli/hhu.js
```

结果通过，最终证据 `/tmp/hhu-slash-pty-d49v1csx/{evidence.json,terminal.bin}`，日志 `/tmp/hhu-slash-pty-final.log`；首次通过证据 `/tmp/hhu-slash-pty-_dpibj0i` 同样保留。从 `/home/clj` 启动真实构建 CLI：`/rev` Enter 仅补全（0 Turn），下一 Enter 产生一次真实 Mock ACP Prompt；普通字母、完整 UTF-8 中文/Emoji、Kitty Shift+Enter 字节/Ctrl+J、Ctrl+P/B、Ctrl+C clear/exit 均正确。TUI 退出后 Daemon 与同一 NativeSession 存活。随后普通 stop 清理测试 Daemon，无 force。此处提供的 Kitty 字节不代表 Windows 物理 Shift+Enter 已验收。

开发时的失败已保留在 `/tmp/hhu-slash-ui.log`、`/tmp/hhu-slash-ui2.log`：补全的延迟 content-change 曾重新打开候选，已修复并复测；测试 helper `typeText` 按 UTF-16 单元拆分 Emoji，现以真实 UTF-8 bracketed paste 和 PTY 整段字节验证；测试双 renderer 共用 stdin 导致重复 `/` 的干扰已去除，两端独立 WS 状态同步断言保留。不以失败日志宣称通过。

## 真实 Harness 发布列表（本轮）

运行 `node scripts/verify-acp-commands.mjs`，四种 Harness 均成功 initialize/new；仅观察创建后 2 秒，未执行任何发布命令。使用原进程环境，由 Agent 自行读取其原生配置，探针不打开/复制/修改模型、Key、Base URL 或权限配置。无权限请求、无自动批准。证据目录及文件权限为 0700 / 0600。

完整原生 name / description / input.hint 及每次通知在 `/tmp/hhu-real-commands-rHVLND/evidence.json`；Codex 复核在 `/tmp/hhu-real-commands-Ny9KNN/evidence.json`。

| Harness / ACP 版本 | 实际 availableCommands |
| --- | --- |
| Codex adapter 2.5.0 | 两次 initialize/new 后观察窗口内均没有 available_commands_update；记录为未发布，不显示固定 CLI 命令；不推断以后不会更新 |
| Claude adapter 0.99.1 | 51 项，完整名称见下段；包括本机 Agent 实际暴露的动态命令，不能推广为所有安装的固定表 |
| Grok Build 1.0.70 (f50904eaee6c) | 9 项：compact、always-approve、context、session-info、feedback、deep-research、workflow、goal、loop |
| OpenCode 1.18.32 | 3 项：customize-opencode、init、review |

Claude 本轮完整名称：deep-research、design、design-sync、dataviz、update-config、verify、debug、code-review、simplify、batch、fewer-permission-prompts、doctor、loop、claude-api、workflow-authoring、run、run-skill-generator、plugin-authoring、advisor、agents、auto-mode-setup、autocompact、color、compact、config、output-style、context、effort、fast、focus、heapdump、init、import、model、__remote-workflow、workflow-launch-exec、reload-plugins、reload-skills、rename、security-review、usage、insights、recap、skill-doctor、goal、design-consent、design-revoke、list-agents、team-onboarding、mcp、remote-control。

Grok 的 always-approve、Claude 的 model 等只因本机 ACP 真实发布而被记录，探针没有执行；HarnessHub 不提供自己的自动批准逻辑。没有把原生 CLI 菜单里、ACP 未发布的命令补入列表。**发布验证不等于所有命令执行验证**，命令的副作用及实际响应以用户发送后的原生 ACP 为准。

本轮真实探针 **session/prompt=0**，没有意外向真实模型提交 Prompt；Linux PTY 的 1 条 Prompt 和所有复杂交互均使用隔离 Mock ACP。Codex 首次普通 shutdown 未确认；复核探针延长 drain 并以同一 Worker 句柄再次普通 stop，确认退出，无 force。Claude / Grok / OpenCode 普通 stop 均确认退出。原失败证据保留，不覆盖为成功。

## 标准检查

工具环境：Bun 1.4.4、Node v24.18.0、OpenTUI/Solid 0.8.0、原 lockfile；原生 CLI 版本附记：Codex CLI 0.166.0、Claude Code 2.1.311。当前执行 Shell 没有 Node PATH，验证命令显式增加 `/home/clj/.nvm/versions/node/v24.18.0/bin`，未修改用户 Shell 配置。

首轮完整回归 `/tmp/hhu-slash-full.log` 为 **84 Node + 63 TUI = 147 项，0 失败/跳过**。最后针对跨客户端 pending Harness 校验与空文本可观察性收紧后，14 项定向测试再次通过；最终完整回归 `/tmp/hhu-slash-full-final.log` 为 **84 Node + 64 TUI = 148 项，0 失败、0 跳过**，退出码 0，包含工作区同期 Enter 聚焦测试。

| 命令 | 最终结果 / 日志 |
| --- | --- |
| `bun run typecheck` | 通过，含 Daemon 独立 tsconfig；`/tmp/hhu-slash-typecheck.log` |
| `bun run lint` | 通过，84 个文件无诊断；`/tmp/hhu-slash-lint.log` |
| `bun run build` | 通过；`/tmp/hhu-slash-build-final.log`，完整 test 入口也重新构建 |
| `bun run test` | 148 项通过；`/tmp/hhu-slash-full-final.log` |
| `git diff --check` | 通过 |

原有鼠标侧栏、原生消息与思考/工具保真、审批、取消、WS 补拉、Handoff 去重/降级、UNCERTAIN、Worktree/删除保护和安装回归均保留且通过。真实 Harness 发布检查与 Mock/PTY 结果分开记录，未把命令发布当成全部原生命令执行成功。测试用的 PTY/定向 UI 隔离 Daemon 已普通停止，未覆盖用户项目文件或默认实例。

所有检查针对当前仓库构建，未替换用户全局安装，也未自动重启用户正在使用的 Daemon。人工验收请使用当前构建；旧运行进程不会因 `bun run build` 自动热更新。

## Windows Terminal / VS Code WSL 待人工验证

以下 **未验证**：物理 Shift+Enter/快捷键、中文拼音候选组合、终端系统剪贴板真实接收、两个 GUI 终端的鼠标/缩放。当前只有 Linux PTY 和 OpenTUI renderer，不能替代这部分验收。

请在两个终端分别记录版本、字体、尺寸和结果：

1. 创建 Conversation，显式 Initialize ACP session；核对 Agent 实际发布菜单与 Raw Events。Codex 未发布时显示准确空状态，不能用其 CLI 菜单对照伪造命令。
2. 输入 `/`、`/co`、无匹配前缀，Tab/Enter 只补全，下一 Enter 才发送；连按 Enter 核对没有重复 Turn；首次/第二次 Esc 分别关闭候选/退出编辑，草稿保留。
3. 物理 Shift+Enter、Ctrl+J、多行粘贴、Unicode/Emoji、中文拼音组合；IME 确认按键是否被终端消耗，输入法确认不能意外变成模型提交。终端没有向应用报告 composition 状态时，不能声称可在应用层完整识别预编辑状态。
4. 输入各普通快捷字母，Ctrl+D 编辑删除；Ctrl+P 查询/关闭和 Ctrl+B 开关侧栏后核对草稿与光标。Ctrl+Y 有选区复制、无选区不抢编辑；Ctrl+C 三态和拖选自动复制，实际粘贴核对系统剪贴板。
5. 长菜单滚轮、鼠标点击、35 列窄屏及更小高度、连续 Resize；候选在输入上方，输入不丢。首 token 之外的斜杠和粘贴 `/path` 不误执行；未知前缀仅在显式选原文后发送。
6. 选择其他 Harness 后输入 `/`，不得显示源列表或启动 Handoff；目标首条普通消息后才交接。返回 Harness、新 Session、另一个 Conversation、双 TUI、重连/Daemon 重启分别核对隔离与失效提示。
7. 真实无害任务在后台运行时退出 TUI，再连接查看同一 Worker/历史；审批只能由用户按 Agent 选项决定。所有危险或设置类发布命令的真实执行本轮未测试。

没有新增依赖、Web UI、CLI 键盘注入执行器、独立 ACP Runtime、下一阶段或原生配置管理。沿用现有 TUI 风格；仓库没有 PRODUCT.md，未据此阻断定向修改，可在另一个设计任务中使用 `$impeccable init` 记录设计约定。
