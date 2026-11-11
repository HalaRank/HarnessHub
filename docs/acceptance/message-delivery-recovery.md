# 消息排队与中断后继续

2026-11-11，阶段 6 与 Desktop Phase 4 的发送流程修正。

## 问题定位与参考

用户截图中的 `daemon_restart` 表示 Daemon 重启后，旧 Turn 的执行结果已记为 `UNCERTAIN`。原实现禁止该 Conversation 的后续提交，恢复入口也排除了 `UNCERTAIN`，导致用户输入新的“继续”消息时只能得到阻塞提示。截图无法证明 Daemon 当时为何重启。

TUI 已有运行中 Enter steering 与 Tab 排队入口。Desktop 的 Composer 将活动 Turn、审批和全部 pending inputs 都纳入禁用条件，Main 又明确拒绝带 delivery 的请求，运行中发送无法到达已有 Daemon 队列。Snapshot 还只包含 SENDING 与 UNCERTAIN，缺少待发消息的显示数据。

本轮核对了 Codex CLI 官方快捷键说明和公开源码。运行中 Enter 追加指令，Tab 排队。源码中的 input queue 分别保存待发消息和 pending steers，投递回执使用消息身份进行核对。HarnessHub 继续使用 ACP 与自身 SQLite 事件日志承载这些交互。

- [Codex CLI 官方快捷键说明](https://learn.chatgpt.com/docs/cli/reference#interactive-shortcuts)
- [Codex CLI input_queue.rs](https://github.com/openai/codex/blob/main/codex-rs/tui/src/chatwidget/input_queue.rs)
- [Codex CLI input_submission.rs](https://github.com/openai/codex/blob/main/codex-rs/tui/src/chatwidget/input_submission.rs)

## 实现

- Desktop 运行中 Enter 通过已协商的 steering 能力追加输入，Tab 或排队按钮持久化后续消息。缺少 steering 能力时显示排队提示。图片输入作为后续 Turn 排队，原始附件保留。
- Desktop Main 按 delivery 转发到既有 inputs API，保留草稿 CAS、requestId 和确定拒绝后的草稿恢复。Snapshot 增加 QUEUED、HELD、ERROR，输入区可查看待发消息、移除未投递消息及恢复暂停队列。
- SENDING 期间仍可接受后续待发消息。Daemon 串行投递，继续保持每个 Conversation 至多一个活动开发 Turn。
- 取消或恢复后，已有 HELD 消息构成队列边界。新消息加入暂停队列，用户明确恢复后按 FIFO 执行。中断原生上下文须先处理恢复，再恢复队列。
- TUI 在中断会话中按 Enter 打开继续确认，Desktop 提供同一操作。确认后创建新的 NativeSession，保留应用聊天历史与草稿，草稿须再次提交。
- 恢复接口增加显式 acknowledgeUncertain。旧 Turn 继续保留 UNCERTAIN。旧 steering 投递以新的 ACKNOWLEDGED 日志事件记录用户已核查未知结果，原有 UNCERTAIN 事件及 requestId 保留，重复提交旧 requestId 仍返回原记录。
- 恢复期间预留 Conversation，阻止并发发送与恢复。受控旧 Worker 在确认路径关闭，创建新 Worker 前检查 Daemon 关闭状态。跨 Daemon 缺少受控句柄且缺少退出证据时，用户须确认已检查并结束旧任务，应用单独记录该确认及真实退出证据。
- TUI 未确认请求重试保留原始 delivery 和 nativeCommand。普通 Turn 已被接受但 ACK 丢失、界面状态已变为 RUNNING 时，仍以原请求身份核对，避免误改成新的 steering 输入。
- Desktop 未确认提交增加显式检查后重试。先查询 requestId，已接受的请求按历史核对，未记录的请求复用原 requestId 和完整内容重试。网络错误继续保留预留身份，确定拒绝后释放预留并保留文字。
- 原生权限选项继续由用户选择。队列发送、重连、继续确认均沿用已有原生权限流程。

## 变更文件

- `packages/core/src/runtime.ts`、`pending-inputs.ts`、`packages/shared/src/runtime.ts`、`packages/storage/src/index.ts`、`apps/daemon/src/runtime-routes.ts`
- `apps/tui/src/agent-pane.tsx`
- `apps/desktop/src/contracts.ts`、`main/actions.ts`、`renderer/Composer.tsx`、`renderer/drafts.ts`、`renderer/style.css`
- `tests/integration/pending-inputs.test.mjs`、`tests/integration/desktop.test.mjs`、`tests/e2e/codex-inputs.test.tsx`、`apps/desktop/tests/chat.test.tsx`

## 验证

- `bun run typecheck`、`bun run lint`、`bun run build`、`bun run desktop:build`、`git diff --check` 通过。最终构建日志分别为 `/tmp/hhu-send-typecheck.log`、`/tmp/hhu-send-lint.log`、`/tmp/hhu-send-build.log`、`/tmp/hhu-send-desktop-build.log`。Desktop 构建产物在 `/tmp/hhu-desktop-build-FNBhI7`。
- 标准 `bun run test` 通过，包含 122 项 Node 集成测试与 124 项 TUI 测试，0 失败、0 跳过。日志 `/tmp/hhu-send-final-test.log`。新增图片排队、Daemon 重启后显式继续、未知投递核查、暂停队列 FIFO 及并发恢复断言均通过。
- 完整入口结束后补齐普通 Turn 丢 ACK 时的投递模式保留回归。最终重新构建并执行全部 13 个 TUI 测试文件，125/125、1733 个断言通过，0 失败。日志 `/tmp/hhu-send-tui-final.log`。Daemon 源码在上述完整入口后没有修改。
- `cd apps/desktop && bun test tests` 通过，70/70、417 个断言。日志 `/tmp/hhu-send-desktop-unit.log`。
- `HARNESSHUB_BUN=/home/clj/.local/bin/bun node --test tests/integration/desktop.test.mjs` 通过，19/19。测试前按现有 Desktop 测试脚本将 Main connection 编译到 `dist/desktop/test`，日志 `/tmp/hhu-send-desktop-integration.log`。新增用例通过 typed action 提交运行中消息、检查 Snapshot 队列、移除未发送项、取消、明确恢复并核对一次性投递。
- 最终各测试集合合计 336 项通过。测试中的 Desktop 连接就绪等待与投递后从 input 日志读取状态两处断言已修正，保留完整场景。
- 本地 Chromium 使用真实 Composer 与模拟 DesktopApi 验证 Enter、连续两次 Tab、队列显示、恢复确认、草稿保留和恢复零自动提交。1100px 与 390px 视口通过，水平溢出为 false，页面错误为零。临时证据 `/tmp/hhu-send-browser/evidence.json` 与同目录 PNG。
- 真实 Codex ACP initialize 成功，返回 steering.supported=true 与 loadSession=true。session/new 在客户端等待期间超时，未发送 Prompt，隔离 Daemon 已停止。真实 Agent 的 steering、排队投递及恢复仍为“未验证”。证据 `/tmp/hhu-real-send-4Fcu6T/evidence.json`。
- 沙箱内集成测试启动遇到 spawnSync EPERM，已通过允许本地子进程与回环监听的测试执行方式完成后续验证。Desktop 单元测试使用 apps/desktop 工作目录，以加载 React 专用配置。

## 限制及待验收

当前继续入口创建新原生上下文。原生 session/load 的实际恢复尚未验证，应用历史保留在 Conversation 中。新原生上下文需要用户提供后续任务所需背景。

存在未解决 Handoff 或仍在收尾的投递、审批、配置操作时，恢复接口继续返回冲突。用户应先处理相应操作。

本轮未更新用户级全局 hhu 安装，未替换已安装 Windows App，未重启用户默认 Daemon。Windows Electron 与物理 Windows Terminal / VS Code WSL 键盘行为未验证。

手动验收步骤如下。

1. 使用包含本轮修改的构建，在临时项目中启动一个可观察的真实 ACP Turn，运行中 Enter 追加限制，Tab 连续排队两条消息，确认完成后按顺序只执行一次。
2. 再次排队后取消当前任务，确认后续消息暂停。输入新的消息，检查它加入同一暂停队列，明确恢复后核对顺序。
3. 在隔离测试会话制造中断，检查旧执行与工作区。TUI 输入后按 Enter，Desktop 点击继续入口，确认并创建新上下文。检查历史和草稿保留，再明确发送新消息。
4. 在请求确认丢失时查询原 requestId，验证显式重试已接受请求只核对历史。对尚未记录的请求，验证重试沿用原 requestId。
5. 在 Windows App 和两种目标终端核对中文输入法、Enter、Tab、Shift+Enter、审批等待及窄屏队列显示。
