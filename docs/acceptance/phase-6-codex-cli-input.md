# Phase 6 Codex CLI 键位与运行中消息

> 2026-11-09 更正：本记录中 HHU 本地 slash 入口已取消，改用 Commands 面板、按钮和快捷键。聊天 `/` 仅补全当前 Harness 的 ACP 命令，不覆盖原生命令语义；详见 [原生命令分离验收](phase-6-native-slash-commands.md)。其余历史测试结果不代表本次变更已验收。

2026-11-05，当前阶段的交互与可靠性修正。

## 交互

Enter 追加、Tab 排队以及历史搜索和回复复制采用 Codex CLI 的公开交互定义。[OpenAI CLI 参考](https://learn.chatgpt.com/docs/cli/reference)

- 移除原有项目、会话、Harness、审批、Changes、工具详情等默认专用 Ctrl 组合。现有用户显式配置继续生效，`/keymap` 可设置覆盖，空字符串解除绑定，空对象恢复默认。
- Enter 发送，运行中 Enter 请求原生 steering，Tab 排队。Shift+Enter 换行，Ctrl+J 备用换行。
- Esc 优先关闭命令候选或顶层弹窗，普通聊天中的 Esc 发送 ACP cancel，保留输入。取消等待原生最终响应及尾部事件。
- ↑↓ 浏览已发送输入，Ctrl+R 搜索消息历史，Ctrl+O 复制最近已完成 Turn 的 Agent 文本或当前选区，Ctrl+T 进入/离开聊天历史。历史中 ↑↓ 选择、Enter 展开、End 返回最新项。
- `/new`、`/resume`、`/diff`、`/model`、`/permissions`、`/copy`、`/quit`、`/exit`、`/keymap` 以及 HarnessHub 的 `/project`、`/sidebar`、`/harness`、`/approval`、`/handoff`、`/queue` 提供操作入口。浏览时 `/` 打开命令面板，空输入框 `?` 显示帮助，顶部 Commands 和侧栏操作也可点击。
- 已发布的原生 slash 命令优先，命令名称、参数提示及描述保留原文。Tab/Enter 补全不提交任务，未发布的 slash 文本仍须明确确认才发送。

本次对齐 HarnessHub 已有功能的按键与消息交互。Codex 的双 Esc 历史分叉、外部编辑器、附件与本地 shell 输入等独有功能没有在本轮扩展。

## 投递与持久化

- 新增 `PendingInputs`，复用 SQLite 原始/结构化事件日志保存每条输入及 QUEUED、HELD、SENDING、SENT、ERROR、UNCERTAIN、CANCELLED 状态，数据库保持 schema 6。
- 原生 steering 只信实际 initialize 的 `_meta.steering.supported`。请求使用 `_session/steering` 和 `_meta.steering.idleBehavior=promptRequired`。锁内 Codex ACP 2.5.0 声明该能力，空闲竞态由宿主创建下一轮，单 Conversation 仍只有一个活动开发 Turn。
- Agent 没有声明 steering 时，输入框及消息状态明确显示排队降级。普通排队输入按 FIFO 在正常完成后投递，TUI 退出后由 Daemon 继续处理。
- 取消、准备失败、Harness 选择变化及 Daemon 重启暂停未投递输入，`/queue` 明确恢复、编辑或移除。切回原 Harness 后才允许恢复其队列。
- 接受输入前持久化 requestId，草稿沿用 CAS 和 pendingSubmission。重复 POST、重复恢复、WS 补拉和重新打开 TUI 不重复执行。队列预留的 requestId 也不能被其他 Conversation 的普通 Turn 复用。
- 发送后连接丢失或结果未知记为 UNCERTAIN，阻止后续自动投递和不安全删除。权限请求保持原始选项，追加消息和排队都不会批准权限。
- 新增 GET/POST `/v1/conversations/:id/inputs`、POST `/inputs/resume`、DELETE `/inputs/:requestId`。`/v1/requests/:requestId` 可查询尚未变成 Turn 的输入。

## 文件

- `packages/core/src/pending-inputs.ts`、`runtime.ts`、`handoff.ts` 处理队列、能力判断、投递、取消、恢复及切换边界。
- `packages/storage/src/runtime.ts` 从 SQLite 事件日志重建输入状态。`packages/shared/src/runtime.ts`、`session-state.ts` 定义投递字段、状态和默认键位。
- `apps/daemon/src/runtime-routes.ts` 提供输入 API。`apps/tui/src/draft-session.ts` 保留输入投递方式和原 requestId。
- `apps/tui/src/local-commands.ts`、`agent-pane.tsx`、`index.tsx`、`shortcuts.ts`、`slash-commands.tsx`、`command-palette.tsx`、`native-events.tsx`、`changes-pane.tsx`、`project-directory.tsx`、`transcript.ts` 调整交互、提示、历史和队列管理。
- `tests/integration/pending-inputs.test.mjs` 增加 10 项隔离 Mock ACP 集成测试，`tests/e2e/codex-inputs.test.tsx` 增加 3 项交互测试。已有回归通过命令面板、标准历史导航及 Source/Raw 控件操作，保留权限、去重、输出保真、复制和后台存活断言。
- `tests/e2e/ui-actions.ts` 集中测试中的命令与焦点操作。Linux PTY 脚本使用新入口，运行中编辑测试等待输入焦点提示后输入文字。
- `README.md`、架构输入规范、操作指南和双终端清单同步当前行为。共享工作区中另一个任务的 UI 层级、色板及组件修改被保留，本轮验证使用合并后的实际代码。

## 真实验证与待验收

- Linux PTY 的 `slash-terminal.py` 已通过，从 Home 启动，补全零 Turn、显式发送一次、Unicode/换行、命令面板与侧栏保留草稿、Ctrl+C 清空/退出及 Daemon/Session 保活。证据 `/tmp/hhu-slash-pty-2586a_80`，日志 `/tmp/hhu-codex-slash-pty-final.log`。
- 真实 Codex initialize 通过，并实际返回 `steering.supported=true`。`session/new` 等待 20 秒超时，没有发送 Prompt，隔离 Daemon 合作式停止。真实 steering、队列与取消本轮未验证。证据 `/tmp/hhu-real-inputs-F8p1Us/evidence.json`，日志 `/tmp/hhu-real-inputs.log`。没有读取或修改原生模型、API Key 或 Base URL 配置。
- Windows Terminal / VS Code WSL 的物理 Esc、Tab、Shift+Enter、Ctrl+R、Ctrl+O、Ctrl+T 和系统剪贴板未验证，按双终端清单执行。
- 本轮构建产物为 `dist/cli/hhu.js`。全局 `hhu` 仍指向既有发布目录，本轮没有进行用户级安装或重启默认 Daemon。

真实 Agent 手动步骤如下。

1. 更新用户级安装后，在临时项目中选 Codex，发送一个包含可观察等待过程的无害读取任务。
2. 运行时输入补充约束并按 Enter，确认本次任务收到约束，原生 Session 和活动 Turn 连续。
3. 输入第二条独立请求并按 Tab，确认正常结束后只发送一次。检查 SQLite/Raw 中的原始请求和 requestId。
4. 再运行等待任务并排队，按 Esc，确认尾部事件保留、队列暂停、输入草稿保留。通过 `/queue` 明确恢复。
5. 测试未声明 steering 的 Agent，确认界面明确显示排队。测试真实原生审批，不选择时必须持续等待。

## 自动化结果

- `bun run typecheck`、`bun run lint`、`bun run build`、`git diff --check` 通过。
- `umask 022; bun run test` 单次完整入口通过，94 项 Node 集成测试、86 项 Bun/OpenTUI 测试，共 180 项，0 失败、0 跳过。TUI 共 1117 个断言。日志 `/tmp/hhu-codex-verified.log`，队列集成证据 `/tmp/hhu-inputs-` 开头的私有临时目录以日志为准。
- 新增 10 项集成测试覆盖原生 steering、FIFO、无能力降级、取消与尾部事件、原生权限、空闲竞态、ACK 丢失、崩溃恢复、Harness 切换及跨会话 requestId 冲突。
- 3 项新增交互测试覆盖运行中 Enter/Tab、候选与导航状态的 Esc 优先级、草稿保留、显式恢复、移除默认专用键、原生编辑、无 Prompt 的本地命令、历史搜索及 Ctrl+T。最终定向复核 3/3，通过 16 个断言，日志 `/tmp/hhu-codex-inputs-final.log`。
- `python3 tests/e2e/slash-terminal.py /home/clj/.local/bin/bun /home/clj/HarnessHub/HarnessHub/dist/cli/hhu.js` 通过，日志和证据见真实验证段。
- 完整入口通过后，补齐 Ctrl+T 从 Changes 返回聊天的行为及专项检查，后端源码无后续修改。最终再跑 typecheck、lint、build 与全部 86 项 TUI 回归，86/86、1117 个断言通过，日志 `/tmp/hhu-codex-release-ui.log`。最终构建的 Linux PTY 复核也通过，证据 `/tmp/hhu-slash-pty-vrc2539e`，日志 `/tmp/hhu-codex-release-pty.log`。
- 开发中的旧键位回归先失败，已将操作改为新的可见入口，并保留原行为断言。早期完整入口的集成段曾为 93/94，PTY 用导航提示作为输入焦点的就绪条件，合并 Enter 与后续文字导致草稿检查失败。脚本现明确等待 Shift+Enter 编辑提示后输入，定向 Phase 4 为 8/8，随后完整入口为上述 180/180。没有删除或跳过故障用例。
