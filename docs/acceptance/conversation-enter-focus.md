# 会话 Enter 输入焦点定向验收

本次属于现有 MVP 的交互修复，不开启新阶段。已阅读架构、实施计划及现有 Phase 6 / 输入快捷键验收记录；在工作区已有 Slash Commands 改动上增量修改。

## 行为与文件

- `apps/tui/src/agent-pane.tsx`：无弹窗、未进入输入态时，Enter 进入当前会话输入框，并通过 OpenTUI `gotoBufferEnd()` 将光标放到完整草稿末尾；消费此次按键，避免同一次 Enter 发送草稿。草稿异步加载后创建编辑器时，同样处理已请求的输入焦点。输入提示补充 Enter 入口。
- 已处于输入态的 Enter 继续走原发送 / Slash 补全逻辑；Shift+Enter 继续换行。保留原有 `m` 入口的选区行为，避免影响 Ctrl+C 复制。
- `tests/e2e/mouse-sidebar.test.tsx`：真实 OpenTUI renderer 和隔离 Daemon / Mock ACP 回归覆盖空输入、退出编辑后重新进入、多行中文 / Emoji / 组合字符、切换会话后恢复草稿、首次 Enter 零发送、Shift+Enter 换行及下一次 Enter 只发送一次。

## 验证

- `bun test tests/e2e/mouse-sidebar.test.tsx`：8 通过、0 失败，48 个断言；日志 `/tmp/hhu-enter-focus-ui-final.log`。
- 首轮定向测试发现测试 helper 把 `pressKey("return")` 输入为普通文本，以及共用 `m` 末尾定位会影响选区复制；已改用 `pressEnter`，并限定 Enter 执行末尾定位，上述 8 项复测全部通过。失败日志保留在 `/tmp/hhu-enter-focus-ui.log`。
- `bun run typecheck`、`bun run lint`、`bun run build`、`git diff --check`：最终检查全部通过；对应日志 `/tmp/hhu-enter-focus-{typecheck,lint,build}-final.log`。
- `bun run test`：84 项 Node 集成测试 + 64 项 Bun / Solid UI 测试，共 148 项通过、0 失败、0 跳过；UI 共 449 个断言。完整日志 `/tmp/hhu-enter-focus-full.log`，其中包含本次新增的 Enter 交互回归。

## 用户待验收

Windows Terminal / VS Code WSL 物理终端本轮未验证。手动步骤：选中一个有多行草稿的会话 → Enter → 确认焦点在输入框且光标位于最后一行末尾、草稿没有发送 → 输入文字确认追加到末尾 → Shift+Enter 确认换行 → Enter 确认按原规则发送。弹窗中的 Enter 应继续执行弹窗操作。
