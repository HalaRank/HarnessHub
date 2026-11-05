# Phase 6 修复：聊天历史连续滚动

本轮只修复当前阶段的历史展示，不进入下一阶段。

## 根因及行为

只读核对用户当前会话：SQLite 仍保存 1,227 条连续事件，投影为 184 条聊天记录。原实现每 60 条切换一页；第 181 条恰好是原生 `Guardian Review` 工具，出现后新页仅挂载该记录，前 180 条不再挂载，滚轮又只能在当前页移动，造成历史突然消失的观感。数据未因该展示问题被删除。

按用户要求，聊天改为滚轮连续上下查看，移除页码及 Ctrl+PageUp/PageDown 的整页切换语义。末尾始终保留最近 60 条渲染记录，滚到边缘自动平移有重叠的渲染窗口，并用 OpenTUI 的 anchor 保持可见记录位置；无需用户执行翻页操作。挂载记录数有界，原始事件和全部聊天记录保留。滚轮沿用每次五行；阅读旧内容时冻结起始记录，新消息不抢滚动位置，Esc / End 返回末尾。PgUp/PgDn（包括 Ctrl 组合）只滚动视口。

## 文件

- `apps/tui/src/native-events.tsx`：连续渲染窗口、边缘滚动、布局锚点、页码移除、选择和恢复。
- `apps/tui/src/transcript.ts`：内存 ViewState 用窗口起始记录替换页号；不增加 SQLite UI 快照。
- `tests/e2e/chat-scroll.test.tsx`：第 181 条 Guardian Review 的回归；仅用滚轮抵达首条再返回末尾，校验上下文、挂载上限和完整记录数。
- `tests/e2e/phase4.test.tsx`：长历史与新消息滚动锁回归按连续历史更新。
- `scripts/verify-phase4-render.tsx`、`scripts/verify-phase5-render.tsx`：真实输出验证脚本同步内存视图字段。
- `README.md`、`docs/01_ARCHITECTURE.md`、`docs/acceptance/phase-6.md`：当前交互及验收入口。

## 验证

- `bun test tests/e2e/chat-scroll.test.tsx`：4/4 通过，24 个断言，日志 `/tmp/hhu-history-scroll.log`。后续补充 Ctrl+PgUp 视口移动断言纳入完整 runner。
- `bun run typecheck`、`bun run lint`、`bun run build`：通过。
- 只读提取真实受影响历史，再用当前 OpenTUI renderer 按每批 200 事件重放，120 / 40 列下全部历史可通过滚轮从末尾到首条再返回，末尾自动跟随，全部事件逐对象相等：1/1 通过，16 个断言。120 列向上 184 次、向下 182 次滚轮；40 列向上 192 次、向下 191 次。私有证据 `/tmp/hhu-history-check-ZQfOAR/` 包含原始事件、验证源码、日志和仅元数据的结果，不提交用户正文到仓库。没有重新发送 Prompt 或调用真实 Agent。
- 完整 `umask 022; bun run test`：构建、Node 集成 **96/96**、Bun/Solid 界面 **90/90**（1,151 个断言）通过，零失败。新增滚轮回归还逐条收集并核对所有 180 条消息均曾显示，验证连续浏览没有跳过记录。日志 `/tmp/hhu-continuous-history-full.log`。最终 `git diff --check` 通过；类型与 lint 日志为 `/tmp/hhu-history-typecheck.log`、`/tmp/hhu-history-lint.log`。

## 用户待验收与限制

- 用户数据库仅只读检查，未迁移、删除或改写；未决定审批、重放 Turn 或结束现有 Daemon / Worker。
- 当前运行的 TUI 与独立安装的全局 `hhu` 尚未替换。本轮源码构建不更新已安装发布。按 `docs/OPERATIONS.md` 安全更新后，打开同一历史并持续滚轮向上，应能回到第一条；再向下可回到最新回复；无页码及翻页要求。
- Windows Terminal / VS Code WSL 物理滚轮本轮未验证；真实持久化历史的 OpenTUI 重放不等同于物理终端或新一轮真实 Agent 验收。
