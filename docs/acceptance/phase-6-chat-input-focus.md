# 阶段 6 补充验收：点击聊天主区域激活输入

日期：2026-11-02。本次仅修复现有 MVP 的鼠标输入焦点，不开启新阶段，保留工作区已有及并行修改。

## 行为与文件

- `apps/tui/src/agent-pane.tsx`：在聊天主区域统一处理左键按下，点击用户/Agent 消息、消息区空白或输入框边框即可进入输入态，并将光标放在草稿末尾；直接点击输入文字仍按点击位置定位。消息区点击不发送消息。
- 弹窗、审批输入、设置、尚未加载草稿或正在处理操作时，不从主区域抢占输入态；右键和滚轮不触发输入激活。Changes 内容不触发激活，Changes 视图下输入框和边框仍可点击输入。保留原生拖选事件，不消费鼠标拖动与松开事件；Enter 发送、Shift+Enter 换行逻辑不变。
- `tests/e2e/chat-input-focus.test.tsx`：使用真实 OpenTUI renderer 和内存草稿请求替身，不启动 Daemon 或访问真实 Agent。覆盖空白点击、输入框边框、中文/Emoji 草稿末尾输入、文字点击定位、弹窗保护、右键/滚轮、Shift+Enter 及 Changes 隔离。
- `tests/e2e/mouse-sidebar.test.tsx`：新增隔离 Daemon / Mock ACP 场景，覆盖用户及 Agent 消息点击、草稿恢复、侧栏切换、弹窗、零误发和后续 Enter 提交；更新既有拖选用例，聊天拖选后已经处于输入态，无需额外输入消息快捷键。本轮此文件未完成执行。
- `scripts/test.ts`：将离线焦点用例纳入标准 runner；`docs/acceptance/phase-6.md` 关联本记录。

## 验证

- `bun test tests/e2e/chat-input-focus.test.tsx tests/e2e/chat-scroll.test.tsx tests/e2e/agent-output.test.tsx`：7 项通过、0 失败，118 个断言；日志 `/tmp/hhu-chat-click-focus-render-tests.log`。同时回归滚动与原生输出样式，不将这些渲染测试当作真实 ACP 验证。
- `bun run typecheck`、`bun run lint`、`bun run build`、`git diff --check`：通过；日志 `/tmp/hhu-chat-click-focus-{typecheck,lint,build}.log`。
- `bun test tests/e2e/mouse-sidebar.test.tsx`：沙箱内测试 Daemon 启动失败，未进入交互用例；两次沙箱外权限请求均超时，未获执行。日志 `/tmp/hhu-chat-click-focus-test.log`。没有绕过审批或连接默认用户 Daemon。
- 开发检查发现并修正 composer 测试标识位置、测试类型导入路径及事件处理器 lint 问题。额外尝试对无消息占位文本拖选，但该占位文本不可选择；移除该无效断言，不将其计入历史消息拖选验证。

## 推送前复核（2026-11-02）

- `umask 022; bun run test` 的构建及全部 **84/84 集成测试通过**；首轮 TUI 为 73/78，通过日志 `/tmp/hhu-push-test.log`。发现点击聚焦时 `gotoBufferEnd()` 会清除 OpenTUI 已开始的历史选区，已改为直接移动编辑缓冲区光标，保留拖选、双击及三击复制。
- 修正测试同步：Esc 后完成渲染再设置历史滚动；导航工具选择后完成渲染再展开；Changes 刷新等待 Diff 加载后查看；Emoji 输入按 Unicode 字符发送，避免 Mock 输入工具按 UTF-16 拆分字符。
- 最终独立重跑标准 runner 的全部 9 个 TUI 测试文件：**78/78，通过 1111 个断言**，日志 `/tmp/hhu-push-ui-suite.log`。`bun run typecheck`、`bun run lint`、`bun run build`、`git diff --check`、`bun install --frozen-lockfile` 均通过。集成之后的修正仅涉及 TUI 和测试，集成结果与最终 TUI 结果分开记录。
- 完整 Daemon / Mock ACP 鼠标回归及历史拖选复制本轮已验证；下方原始受阻记录保留作历史。真实 Agent 和目标 Windows GUI 终端仍未验证。

## 未验证与人工步骤

- 真实 ACP、Windows Terminal / VS Code WSL 的物理鼠标及键盘本轮仍**未验证**。完整 Daemon / Mock ACP 鼠标回归和历史消息拖选复制已通过上述推送前复核。
- 在两种终端打开现有会话，分别点击用户消息、Agent 消息、消息区空白和输入框边框后直接打字；检查文字追加到草稿末尾、未误发送。直接点击草稿中间应仍可定位编辑；拖选历史仍可复制，滚动与右键不应自动进入输入态。
- 打开命令面板、审批或详情后点击背景，焦点应留在当前操作中；切换会话应保留独立草稿。Shift+Enter 换行，下一次 Enter 仅发送一次；Changes 内容不抢焦点但输入框可点击。
- 未更新全局安装、未停止默认 Daemon、未修改默认用户数据库。全局 `hhu` 需按 `docs/OPERATIONS.md` 的安全升级流程更新后再验收。
