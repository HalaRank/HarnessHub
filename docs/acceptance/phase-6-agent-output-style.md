# 阶段 6 补充验收：Agent 输出视觉层级

日期：2026-11-02。仅调整现有 MVP TUI 样式，未进入新阶段。

## 实现范围

参考用户提供的 Codex 终端截图，为 HarnessHub 原生事件添加轻量视觉层级：

- Agent 消息使用浅蓝色圆点与加粗标签，正文统一缩进两列；选中消息继续使用 `▶`。公开思考标签使用灰色，与回复区分。
- 工具标题保留原生名称；圆点、标题、状态及左侧细线随状态着色：运行/待执行青色、完成绿色、失败红色、待审批黄色。移除工具四边框，保留左侧引导线和输出缩进。
- 事件序号、展开提示保持灰色；用户消息原有整块灰底及留白保留。Markdown、工具输出、公开思考和所有原始/结构化事件不做语义修改。
- 成功工具默认折叠、失败/运行/待审批默认展开以及手动展开优先规则不变。审批行为、Daemon、ACP、SQLite 和真实 Workspace 逻辑不变。

## 文件

- `apps/tui/src/native-events.tsx`：消息标记、标签、缩进与工具状态色。
- `tests/e2e/agent-output.test.tsx`：无网络、无 Daemon 的 OpenTUI renderer 样式回归。
- `scripts/test.ts`：将新增样式回归纳入标准测试 runner。
- `docs/acceptance/phase-6.md`：关联本记录。

## 验证结果

以下为本次执行结果，不将此前或并行操作的测试结果计为本次通过：

| 命令 | 结果 |
| --- | --- |
| `bun test tests/e2e/agent-output.test.tsx` | 3/3 通过，84 个断言 |
| `bun run typecheck` | 通过 |
| `bun run lint` | 通过 |
| `bun run build` | 通过，构建 CLI 和 Node Daemon |
| `git diff --check` | 通过 |

渲染验证覆盖 100/32 列的标题色、加粗、正文缩进、中文/Markdown/代码；流式消息增量更新及结束状态；用户灰底与回复透明背景隔离；工具 pending/in_progress/completed/failed/WAITING_APPROVAL 动态状态色及细线；默认折叠和手动展开；来源事件不变与原文复制。

最初在 `phase4.test.tsx` 中运行定向用例，测试 Daemon 启动失败；请求沙箱外运行的审批两次超时，未获执行。因此将新增纯渲染回归独立成不启动 Daemon 的测试文件。期间发现并修正了选中标记预期、异步 Markdown 渲染等待以及 OpenTUI span 样式写法问题，最终定向测试通过。此前用户灰底记录提到的新增 Agent/工具用例失败和 span 类型错误已由本轮修正；这不意味着全量回归已经通过。

## 未验证与人工步骤

- 本轮全量 Node/Daemon 集成、真实 ACP Agent 和 Windows Terminal / VS Code WSL 物理终端外观均**未验证**。不扩大既有 Agent 兼容性或 MVP 最终验收结论。
- 环境允许测试 Daemon 后，运行 `umask 022; bun run test` 补齐全量回归；本轮不修改用户 Shell 的全局 umask。
- 使用本构建打开历史和新消息，检查浅蓝 Agent 标签、灰色公开思考、工具各状态色和左侧细线；缩窄窗口检查中文与代码换行；用 `t` / `e` 检查工具折叠，用 `y` 检查原文复制。
- 未更新全局安装、未停止默认 Daemon，也未改动默认用户数据库。全局 `hhu` 需按 `docs/OPERATIONS.md` 的安全更新流程重新安装后验收。
