# Phase 6 工具详情点击展开

日期为 2026-11-09。本次实施当前阶段的会话工具交互修正。

## 实现

- 工具下方的 `+ Show details`、`+ N lines` 支持鼠标左键点击，展开已有的命令、正文、终端输出和内联 Diff。展开后的 `− Show less` 支持点击收起。
- 点击选中对应工具，复用键盘展开使用的手动状态。多个工具各自展开，状态更新和面板重新挂载后保留选择。
- 复用已有的鼠标点击识别，右键、拖动和滚动不会触发展开。交互标签禁止文本选择，正文仍可选择复制。
- 聊天输入聚焦时可以直接点击详情，草稿和编辑器焦点保持。来源视图及其他弹窗打开时由弹窗接收交互。

## 文件

- `apps/tui/src/rich-content.tsx` 为两种详情标签及收起标签绑定点击识别。
- `apps/tui/src/native-events.tsx` 将点击接到对应工具的选择和手动展开状态。
- `apps/tui/src/agent-pane.tsx` 分开控制历史键盘操作和详情鼠标操作，允许输入时点击。
- `tests/e2e/agent-output.test.tsx` 覆盖宽窄布局、两种展开标签、点击收起、键盘操作、工具隔离、右键及拖动、状态更新和重新挂载。
- `tests/e2e/phase4.test.tsx` 使用隔离 Daemon 与 Mock ACP 验证完整 App 入口，覆盖输入聚焦、草稿保留、命令面板以及没有额外提交用户消息。

## 自动化验证

- `bun test tests/e2e/agent-output.test.tsx` 通过，6 项测试、176 个断言。
- `bun test tests/e2e/phase4.test.tsx -t 'tool detail clicks'` 通过，1 项测试、7 个断言。日志保存在 `/tmp/hhu-click-details-app-test.log`。
- `bun run typecheck`、`bun run lint`、`bun run build` 和 `git diff --check` 通过。
- `umask 022; bun run test` 完整入口通过，101 项 Node 集成测试、99 项 Bun/Solid 界面测试，均为零失败。界面测试共 1359 个断言，完整日志保存在 `/tmp/hhu-click-details-full-test.log`。完整入口包含构建，测试使用隔离的临时数据目录。

## 未验证与人工验收

本轮 Windows Terminal 和 VS Code WSL 的物理鼠标操作、真实 ACP Agent 未验证。自动化使用真实 OpenTUI renderer 和 Mock ACP。

1. 更新安装后打开有工具记录的会话，点击 `+ Show details`，核对展开的命令和输出，再点击 `− Show less` 收起。
2. 找到带 `+ N lines` 的工具，点击后核对省略内容可查看，多个工具的展开选择相互独立。
3. 输入草稿后直接点击工具详情，核对草稿保留且消息没有发送。切换 Changes 再返回，核对展开选择保留。
4. 在正文中拖动选择、滚动历史及打开命令面板，核对详情没有误展开。

全局安装更新通过 `bun run install:local` 执行，遵循 `docs/OPERATIONS.md` 中的安全停机和发布流程。
