# 阶段 3：Project、Conversation、并行与恢复验收记录

日期：2026-10-31（America/Los_Angeles）。版本：0.3.0；数据库 schema 3。范围仅 Phase 3，未开始 Phase 4 / Phase 5，未创建 Git commit。

## 结论

实现完成，本机自动化及真实 Codex / Grok 并行验证通过，可交付人工验收。沿用 Phase 2 Generic ACP Runtime、Worker、原生审批、取消、原始事件存储和请求去重，没有另建执行器。

最终构建安装至 `~/.local/bin/hhu`。从 Home 通过已安装的全局入口打开两个真实 Linux PTY，分别向两个 Project 的 Codex / Grok 发送任务；两者并行执行，在正确目录读取不同哨兵并运行 Node 测试。退出全部 TUI 时任务仍未结束，重新打开第三个 TUI 后仍是同一 Worker / NativeSession；每个 Conversation 仅有一次原生 Prompt。两个任务均 COMPLETED，测试均 1 pass / 0 fail。没有由脚本代选原生审批。

Windows Terminal / VS Code WSL 的人工键位与视觉验收仍为**未验证**。真实 Harness 的本阶段并行验证为 Codex / Grok；Claude / OpenCode 的真实并行组合没有重测，不把 Phase 2 的单 Harness 验证当成本阶段组合验证。

## 现状检查与实施边界

先阅读 `AGENTS.md`、两份架构/实施文档及 Phase 1 / Phase 2 验收记录，再检查 ACP、Core、SQLite、Hono HTTP/WS、Bun TUI 和测试。Phase 2 已具备 Project 路径规范化、会话独立 Worker、单活动 Turn、权限 CAS、取消、请求 hash/UUID 去重、事件分页及基本恢复。缺口集中在全局状态可见性、持久草稿/最近选择和跨 TUI 的未确认提交识别。

保留 Project root 的 realpath 校验、重复路径去重、无效目录拒绝与 API 重绑；存活 Worker / Turn 继续阻止删除或重绑。Conversation 继承真实 Project root，Worker 进程 cwd 和 ACP `session/new.cwd` 都来自绑定路径。没有把启动 Shell cwd 当作默认 Workspace。

## 实现清单

| 文件 | 实现 |
| --- | --- |
| `packages/shared/src/session-state.ts`, `index.ts` | 草稿、偏好、活动汇总 DTO / Zod schema；版本 0.3.0 |
| `packages/storage/src/schema.ts`, `index.ts` | `conversation_drafts`、`ui_preferences`；草稿 revision CAS；只消费对应 requestId 的草稿；最近 Project/Conversation 外键；SQLite 一致快照中的全局活动/审批/异常汇总 |
| `packages/storage/migrations/0002_lean_mordo.sql`, `meta/*` | Drizzle 增量迁移；不修改前两次 SQL，旧库迁移前备份 |
| `packages/storage/src/runtime.ts` | 保留活动 Turn 的 UNCERTAIN 恢复；补齐空闲失效原生会话的 INTERRUPTED 状态及历史边界；旧审批 EXPIRED |
| `packages/core/src/runtime.ts` | 在现有提交/去重路径消费对应草稿；拒绝新增已知凭据类 env override；其余执行、取消、审批复用现有 Runtime |
| `apps/daemon/src/index.ts`, `runtime-routes.ts` | 草稿、偏好、只读请求查询 API；WS ping/pong；HTTP 限制调整为 1 MiB 以容纳完整 Unicode 草稿及提交预留 |
| `packages/shared/src/client.ts` | 保留订阅后 SQLite seq 补拉；增加握手超时、定期权威补查、失败连接终止与重连；跨 Conversation 校验；可按页通知 TUI，降低长历史重建次数 |
| `apps/tui/src/index.tsx` | 全局运行/审批/异常计数、树中真实状态、共享目录风险提示；最近选择恢复，显式路径优先；Ctrl+G 汇总偏好；正常退出补存草稿/偏好 |
| `apps/tui/src/draft-session.ts`, `agent-pane.tsx` | 草稿有序自动保存、切换/退出补存；发送前持久化 requestId；重开只查提交结果，不自动发 Prompt；未确认请求显式重试沿用同一 ID；离开会话保存失败仍保留待补存文字并全局提示；旧面板异步返回不关闭新面板表单 |
| `apps/tui/src/native-events.tsx` | 原样展示 Session ready / 中断 / Worker 丢失边界；没有完整 Markdown / Changes UI |
| `tests/integration/phase3.test.mjs`, `tests/fixtures/mock-acp/server.mjs` | 新增 9 项真实 Daemon/SQLite/Mock 子进程集成测试及长历史/定时输出场景 |
| `tests/e2e/tui.test.tsx`, `scripts/test.ts` | 共 8 项 Solid 测试；新增草稿/最近选择、后台审批、提交预留恢复及离开会话时网络失败补存 |
| `scripts/verify-phase3.mjs`, `tests/e2e/phase3-terminal.py` | 显式真实双 Harness、双项目、三 PTY、退出保活/重开及一次 Prompt 验证；隔离 XDG，保留证据，绝不自动审批 |
| manifests、`bun.lock`、`README.md` | Workspace 版本统一 0.3.0，依赖版本未升级；使用与恢复说明 |

## 状态及数据契约

- 不同 Conversation 可同时运行，同一 Conversation 仍由原有唯一活动 Turn 约束保护。共享目录没有全局互斥：后提交的 Turn 保存冲突警示；选中的 Conversation 发现同路径后台活动时，TUI 同样提示文件冲突风险。
- `/v1/snapshot` 增加 `activity`：活动数、待审批会话数/请求数、异常数及带 Project/Conversation ID、活动 Turn ID 的条目。Running 包含 PREPARING / RUNNING / WAITING_APPROVAL / CANCELLING，与 Approval 数量有重叠。异常为 ERROR / INTERRUPTED / UNCERTAIN。沿用全局 metadata WS 通知，重连读取完整一致快照。
- `GET/PUT /v1/conversations/:id/draft`：`{conversationId,text,revision,pendingSubmission}`。PUT 必须携带当前 revision，成功递增；过期写返回 409。未提交预留包含原始 requestId / harnessId / message，且 message 必须等于草稿文字。草稿最多 100,000 个 UTF-16 单元。删除应用元数据级联删除草稿，不删除用户文件。
- `GET/PATCH /v1/preferences`：最近 Project/Conversation、`showActivity`；检查关系及外键，删除后清空失效引用。多个 TUI 当前选择不互相跳转，最近记录按最后一次保存生效。没有持久化完整滚动、焦点或 UI 快照。
- `GET /v1/requests/:requestId` 只查询持久 Turn。TUI 发送前保存提交预留；服务端接受或命中已有请求后只消费匹配草稿。响应丢失/崩溃窗口通过只读查询识别已记录请求；未记录的预留仍保留，只有用户显式 Enter 才以同一 requestId 重试。WS 重连、TUI 重开、Daemon 重启都不会主动提交 Prompt。
- Conversation 事件按各自 seq 严格连续，事件先提交再推送；WS 用作补拉提示。客户端按 200 条分页、去重并检查 Conversation ID / 连续序号；每 3 秒权威补查，WS 有 4 秒握手超时及服务端 15 秒 ping/pong。历史读取失败终止失效连接再重连，重新读取实例端口/凭据。没有重放发送或审批命令。
- Daemon 存活时重开 TUI 复用其现有 Worker 和原生会话。Daemon 崩溃后，未结束 Turn 保守标为 UNCERTAIN，旧 NativeSession 为 INTERRUPTED、待审批过期；空闲且原生状态丢失的 Conversation 也显示 INTERRUPTED。不会把保存的原生 ID 当作活连接，不自动 load/resume、不重放任务；UNCERTAIN 阻止新请求。

## Profile 敏感环境变量边界

Worker 原有启动方式继续继承 Daemon 环境，不读取/改写 Codex、Claude、Grok、OpenCode 的模型、Key、Base URL 配置。新增 Profile 对已知 API Key / Token / Secret / Password 等变量名拒绝明文 override，错误只说明边界，不打印值；普通 override 仍可使用。

列表/API 只返回变量名，`sensitiveEnvOverrideKeys` 标出升级前已有的敏感名称。旧 Profile 值不被自动删除，以免静默改变用户启动配置；仍位于 0600 的私有 SQLite，其备份也可能含旧值。应先正常停止相关 Worker，在原生登录/继承环境可用后重新注册不含敏感值的 Profile。变量名检测不能识别任意自定义名称、args 或自然语言中的所有秘密；不应把凭据嵌入启动参数。默认日志继续不记录完整 Prompt、工具输出、Worker stderr 或 env 值。

## 自动化验证

最终成功的自动化证据：`/tmp/hhu-phase1-9oT6bW`、`/tmp/hhu-phase2-qibHb0`、`/tmp/hhu-phase3-09nIi6`。测试使用隔离 XDG 和临时项目，结束时正常停止测试 Daemon。

| 命令 | 结果 |
| --- | --- |
| `bun install --frozen-lockfile` | 通过；固定依赖未变 |
| `bun run db:generate` | 生成 schema 3 增量 SQL / journal / snapshot |
| `bun run typecheck` | 通过，含独立 Node-only Daemon 类型检查 |
| `bun run lint` | 通过 |
| `bun run build` | 通过；测试及本地安装均使用构建产物 |
| `bun run test` | 32 项 Node 集成测试（Phase 1: 10，Phase 2: 13，Phase 3: 9）+ 8 项 Bun/Solid 测试全部通过 |
| `bun run install:local` | 通过，实际安装 `~/.local/bin/hhu` |
| 在 Home 运行 `hhu --version`、`hhu doctor`、Daemon start/status/stop | 0.3.0；本机运行时检查、启动和正常停止通过 |
| `HARNESSHUB_PTY_LAUNCHER="$HOME/.local/bin/hhu" node scripts/verify-phase3.mjs` | 两个真实 Harness 从 Home 的全局 hhu PTY 提交、并行、退出保活、同原生会话重连、各一次 Prompt，全部通过 |
| `git diff --check` | 通过 |

本阶段新增测试覆盖：不同项目与相同 workspace 并发、独立 cwd/原生会话/审批及取消隔离、后台两个并发审批、真实 TCP 代理断开两客户端 WS、2,505 个原生文本分块的多页历史补拉、序号/事件 ID 去重、Daemon SIGKILL 后 watcher 跨新端口/Token 追平、空闲中断与活动不确定状态、旧审批失效、10 个并发相同请求只执行一次、草稿 CAS/8 客户端写竞争、Unicode 大草稿/长度限制、重启持久化、提交预留的崩溃窗口、失效路径/重绑、删除外键与用户文件保留、凭据继承及日志边界。

完整运行中曾遇启动器 10 秒等待超时；当时 Daemon 实际已启动，未观察到数据损坏或任务重放。保留该次失败证据 `/tmp/hhu-phase1-uTNfXM`、`/tmp/hhu-phase3-3UjMWi`；原因未确证，后续针对 Phase 1/3 的运行和最终完整检查通过。启动等待仍为 10 秒，不能宣称超高负载下一定无超时。真实 PTY 脚本的可执行路径和 ANSI/流式文本匹配问题已修正，最终通过结果见下节。

## 真实 Harness 与升级证据

最终安装构建证据：`/tmp/hhu-real-phase3-QXWMc3/evidence.json`，原始 ACP / 结构化事件在同目录的 `data/harnesshub/harnesshub.db`。三个 PTY 都从 `/home/clj` 执行已安装的 `~/.local/bin/hhu`；两个初始 TUI 提交任务，全部退出后再打开第三个。断言退出时仍有未结束任务、重开后 NativeSession ID 不变；任务结束后隔离 Daemon 正常停止，没有强杀。

| Harness | Workspace | Conversation | Turn | 结果 |
| --- | --- | --- | --- | --- |
| Codex | `/tmp/hhu-real-phase3-QXWMc3/project-1` | `0d9cc1f7-7c60-4f8e-90d7-4719f74fa077` | `4f4a9bdd-5209-4e01-88fd-6db9ad72d628` | COMPLETED；132 个事件；1 次 Prompt；正确 cwd / 哨兵，Node 测试 1 pass / 0 fail |
| Grok | `/tmp/hhu-real-phase3-QXWMc3/project-2` | `cb3f7f62-e433-458d-8f9c-2bb2fb69db11` | `0708afbd-0756-4596-b8f6-58bcfd23d724` | COMPLETED；192 个事件；1 次 Prompt；正确 cwd / 哨兵，Node 测试 1 pass / 0 fail |

真实任务为读取 `smoke.txt`、打印 cwd、`sleep 12` 后运行 `node --test smoke.test.mjs`；不修改项目文件、不调用网络工具、不派生子 Agent。本次两者没有请求原生审批；后台审批与多客户端竞争使用共享 Runtime 的真实 Mock 子进程及 TUI 验证，不能据此声称真实 Codex/Grok 审批均已人工验收。沿用的协议/入口和版本证据见 [兼容性记录](../COMPATIBILITY.md)。

默认目录原有 0.2.0 Daemon 经检查没有活动任务，通过原有受控 stop API 正常停止后才安装。随后实际启动 0.3.0 迁移默认库：schema=3，6 个 Project、16 个 Conversation 全部保留，迁移前备份存在。检查后默认 Daemon 正常停止。真实验证与自动化临时目录保留，没有强制删除用户文件。

## 已知限制与未验证

- Windows Terminal / VS Code WSL 人工验收、真实 Shift+Enter 键码尚未验证；Linux PTY / Solid 测试不能替代。完整 Markdown、Changes、虚拟列表/极长历史性能留给 Phase 4，本阶段仅验证数千事件正确分页和有序恢复。
- 每 150ms 自动保存输入，切换/正常退出补存；TUI 被 SIGKILL、终端突然断电时，最后尚未落库的输入可能丢失。保存失败会提示并保留待补存文字；Ctrl+Q 是用户明确放弃尚未保存编辑的出口。同草稿版本冲突不做协同合并，请先保留本地文字再重新打开已保存版本。
- 最近选择/基础偏好为本机共享、最后写入生效；其他 TUI 不自动跳转，也不实时合并正在编辑的草稿。
- 没有逐 Agent 验证安全原生 load/resume，因此崩溃后仅恢复可观察历史。旧进程可能在 Daemon 失联后仍有原生侧副作用，UNCERTAIN 需要检查历史、文件和原生进程；不依据旧 PID 自动杀进程，也不自动重试。
- 根目录重新绑定仍通过现有 PATCH Project API，未扩展完整项目管理 UI；存活 Worker/Turn 必须先正常停止。自定义 Agent 的 Client fs/terminal 能力限制沿用 Phase 2。
- 本阶段没有 Handoff / Worktree，没有新增审批绕过或自动批准；不会自动开始下一阶段。

## 用户人工验收步骤

1. 两个终端从 `~` 执行 `hhu`。选择/注册两个不同的真实 Project，各建 Conversation；核对 Workspace 是 Project root。选择已有路径无需重输，显式 `hhu /path` 优先打开该 Project。
2. 各选一个已登录的 Harness，按 `m` 输入无害读取、`pwd` 与项目测试任务，可加入 `sleep 12` 方便观察并发。Enter 发送；核对原生输出中的路径和文件内容。两个 Conversation 可同时 RUNNING，树和顶部显示后台状态；同目录并发应有冲突提示。
3. 在另一个 Conversation/Project 浏览时，让后台 Agent 请求权限；顶部/树应显示 WAITING_APPROVAL。切回相应会话，按 `a` 查看 Agent 原始候选，由用户明确选择编号。另一 TUI 重复决策同一审批应被拒绝。取消另一会话不应取消此审批或串历史。
4. 运行中按 `q` 关闭所有 TUI，使用 `hhu daemon status` 检查 PID 不变；再次 `hhu`，确认最近选择、同一原生会话及后续流式事件恢复。多客户端断开/重连不应产生新的 user.message 或 session/prompt。
5. 在两个 Conversation 分别输入多行草稿，Esc 后切换，再退出/重开并按 `m`，核对各自草稿。Ctrl+G 切换汇总，重开应保留。两个 TUI 同时编辑同一草稿时，过期保存应报冲突，不能覆盖另一端已保存的文字。
6. 断线时发送后重开 TUI，核对历史或通过 `GET /v1/requests/:requestId` 查询已记录 Turn；只应补拉历史。未确认提交若需用户显式重试，必须沿用原 requestId。不要以新 ID 自动重发有副作用任务。
7. Daemon 崩溃验收建议运行隔离 Mock：`HARNESSHUB_BUN="$(command -v bun)" node --test tests/integration/phase3.test.mjs`（先 `bun run build`）。如人工终止 Daemon，只在隔离环境及无副作用测试中对确认的 Daemon PID 操作；重启后活动任务必须 UNCERTAIN、空闲原生会话 INTERRUPTED、旧审批失效，历史仍可读，不应自动执行。
8. 检查 `hhu agent list` 的 Profile 变量名/旧敏感字段提示；新敏感 override 应拒绝，原生环境继承仍可用。`hhu daemon logs` 不应包含完整 Prompt、Token 或工具正文。分别在 Windows Terminal 和 VS Code WSL 重复键位、切换、审批、退出/重开步骤并记录结果。
