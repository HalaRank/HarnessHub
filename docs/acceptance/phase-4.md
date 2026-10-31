# 阶段 4：完整 OpenTUI 界面与原生 ACP 内容渲染验收记录

日期：2026-10-31（America/Los_Angeles）。版本 **0.4.0**；数据库 **schema 4**。仅 Phase 4，没有实施 Phase 5 Handoff / Worktree 管理或 Phase 6 发布系统，没有创建 Git commit。

## 交付结论

Phase 4 代码与本机自动化验证完成，交付人工验收。沿用 Bun + OpenTUI + SolidJS、Node Hono、Generic ACP Runtime、SQLite 和原有事件补拉；没有另建执行器或修改原生 Harness 的模型、Key、Base URL 配置。

类型检查、lint、构建及 **37 项 Node 集成测试 + 22 项 Bun/Solid 界面测试**全部通过。真实 Codex / Grok 的主要链路及事件保真验证独立记录，见下文。**Windows Terminal / VS Code WSL 的物理键盘、真实窗口视觉与系统剪贴板仍为“未验证，待人工验收”**；Linux PTY 和 renderer 测试不能替代它们。

## 现状检查与架构边界

按顺序阅读 AGENTS、架构、实施计划及前三阶段验收，检查了现有 TUI、Generic ACP wire collector、SQLite raw/normalized events、WS 按 seq 分页补拉、DraftSession CAS 与 requestId 预留。

原发送、原生审批、取消、Worker 生命周期和事件持久化路径继续使用。界面操作不创建 Prompt；断线、切换、resize、关闭 TUI 不取消 Agent；不重放未确认请求。同一 Conversation 跨 Harness 继续明确拒绝，选择其他 Harness 应使用新的 Conversation。没有提前实现 Handoff / Worktree。

## 功能与文件

| 文件 | 实现 |
| --- | --- |
| `apps/tui/src/index.tsx` | 内容优先布局、Project → Conversation 树、全局状态、窄于 90 列自动隐藏侧栏、命令面板、偏好保存；仅运行期缓存各会话滚动/展开状态 |
| `apps/tui/src/command-palette.tsx`, `shortcuts.ts` | 搜索 Project / Conversation / 操作；Ctrl+P、Ctrl+B、Ctrl+D、Ctrl+Y、备用换行可覆盖；Esc 关闭；校验冲突与保留键 |
| `apps/tui/src/agent-pane.tsx` | 常驻底部草稿编辑器、m 聚焦、Enter 发送 / Shift+Enter 换行；ACP 实际模型与连接/运行状态；原生 mode/config 选择器、审批与取消；设置只用 Agent 返回的候选 |
| `apps/tui/src/draft-session.ts` | 复用原草稿 CAS / requestId；快速切回时等待前一个编辑器离开后的有序保存；失败文字保留，不能被空草稿覆盖 |
| `apps/tui/src/transcript.ts` | 原生事件增量投影、稳定展示项与独立响应式更新；User / Agent / 公开 thinking 分离；工具按 NativeSession + toolCallId 关联；原始 event ID / seq 来源；终端 metadata 分块保留 |
| `apps/tui/src/native-events.tsx` | Markdown、原生计划、工具卡、未知事件；60 项历史页、视口裁剪、滚动暂停/跟随、跨页阅读锁定、状态恢复；r 原始详情、y 原文复制入口 |
| `apps/tui/src/rich-content.tsx`, `source-viewer.tsx` | OpenTUI Markdown、表格、代码高亮、Diff；参数/结果/终端输出；代码块及全文原样复制；原始来源分页、PgUp/PgDn 与 OSC52 |
| `apps/tui/src/changes-pane.tsx` | Chat / Changes 切换，真实文件状态、Staged / Unstaged / Untracked Diff、刷新、文件选择与原文复制；不标记 Agent 归属 |
| `packages/core/src/changes.ts`, `packages/shared/src/changes.ts` | 只读 Git 查询与 DTO；NUL 路径解析、重命名、工作区边界、字面 pathspec、查询限时和输出限制 |
| `apps/daemon/src/runtime-routes.ts`, `index.ts` | Changes 只读 API、侧栏与快捷键偏好；沿用原认证、Runtime 与 Draft API |
| `packages/shared/src/client.ts` | HTTP 改为明确直连 127.0.0.1 的 Node/Bun 共用连接，避免环境代理接管回环；WS seq 补拉、重连、去重和只读恢复语义不变 |
| `packages/shared/src/session-state.ts`, `packages/storage/src/schema.ts`, `index.ts` | 偏好新增 `showSidebar` / `shortcuts`；不记录完整 UI 快照 |
| `packages/storage/migrations/0003_tense_prowler.sql`, `meta/*` | 增量 migration；旧 SQL 不改；旧库备份后升级 |
| `tests/integration/phase4.test.mjs`, `tests/e2e/phase4.test.tsx` | 本阶段 5 项集成 + 14 项界面测试；保留前三阶段回归 |
| `tests/e2e/terminal.py`, `tui.test.tsx`, Phase 1/2/3 测试 | 适配最终版本/schema/界面；PTY 匹配忽略 ANSI 分段，保留真实操作断言 |
| `scripts/verify-phase4.mjs`, `verify-phase4-render.tsx`, `tests/e2e/phase4-terminal.py` | 显式真实双 Harness / 三 PTY / 并发 / 退出保活 / 原文渲染复制；隔离 XDG，不自动选择原生审批 |
| workspace manifests、`bun.lock`、`scripts/test.ts`、README、兼容性记录 | 统一版本、完整测试入口和使用说明；依赖版本未升级 |

## 原生保真与交互契约

- 字体、颜色、容器、来源标签统一，Agent 的文字、Markdown、工具名称/标题、参数/结果、计划内容及公开思考不做总结或重写。仅渲染 ACP 实际可观察内容，不获取隐藏推理，不承诺复刻原生 CLI 像素。
- 每个展示项保留源 Event ID / seq，工具更新保留全部源事件；同名 toolCallId 在不同 NativeSession 不会合并。`r` 可逐个查看 normalized payload 与对应 raw ACP。未知事件、特殊内容和协议响应都可达，不静默丢弃。
- 工具完成默认折叠；运行、失败、等待审批默认展开；手动展开/折叠优先，状态更新与切换 Chat / Changes、切换 Conversation 后保留。本机测试包括 completed → running → completed、失败、审批等待、重挂载和 Codex metadata 输出。
- Codex 本次通过 `_meta.terminal_info` / `terminal_output_delta` / `terminal_exit` 提供终端内容，展示层按 terminal_id 累加原文，不覆盖为统一工具结果；raw 事件不变。Grok 使用原始 content / rawOutput。未知扩展仍走详情，不猜测语义。
- `y` 源视图可选择完整 Markdown、单独代码块、参数/结果、终端全文或 Diff，Enter 复制选中原文；代码缩进及空行保留。Ctrl+Y 复制鼠标选区。使用 OSC52；显示“已发送复制请求”不代表 Windows 剪贴板已接收。
- Enter 发送；Shift+Enter 换行；默认备用 Ctrl+J。输入可粘贴多行、自动保存和恢复；Esc 返回导航。原生会话、模型、推理/权限配置只来自 ACP；没有返回则说明不可用。
- 命令面板包含项目/会话搜索、创建、消息、Changes、原生选项、原生审批、正常取消、活动与侧栏开关、快捷键配置、退出。快捷键 JSON 示例：`{"palette":"ctrl+o","sidebar":"ctrl+s","newline":"meta+return"}`；`{}` 恢复默认；保存在 HarnessHub SQLite。Enter / Shift+Enter / Esc / quit 不能覆盖。
- 草稿发送仍先保存 requestId 预留；已提交 ACK 丢失只查询，不自动发 Prompt。新 UI 的连按 Enter 只提交一次。离开后的保存失败仍注册待补存文字；快速回到同会话先等待先前保存队列，继续受 CAS 保护。

## Changes 契约与限制

`GET /v1/conversations/:id/changes` 返回绑定 Workspace 的真实 Git 状态与仓库根目录；`?path=<encodeURIComponent(status path)>` 返回该文件 staged / unstaged / untracked patch。路径必须仍在状态列表内，并落在 Conversation Workspace；不接收用户自选 cwd。

采用 `git status --porcelain=v1 -z --untracked-files=all -- .`；重命名与特殊文件名使用 NUL 分隔。Diff 通过 argv、`--literal-pathspecs`、`--`、`--no-ext-diff`、`--no-textconv` 获取；不经 Shell、不执行 Git hook 或外部 diff，不暂存/提交/修改文件。未跟踪符号链接显示链接本身，不能借此读取链接目标。非仓库是明确空态。

Git 各次读取不是原子快照，Agent 并发写入时可能变化，使用 g 刷新。共享目录展示全量真实状态，不推断某个 Agent 的修改归属。超时 10 秒、单次 Git 输出超过 2 MiB 会报错，不能把截断当完整 Diff；二进制只显示 Git 原生 binary 提示。大 Diff 预览 96,000 字符，源视图可查看/复制该次完整查询结果。工具内联 Diff 来自原生 diff 或原生 oldText/newText，不归属其他 Git 改动。

## 自动化验证与性能

最终完整成功命令：`bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run test`。

| 命令 | 结果 |
| --- | --- |
| `bun install --frozen-lockfile` | 通过；354 packages 锁定，依赖版本未变 |
| `bun run db:generate` | 生成 schema 4 增量 SQL / journal / snapshot |
| `bun run typecheck` | 通过，含独立 Node-only Daemon 检查 |
| `bun run lint` | 通过，57 个文件；没有关闭 lint 规则 |
| `bun run build` | 通过；完整 test 内重建 Bun CLI / Node Daemon |
| `bun run test` | **37 Node 集成 + 22 Bun/Solid，0 失败**；总计 59 项 |
| `git diff --check` | 通过 |
| 在 Home 执行现有全局 `hhu --version` / `hhu doctor` | 0.4.0；Node/Bun/OpenTUI/SQLite/Git/flock 诊断及默认 Daemon 连接通过 |

最终完整证据：`/tmp/hhu-phase1-Yg9D8b`、`/tmp/hhu-phase2-JkRTQA`、`/tmp/hhu-phase3-Q4tUDi`、`/tmp/hhu-phase4-d8gBcb`、`/tmp/hhu-phase4-ui-Z11tUI`。

新增测试覆盖：Markdown 标题、列表、引用、表格、代码缩进；Diff 添加/删除行颜色；工具内联 Diff；公开 thinking 与原文/来源；未知事件 raw/normalized；工具折叠与手动覆盖；Codex terminal metadata 分块显示及逐字复制；Enter 去重、Kitty Shift+Enter / Ctrl+J / 可配置 Meta+Enter；侧栏、resize、命令面板；两个 Conversation 并发输出与草稿切换；快速切回保存竞态；滚动暂停、底部跟随、重挂载恢复及新历史页不抢阅读位置；Unicode surrogate pair 分段；真实 Git 暂存/未暂存/重命名/删除/二进制/特殊路径/子目录/符号链接/超大输出；Bun 和 Node 在代理环境中均只直连本机。

最终性能样本：20,000 个原生文本分块、200 条/批，投影 **25ms**，生成 20 个展示分段；10,000 个独立历史项仅挂载当前页 **最多 60 项**。包含长历史 renderer 与滚动恢复的单项测试约 **198ms**。这是本机一次测试结果，不是跨终端帧率保证。展示项身份稳定，更新只通知受影响项；没有按每个分块从头重建整段历史。

历史原始数据仍按需补拉到当前面板内存，不是常量内存的数据库虚拟窗口；超长单会话仍占用与已读取事件量相关的内存。文本约 16,000 UTF-16 单元分段并保留 surrogate pair，完整消息复制不按段截断；跨段 Markdown（例如很长代码围栏/表格）可能重新解析格式，原文可通过 y 完整读取。工具参数/结果预览最多 24,000 字符，终端显示最近 24,000 字符，原始详情/源视图按 24,000 字符分页；完整来源和复制内容保留。滚动/展开状态只在本次 TUI 内保留，不写完整快照。

## 真实 Harness 验证

执行命令：

```bash
HARNESSHUB_PTY_LAUNCHER="$HOME/.local/bin/hhu" node scripts/verify-phase4.mjs
```

最终完整成功证据：**`/tmp/hhu-real-phase4-4X7Drd/evidence.json`**（`passed=true`、`renderPassed=true`），原始 ACP / normalized 事件在同目录 `data/harnesshub/harnesshub.db`。三个真实 Linux PTY 均从 `/home/clj` 启动现有全局 `~/.local/bin/hhu`，不是 Mock renderer 替代 CLI。

| Harness | Conversation / Turn | 原生验证结果 |
| --- | --- | --- |
| Codex | Conversation `7ace132d-600d-4917-a2a2-bfca7909d336`；Turn `3562b025-a5a9-43d5-a2cb-cd4d4d15b68a` | COMPLETED；152 个事件；1 次原生 Prompt；cwd=`/tmp/hhu-real-phase4-4X7Drd/project-1`，正确哨兵；Node 测试 1 pass / 0 fail |
| Grok | Conversation `21aae0d3-ba29-43ba-9a0a-1fd31c59e4b3`；Turn `99e9bbb8-5578-4109-9a87-2ec2557d84dc` | COMPLETED；279 个事件；1 次原生 Prompt；cwd=`/tmp/hhu-real-phase4-4X7Drd/project-2`，正确哨兵；Node 测试 1 pass / 0 fail |

真实任务使用原生工具读取 `smoke.txt`、打印 cwd、`sleep 12` 后执行 `node --test smoke.test.mjs`，并请求包含标题/列表/代码围栏的 Markdown 回复；没有修改用户项目、调用网络工具或派生子 Agent。两个 Turn 实际重叠；命令面板切换到另一个运行会话，折叠侧栏并 resize；全部 TUI 退出时仍有运行任务，重开后原生 NativeSession / Worker 不变，每会话只记录一次原生 Prompt。测试结束后隔离 Daemon 受控停止，没有强杀 Worker 或自动代选审批。

Linux PTY 实际输入 Kitty Shift+Enter 字节及 Ctrl+J，发送前查询 SQLite 草稿确认三行文字完全一致、没有 user.message；Enter 后只生成一次 Prompt。这证明本机键码处理链路，**不证明 Windows Terminal / VS Code WSL 的物理按键会发出这些字节**。

真实事件再送入本次 OpenTUI renderer，逐个核对 `session/update.raw.params.update === normalized payload` 以及展示项源 Event ID / seq。Codex 原生工具标题保持 `cat smoke.txt; pwd; sleep 12; node --test smoke.test.mjs`，终端 delta 原文复制 129 字符；Grok 原生工具标题保持其返回的 Read 路径文案，原始工具 JSON 复制 320 字符。两者真实最终 Markdown（314 / 406 字符）成功显示，并经 y → Enter 复制全文与单独代码块，内容完全相等。OSC52 发送函数在 renderer 验证中被捕获比较，没有把系统剪贴板人工验收写成通过。

同目录保存 `codex-tool-frame.txt` / `grok-tool-frame.txt`、`*-source-frame.txt`、`*-chat-frame.txt`，权限 0600，可复核实际原生内容渲染。早先完整成功证据 `/tmp/hhu-real-phase4-2BEbFD` 也保留，但以上最后一次全局入口验证是本次验收基线。

## 本机升级与问题修正

默认旧 0.3.0 Daemon 检查结果为 0 活动 Turn、0 待审批；通过受控 stop API 正常停止，没有强杀。使用现有全局 launcher 启动 0.4.0，schema 3 → 4 后 **6 个 Project / 18 个 Conversation 全部保留**，原有 INTERRUPTED 历史仍如实显示。升级前备份 `harnesshub.db.backup-1793442054499-3bc5d826-ecc6-45fa-82f4-b8b2ad7d3efb` 存在且 0600。没有改写 Shell / 原生 Harness 配置，没有引入安装或发布系统；本阶段沿用已有用户级 launcher。默认 0.4.0 Daemon 保持可连接，测试使用的隔离 Daemon 正常停止。

开发中确实出现过失败，未把它们记为通过：旧 PTY 按连续 ANSI 文本匹配，遇 renderer 差量重绘误报；真实命令面板切换现通过实际操作引起的最近会话持久化变化断言，不假设整条标题总是重绘。早期真实工具复制检查发现 Codex terminal metadata 未展示，已补齐并加回归。另一次隔离 Daemon 已启动但启动器报告失败，直接回环探测成功而代理路径返回 502；现改为明确直连并加 Node/Bun 代理环境回归。遗留的空闲隔离 Daemon 经受控 API 正常停止，无强杀或数据清理。

## 未验证与人工验收步骤

1. 分别在 **Windows Terminal、VS Code WSL** 从 `~` 输入 `hhu`，记录应用/终端版本。打开真实 Project 与 Conversation，检查顶部 Harness、ACP 模型、运行状态；Ctrl+B 隐藏/显示侧栏，缩至少于 90 列后自动隐藏，放宽后按偏好恢复。Ctrl+P 搜索项目/会话并切换。
2. 按 m，输入第一行，**物理按 Shift+Enter**，输入第二行；必须只换行、没有新 Turn。Enter 后只出现一次 user.message / 原生 Prompt。若终端把 Shift+Enter 编成普通 Enter，记录为不兼容，使用明确显示的 Ctrl+J，或在 Configure Shortcuts 设置适合终端的备用组合，再复验。Linux PTY 注入键码已通过，不能据此跳过此项。
3. 输入包含缩进、中文、空行的粘贴草稿，Esc 切到另一会话后立刻切回，再退出/重开；核对草稿。分别操作两台 TUI 同一草稿，过期 CAS 应报错，不覆盖另一端。未确认提交不得因重开/重连再发。
4. 使用真实 Codex 和另一个已登录 Harness 读取无害文件并运行测试。核对原生工具标题/名称、参数、完整结果与 Markdown；成功默认折叠，运行/失败/待审批默认展开。用 t / e 手动展开后让状态变化，再切换会话，展开状态应保留。不选择任何自动批准模式来代替原生审批。
5. `[` / `]` 选择项，r 查看 raw/normalized 对应及 seq；y 查看 Markdown、单个代码块、工具结果/终端输出，Enter 复制。粘贴到文本编辑器检查缩进、空行及内容逐字一致；鼠标选区 Ctrl+Y 同样验证。**两种终端的系统剪贴板接收与 mouse selection 体验尚未人工验证**，OSC52 失败时应可查看/选择原文，不声称复制已被系统接收。
6. Ctrl+D 打开 Changes，对照同一绑定 Workspace 的 `git status --porcelain`、`git diff` / `git diff --cached`；核对暂存/未暂存/未跟踪、内联工具 Diff 和非 Git 空态。共享目录不能显示 Agent 归属；g 刷新后反映真实变化，不会暂存或提交文件。
7. 两个 Conversation 并发输出，来回切换、缩放终端、查看历史；PgUp 暂停跟随，新事件跨页也不应跳走。Ctrl+PgUp/PgDn 翻页，End 回到底部恢复跟随；切回时滚动与工具状态恢复。关闭全部 TUI 后 Agent 继续，重开后同一 Daemon/Worker 补齐历史，不多发 Prompt。
8. 实际需要审批时按 a，用户选择原生编号再 Enter；取消只发送正常 ACP cancel。真实 Codex/Grok 本次无待审批请求，权限 UI/竞态以 Mock 集成和 renderer 测试验证，不能宣称两个真实 Harness 的审批均已人工验收。Claude/OpenCode 本阶段主要 UI 链路未重测；不继承 Phase 2 结果作为本阶段已验收。

人工验收完成前不声明全部目标终端体验通过。本阶段到此交付，不自动进入 Phase 5。
