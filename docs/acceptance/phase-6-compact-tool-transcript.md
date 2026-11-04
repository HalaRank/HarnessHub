# Phase 6 定向修正：紧凑工具摘要

日期：2026-11-04。按用户提供的本地 Codex 截图调整当前阶段的聊天展示，不实施新阶段。

## 展示规则

- 工具标题限一行，过长横向截断，不再把整个多行 shell / apply_patch 脚本当标题铺满聊天。保留原生标题内容，不将工具重命名或生成 AI 摘要。
- 真实状态与标题同行，使用原有状态色；等待审批仍有原生选项及明确的用户决策提示。
- 原生 ACP 文本内容及已收集的终端输出默认只显示末尾三行，每行不换行铺屏；多余部分显示 `+ N lines`，没有文本预览时显示 `+ Show details`。
- Ctrl+E 展开命令、文本、终端输出和 Diff；尊重用户手动展开状态。展开仍有预览长度限制，完整原文始终可在 Ctrl+Y 查看和复制。
- 普通聊天及展开的工具内容都不再显示 Parameters / Result 的 JSON、terminal 信息/退出元数据、未知协议块的 JSON、review ID 或重复的工具名称。
- 聊天各行不再显示事件序号；工具不再有独立的 `status · expand/collapse` 行、整块左边框或默认重复的 Native details 提示。改为淡灰 `└` 输出缩进和统一底栏快捷键。
- Ctrl+R 的原始事件和 Ctrl+Y 的完整原文仍保留原始工具名称、参数、结果、终端 ID、序号及结构化数据；仅改变展示，源事件不变，不丢弃历史，不推断工具状态。
- Agent 正文、Markdown、公开思考及审批行为不做语义重写；不修改 Agent 配置、数据库、Daemon 生命周期，不自动批准或重发任何 Turn。

## 文件

- `apps/tui/src/native-events.tsx`：工具单行标题/状态、移除聊天事件编号及重复提示，接入紧凑/展开视图。
- `apps/tui/src/rich-content.tsx`：三行输出预览、行数提示、正文展开；协议元数据仅留来源查看器。
- `tests/e2e/agent-output.test.tsx`：宽/窄屏长命令与长输出回归、原始数据保真、状态/审批及展开行为。
- `tests/e2e/phase4.test.tsx`、`tests/e2e/mouse-sidebar.test.tsx`：不再依赖调试字段或旧提示文案判断展开。
- `README.md`、架构及 Phase 6 记录：更新当前展示约定。

## 验证

- `bun test tests/e2e/agent-output.test.tsx tests/e2e/shortcuts.test.ts`：7/7 通过，671 个断言；覆盖 100 / 32 列、长多行命令、200 行终端输出、状态与审批、源事件不变及详情入口。
- `bun run typecheck`、`bun run lint`、`bun run build`、`git diff --check`：通过。
- 全部界面回归首轮 78/80：两处既有测试仍等待已移除的 `Result` 和 `completed · Ctrl+E expand/collapse`。现分别改为在来源视图验证原始输出的鼠标复制、使用真实工具标题/状态等待渲染；日志 `/tmp/hhu-compact-tool-ui.log`。
- 按 `scripts/test.ts` 相同的 9 个文件清单重跑全部界面回归：**80/80 通过，1250 个断言，零错误**；日志 `/tmp/hhu-compact-tool-ui-final.log`。只在测试子进程使用 `umask 022`，使用隔离 Daemon / Mock ACP，不操作默认用户实例。
- 发布前执行 `umask 022; bun run test`：完整入口单次全绿，Node 集成 **84/84**、界面 **80/80**（1250 个断言）；日志 `/tmp/hhu-release-full-test.log`。`bun run typecheck`、`bun run lint` 再次通过，日志分别为 `/tmp/hhu-release-typecheck.log`、`/tmp/hhu-release-lint.log`。
- 本轮没有重跑物理终端 PTY 或真实 Agent，不以此前的通过结果冒充本轮验证。

## 待人工验收

- 真实 Agent、Windows Terminal / VS Code WSL 物理终端本轮**未验证**。本轮自动化使用真实 OpenTUI renderer 和 Mock ACP，不代表真实模型兼容性通过。
- 更新安装后打开用户所述历史：长 apply_patch / shell 调用不再铺满标题；工具只显示简短调用与少量正文，Guardian Review 不直接打印 JSON。
- Ctrl+E 展开/折叠，Ctrl+R 核对原始事件，Ctrl+Y 复制完整命令和输出；核对行数省略没有改变源数据，失败/等待审批仍醒目且原生选项可操作。
- 展示修正和自动化测试不替换全局 `hhu`、不停止默认 Daemon。后续按用户要求发布安装时，仍遵守 `docs/OPERATIONS.md` 的安全流程，活动任务不强制取消。
