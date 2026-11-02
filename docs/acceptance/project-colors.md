# 会话列表项目配色验收

日期：2026-11-01。当前 MVP 的界面调整，不进入新阶段。

## 变更

- `apps/tui/src/index.tsx`：项目名使用青绿色 `#80cbc4` 并加粗；普通会话使用浅色 `#e6edf3`。项目选中后仍保留青绿色。
- OpenTUI 0.8 的 SelectOption 不支持逐项配色，因此使用 scrollbox 和逐行文本渲染。保留两行布局、项目路径、会话状态、方向键导航、选中背景和选中行滚动定位。
- 本提交只包含配色实现及本记录，不包含工作区同时开发的折叠、鼠标操作、项目删除或归档调整；无依赖、数据库或 ACP 改动。

## 验证

从提交 `eabcab3` 创建隔离工作区，仅应用上述改动后执行：

- `bun install --frozen-lockfile`、`bun run build`、`bun run typecheck`、`bun run lint`、`git diff --check`：通过。
- 真实 OpenTUI/Solid renderer + 临时 Daemon/SQLite 检查：项目选中及未选中时均为青绿色加粗，会话为浅色；18 行树的首尾导航、选中背景、窄屏隐藏及放宽恢复通过。不发送 Agent Prompt。
- `bun test tests/e2e/tui.test.tsx tests/e2e/phase4.test.tsx tests/e2e/phase5.test.tsx`：32 项通过、0 失败，日志 `/tmp/hhu-project-colors-isolated-ui.log`。
- `bun run test` 的 Node 集成部分：76 项通过、3 项失败，日志 `/tmp/hhu-project-colors-isolated-test.log`。Phase 3 并行用例访问尚未提供的 `capabilities.session._meta` 失败，随后草稿重启用例因仍有活动 Turn 无法停止 Daemon；Phase 5 删除会话用例遇到 Handoff Worker 清理保护（HTTP 409）。完整命令因此未通过，未将它记为全绿。
- 单独复查 Phase 5 失败用例通过（1 项），日志 `/tmp/hhu-project-colors-worktree-recheck.log`；完整重跑 Phase 3 仍有上述两项失败，日志 `/tmp/hhu-project-colors-phase3-recheck.log`。没有修改这些测试断言或生产 Runtime。最初单独运行草稿用例因缺少前置用例初始化无效，随后改为运行完整 Phase 3 文件。

首次在原工作区验证时，还遇到并行树形列表和删除界面调整导致的 3 项界面测试失败，原日志 `/tmp/hhu-project-colors-test.log` 保留；本次推送以隔离工作区的实现和验证为准。

## 用户待验收

Windows Terminal / VS Code WSL 的实际主题及显示效果未验证。重新打开 `hhu`，检查项目名为青绿色加粗、会话为浅色；上下切换选中项后应仍可区分项目和会话。
