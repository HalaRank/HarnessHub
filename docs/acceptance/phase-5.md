# Phase 5：Context Handoff 与 Git Worktree 验收记录

日期：2026-10-31。版本 **0.5.0**；数据库 **schema 6**。范围止于 Phase 5，未实施 Phase 6，未创建 Git commit，未修改已有验收报告。

## 交付结果

实现同一 Conversation 内 A → B → A 接力、延迟摘要、显式活动会话绑定、持久化交接状态和失败确认，以及可选独立 Git Worktree / 安全清理。复用既有 ACP Worker、Turn、权限 CAS、取消、requestId/hash、DraftSession 和 WS seq 补拉。

最终完整自动化 **56 项 Node 集成 + 32 项 Bun/Solid 界面测试，共 88 项，0 失败**。真实 **Codex → Grok → Codex** 通过：同一 Conversation、三段不同原生会话、同一个独立 Worktree、进度文件 1 → 2 → 3、5 次原生 Prompt（3 用户任务 + 2 内部报告）、零重复提交。真实报告 OpenTUI 展开 / 完整原文复制和 Linux PTY 退出保活通过。Windows Terminal / VS Code WSL 的物理键鼠和系统剪贴板仍为 **未验证，待用户验收**。

## 开发前审查与主要文件

完整阅读 AGENTS、架构、实施计划及 Phase 1–4 / Refinement 验收记录。现有单活动 Turn 索引、同步 wire 落盘、请求去重、草稿 CAS、原生审批与取消均保留；扩展点集中在跨 Harness 临时拒绝、隐式最后会话选择和 shared-only Workspace。

| 文件 | 主要改动 |
| --- | --- |
| `packages/core/src/handoff.ts` | 源原生会话报告、固定九部分、来源边界、降级材料、用户确认 / 重试 / 取消、延迟目标创建、最终响应提交边界与源 Worker 释放 |
| `packages/core/src/runtime.ts` | 复用原提交链路预留用户 Turn；区分准备目标和当前活动会话；内部报告事件标记；摘要工具风险；取消 / 删除 / 设置 / 关闭竞态保护 |
| `packages/storage/src/schema.ts`, `runtime.ts`, `handoff.ts`, `index.ts` | Handoff / Worktree 表；显式活动 / 选择 / Workspace 绑定；状态 CAS；来源查询；增量恢复；历史、草稿、审批保留 |
| `packages/storage/migrations/0005_steady_starbolt.sql`, `meta/0005_snapshot.json`, `_journal.json` | Drizzle 增量 migration，schema 5 → 6；旧 SQL / snapshot 未修改 |
| `packages/shared/src/handoff.ts`, `runtime.ts`, `index.ts` | Handoff / Worktree DTO、校验、事件用途标记、shared/worktree、版本 0.5.0 |
| `apps/daemon/src/runtime-routes.ts`, `index.ts` | Harness 选择、报告读取、失败操作、创建 Workspace 模式、管理记录及确认清理 API |
| `apps/tui/src/agent-pane.tsx` | 当前 Harness 与待切换目标；连续 h 选择有序持久化；x 取消；f 降级菜单 / 查看材料 / 确认 / 重试 / 取消；沿用草稿和原生审批 |
| `apps/tui/src/transcript.ts`, `native-events.tsx` | 单条可展开 Handoff 记录、原文及来源、内部报告与目标背景回显进入 Debug；raw/normalized 不改写 |
| `apps/tui/src/index.tsx`, `changes-pane.tsx` | 创建时 Ctrl+W 选择 Workspace；独立 Worktree 清理菜单及 CLEAN 确认；Changes 继续查询绑定 Workspace |
| `packages/core/src/worktrees.ts`, `index.ts` | argv Git 创建、归属记录、失败保留、重启识别、保守清理；共享目录默认不变 |
| `tests/integration/phase5.test.mjs`, `tests/e2e/phase5.test.tsx`, `tests/fixtures/*` | 16 项新增集成 + 4 项新增界面；真实进程 / SQLite / Git 故障、竞争和崩溃验证 |
| `scripts/verify-phase5.mjs`, `verify-phase5-render.tsx` | 独立真实双 Harness 三段接力、PTY / renderer / 原文证据 |
| `scripts/test.ts`, manifests / `bun.lock`, README，既有测试 | 纳入新回归；版本/schema/界面文案断言更新，依赖版本未升级 |

## 数据与状态机

新增 `handoffs` 保存 source / target Harness、两个 NativeSession 引用、源事件区间、报告原文、fallback 原文及来源、状态 / 错误 / 时间戳、首次目标 requestId、预留用户 Turn / 内部 Turn、原始新用户消息、降级确认时间。`managed_worktrees` 独立保留 repository / path / branch / ownerRoot / 状态 / 错误，不随 Conversation 或 Project 删除级联删除磁盘元数据。

Conversation 增加 `active_native_session_id`、`selected_harness_id`、`worktree_id`。正常运行不以创建时间推断当前会话；目标准备中的 ID 由 Handoff 单独关联，在 `session/new` 前即落盘。迁移仅针对 schema 5 已禁止跨 Harness 的旧单线会话，一次性回填旧活动历史指针；回填不是存活证明，Runtime 仍执行既有中断恢复。

Turn 新增 `origin=user|handoff_internal`。唯一活动用户 Turn 继续作为 Conversation 操作预留；源内部报告占用独立内部 Turn，目标开发 Prompt 只在该内部 Turn 确认结束后发送。Event 新增 purpose，内部 Prompt / 回答 / 工具和目标注入背景的原生回显不混成普通用户聊天；原始 ACP、原生文本、工具名称和来源依然完整落盘、可在 Debug 查看。

| 状态 / 边界 | 前置条件及处理 |
| --- | --- |
| 仅选择 / PENDING_SWITCH | 只改选择元数据并记录选择事件；没有 Prompt、摘要、Worker 销毁。选回源复用原 Session，允许源继续执行但目标提交仍被活动 Turn 阻止 |
| PENDING | 首条目标用户消息以原 requestId/hash 预留用户 Turn，独立保存 user.message；固定源 NativeSession 与提交前源事件边界 |
| GENERATING | 当前源必须确实存活且原开发 Turn 已结束；在同一源会话运行内部报告，不使用新摘要模型。原生审批仍需用户选择 |
| READY | 原生最终响应已落盘、报告包含九个要求部分，并持久化原文 / 时间；尚未发送目标 Prompt。目标创建失败保留报告和源会话，进入 FAILED |
| DELIVERING | 目标新 Session 已就绪、关联已持久化；先提交 DELIVERING，再触碰 Prompt 传输。当前活动指针仍指源，准备目标可单独追溯 |
| COMMITTED | **只在实际目标最终 ACP Prompt 响应后**以事务提交接管和活动指针，再正常结束目标 Turn、合作式释放源 Worker。发起 request() 或看到流式文字都不当作独立接受 ACK |
| FAILED | 已知尚未发送目标任务；保留预留和材料。用户可重试、确认降级或取消。多个客户端通过状态 CAS / 操作预留只执行一次 |
| UNCERTAIN | 源/目标已发出的 Prompt 丢失最终结果，或 Daemon 在 GENERATING / DELIVERING 中断；保存证据、阻止新任务与自动重发，不能经重试 / 降级确认绕过 |
| CANCELLED | 用户取消已知未投递的交接；目标任务不发送。保存用户 Turn 的取消事件及结束边界，选择回源；已记录 requestId 不变成新的执行 |

报告固定包含 Current Objective、User Requirements、Decisions、Completed Work、Remaining Work、Relevant Files、Validation Results、Known Issues、Latest State。部分 / 无效报告原文也保留；用户 Prompt 与报告分开存储。目标首 Prompt 明确区分历史背景与真实新消息，Workspace 始终来自 Conversation。

失败材料取当前已完整保存的报告或最近已保存完整报告，补充最近 20 条真实用户消息与边界前最近 300 个可观察事件；有明确大小 / 截断提示及事件 ID，完整原文仍在 SQLite。不引入 RAG。FAILED 的用户任务不会因读取历史、WS 重连、Daemon 重启或重复 HTTP 请求再次发送。HTTP 接受原请求后消费既有对应草稿；确认 / 重试不再增加 user.message。

重启将 PENDING / READY 记为 FAILED，保留尚未投递的预留，要求用户操作，并将真实恢复状态追加到历史事件；未投递的用户 Turn 回到 PREPARING，不伪装为 RUNNING；GENERATING / DELIVERING 为 UNCERTAIN。旧 Session 按原 Runtime 标为 INTERRUPTED、审批失效，不假装恢复原生状态，不自动 load/resume。已 COMMITTED 的活动指针不会退回到较晚创建但未接管的会话。

报告 Prompt 明确要求不使用工具、不执行命令、不编辑文件；HarnessHub 无法给已经启动的原生 Agent 自有工具补加可靠沙箱，也不改变其原生权限模式。原生权限请求照常显示、不自动批准。若观察到报告工具调用，保存工具原文并立即显示风险警示，即使报告完整也进入 FAILED，须检查 Changes 并确认降级才继续。源状态不确定时不能确认降级；用户应检查原生进程 / 工作区后另建 Conversation。

## Worktree 安全策略

- 默认 shared。创建时选择 worktree，仅接受有有效 HEAD 的 Git 仓库；使用真实规范绝对路径、私有数据目录 `worktrees/<UUID>` 和新分支 `hhu/<UUID>`。
- Git 用 `execFileSync` 参数数组，不经过 Shell；创建使用 `-b`，不使用 `-B`、强制覆盖、分支删除或 `remove --force`。禁用创建 / 清理的 Git hooks。预检并由 Git 再次拒绝名称 / 路径竞争。
- 先记录 CREATING，创建和核对 Git 登记 / 路径 / 分支后才 READY、绑定 Conversation。失败记录 ERROR，不自动回滚删除目录 / 分支；崩溃后的 CREATING / REMOVING 为 ERROR，等待独立检查和确认清理。
- Worker 进程 cwd、ACP session/new.cwd、Handoff 目标和 Changes 都使用同一 Conversation Workspace。
- 删除 Conversation 不删除 Worktree / 用户文件 / 分支。清理独立且要求 `confirmed=true`，TUI 显示路径 / 分支并要求输入 CLEAN。
- 所有绑定或使用该路径及子目录的 Conversation 都阻止清理；检查 ownerRoot、UUID 直属路径、realpath / 非 symlink、Git 登记、关联分支和 lock。dirty、未跟踪和忽略文件全部拒绝。未登记目录永不删除；已由 Git 外部移除且路径也不存在时只更新应用记录。
- 清理普通 `git worktree remove -- <path>`，分支保留；失败仍留 ERROR。外部 Git 操作不具原子快照，最终由 Git 非 force 检查再把关。
- Git 管理调用有 15 秒 / 2 MiB 边界，目前使用有界同步操作维持数据库归属检查与提交的顺序，可能短暂阻塞 Daemon 的事件处理；其他已运行的原生进程继续执行。没有全局工作区互斥锁。

## 自动化验证

全部必需命令均实际运行：

```bash
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run build
bun run test
git diff --check
```

冻结依赖安装、双 Node/Bun 类型检查、Biome、构建及 diff 检查通过。最终完整测试日志 **`/tmp/hhu-phase5-full-final3.log`**：56 Node + 32 Bun/Solid，0 失败。Phase 5 集成证据 **`/tmp/hhu-phase5-lCBZKk`**，界面证据 **`/tmp/hhu-phase5-ui-vUCjpu`**。既有四阶段及 Refinement 的全部测试继续运行，没有删除断言来绕过功能失败。

| 范围 | 实际覆盖 |
| --- | --- |
| 正常接力 | A → B → A 三 Session、同 Harness 复用、选择不调用、取消 pending、真实用户与内部记录分离、源边界 / 原文 / NativeSession / requestId 持久化 |
| 去重 / 并发 | 8 个客户端相同请求只执行一次；不同内容与重叠任务 409；确认动作竞争一次成功；WS / 查询不生成新 Prompt；共享目录并发提醒，独立 Worktree 并发，跨 Conversation 隔离 |
| 异常 | 无效报告、失败确认 / 取消 / 重试、最新完整报告降级、目标创建失败、目标 Prompt RPC 错误 UNCERTAIN、不自动重发；源运行 / 审批 / 取消保护；报告原生审批与工具风险 |
| 崩溃 | 实际隔离 Mock Daemon 在 GENERATING / DELIVERING SIGKILL 后重启，无 Prompt 重放；真实 SQLite 保存边界注入 PENDING / READY / GENERATING / DELIVERING 后恢复；既有取消与故障测试继续回归 |
| 数据升级 | 使用前五次真实 migration SQL 建 schema 5，写入归档、草稿、历史 Session / Turn / Event / Approval 后升级至 6；逐项保留、外键检查、私有备份通过 |
| Worktree | 真实 Git 创建 / 分支 / Worker cwd / session cwd / Changes；非 Git 拒绝；通过测试 Git 包装进程制造路径 / 分支并发冲突及实际创建成功但回报失败，均不绑定 Conversation、不覆盖文件、不删分支；重启部分状态、dirty / ignored / 分支变化 / 未登记路径清理拒绝 |
| TUI 回归 | pending / x / 首条交接、降级确认、报告展开 / 来源、Ctrl+W / CLEAN；原有鼠标自动复制、Ctrl+C / SIGINT、Enter / Shift+Enter、Raw Debug、归档恢复删除、草稿 CAS、紧凑布局、Changes 与滚动测试通过 |

性能样本沿用同一回归：20,000 文本分块投影 **27ms**，20 个显示分段；10,000 历史项每页最多挂载 60 项，长历史界面项约 **137ms**。只是本机样本。报告生成耗时取决于源 Harness / 网络，不设置自动重试；可正常取消。原始历史内存仍与已补拉事件量相关。

开发中失败未掩盖：初次取消测试在源已确认结束后仍强求 409，已改为验证实际未结束边界；一次独立集成出现 ECONNRESET，后续定向与完整回归通过，未自动重发任务。旧 UI 对文案及同步 h 的假设已修正，连续 h 现有序持久化。真实 renderer 初次在 Markdown 异步解析 / 布局完成前截取，改为等待可见内容并重新定位，第二轮完整真实验证通过。早期失败日志保留于 `/tmp/hhu-phase5-*-first.log`、`/tmp/hhu-phase5-integration-second.log` 等，没有把失败证据改为通过。

## 真实 Codex / Grok 联调证据

执行 **`node scripts/verify-phase5.mjs`**。完整通过证据 **`/tmp/hhu-real-phase5-YZ4UKX/evidence.json`**，日志 **`/tmp/hhu-phase5-real-final.log`**，`passed=true`。临时 Git 项目和 XDG、SQLite、原生事件、报告及 renderer frame 全部保留，没有使用 Mock 替代真实结果，没有读取 / 修改原生模型、Key 或 Base URL 配置。

Conversation：`c0ca3eea-8fcf-44db-939d-ccf5f17d8f09`。Workspace：`/tmp/hhu-real-phase5-YZ4UKX/data/harnesshub/worktrees/b644fdd4-e7d4-4d70-a130-4096955f08f7`。

| 段 | 应用 NativeSession | Turn | 结果 |
| --- | --- | --- | --- |
| Codex 1 | `bcd1b549-72bd-458f-93d9-b933a39def0f` | `38687158-a1e7-4a85-a43d-fcc0c488adc1` | COMPLETED；读哨兵 / pwd，创建 progress.txt 为 stage=1，执行 sleep 15 |
| Grok 2 | `a988f2bc-fe19-479b-b8b1-7ef6b150c585` | `caf5d502-a5d2-4177-802b-02a7b4b24d7a` | COMPLETED；从交接理解用户 cobalt 决策 / PHASE5_COBALT，读取阶段 1 后更新为 stage=2 |
| Codex 3 | `6b42a35c-8797-46d7-a08f-8023f482869d` | `21864464-34b1-49c2-8684-63e6a443c848` | COMPLETED；全新原生会话，继续保留决策，读取阶段 2 后更新为 stage=3 |

两份 Handoff 均 COMMITTED，源区间分别 **#3–119** 和 **#1080–1368**；原文分别 3,955 / 5,330 字符，保留来源 Harness、两个 Session 与时间。3,168 个真实事件进入 renderer，核对 raw session/update 与 normalized 对应；两个独立 Handoff 项可展开，y → Enter 完整原文逐字相等，frame 名称保存在 evidence.render.captures。没有重写 Agent 原文，真实报告期间观察到的工具调用为 0。

每段选择后先核对原生 Prompt 数未增加；总共 5 次 Prompt、3 条真实 user.message。两次交接复用各自源仍存活的原生会话生成报告，回 Codex 的 Agent session ID 也不同。第一段通过真实 Linux PTY 从 Home 打开构建后的 hhu，SIGINT / Ctrl+C 清空输入与空输入退出均通过；关闭全部 TUI 时该 Turn 尚未结束，Daemon 继续执行并落盘。真实三段均未出现待审批，不能据此宣称真实原生审批手动验收通过。

测试 Daemon 最后合作式停止，无强杀。evidence.sessions 是任务结束附近的快照，可能包含 CLOSING；停止后只读检查 SQLite，**3 个 Session 均 CLOSED、0 个未结束 Turn**。没有删除临时 Worktree / 文件或分支，也没有操作用户默认 Daemon。

## 限制、待验收与未完成项

- **Windows Terminal / VS Code WSL 的物理 Shift+Enter、鼠标拖选和 Windows 剪贴板未验证**。Linux PTY / renderer / 捕获 OSC52 不替代人工结果。
- 真实 Handoff 已验证 Codex / Grok；Claude / OpenCode / 自定义 Agent 的本阶段交接未逐一真实验证，不能沿用旧阶段握手结果宣称通过。ACP fs / terminal client 能力仍如实为 false。
- 没有已验证的跨 Agent 原生恢复，Daemon 崩溃后仅恢复历史。UNCERTAIN 无自动解锁 / 强制假成功 / 重放；旧原生进程可能仍有副作用，须人工检查后另建 Conversation。
- 不保证摘要无损、原生 Agent 永不调用工具，或不可观察的 Agent 自有操作可被阻止。工具可观察风险会阻断自动接管；原始历史与 Changes 可追溯。已有原生权限设置不会被 HarnessHub 改成新策略。
- 接管保守等待目标最终响应，源 Worker 会多保留至该响应；若正常关闭不能确认退出，保留句柄和 cleanup_failed 证据，受控停机继续处理，不自动 SIGKILL。
- Worktree 清理保守要求先删除全部绑定 Conversation，不提供带有 UNCERTAIN 历史的强制删除、自动分支清理或任意目录修复。ERROR 部分状态可显式安全清理，无法核验的遗留路径交由用户检查，不自动猜测为可用。
- 0.5.0 / schema 6 需要安全停止旧 Daemon 后再运行；旧库迁移前自动备份。本次未自动升级用户默认库、未安装 / 覆盖全局 launcher。现有用户级 launcher 若引用本仓库构建，须先停止旧版本实例再启动。
- Phase 5 功能与本机验证已完成，剩余是目标终端人工验收及上述透明兼容性限制。未开始 Phase 6 安装发布 / 最终加固工程。

分别在 **Windows Terminal**、**VS Code WSL** 记录终端版本并完成：

1. 无活动任务时安全停止旧 Daemon，使用 0.5.0 构建，从 `~` 输入 hhu。注册临时 Git 项目，n 默认 shared；Ctrl+W 选 worktree，检查路径 / 分支与 Changes，关闭 / 重开草稿仍正确。
2. 选择 Codex 执行无害读取 / 测试；h 选 Grok，应显示源 → 目标 pending、不调用模型；x 取消后继续 Codex 应复用 Session。源运行 / 审批 / 取消中尝试目标提交应被拒绝，允许另一个 Conversation 并行。
3. 等源结束，再选择 Grok 并发送；正常报告自动接管，无确认弹窗。检查九部分报告、e 展开、y 原文及 r 来源 / 序号。再回 Codex，确认新 NativeSession，仍是相同 Conversation / Workspace，用户消息各一条。
4. 用隔离 Mock 的失败场景打开 f：先查看材料，不确认时目标会话不能启动；分别验证取消、重试、确认降级。两台 TUI 竞争确认只执行一次。UNCERTAIN 应提示检查，不能用确认按钮重发。
5. 运行时退出全部 TUI，再打开应补齐后台输出而无新增 Prompt。双客户端草稿冲突、归档 / 恢复 / 删除、Raw Debug、Changes、滚动和工具手动展开保持。
6. 验证鼠标拖选松开复制，Ctrl+C 选区复制 / 非空清空 / 空输入退出；Enter 发送一次、物理 Shift+Enter 只换行。若终端不提供独立键码，记录限制并验证 Ctrl+J。粘贴到系统编辑器核对中文 / 缩进 / 空行。
7. 删除空闲 Worktree Conversation，文件和分支必须保留。Manage Worktrees 显示正确路径，输入 CLEAN 才清理；dirty / untracked / ignored / 被另一会话使用时拒绝。最终普通清理后 Git 分支仍存在。

本阶段交付后等待用户验收，不自动实施 Phase 6。
