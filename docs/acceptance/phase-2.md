# Phase 2：Generic ACP Runtime 和真实 Agent 接入

日期：2026-10-31。范围仅 Phase 2；未实施 Phase 3 的完整多会话/恢复体验、Phase 4 完整 TUI、Phase 5 Handoff / Worktree。

## 交付结果

实现共享 ACP v1 Runtime，四个内置 Harness 和自定义 command/args/env Profile 使用同一个 `@agentclientprotocol/sdk@2.2.0` Client。Codex、Claude Code、Grok Build、OpenCode 均已在真实进程中完成初始化、创建原生会话、流式输出、原生工具读取、打印实际 cwd 和执行 Node 测试（各 1 pass / 0 fail）。真实 Codex 取消返回 `cancelled`；真实 Claude 审批等待用户选择后继续。Mock 与真实测试分开记录。

保留 Phase 1 的 CLI、Project/Conversation、SQLite 和元数据 WS 功能。版本升级至 0.2.0；数据库通过增量 Drizzle Migration 升至 schema 2，原库先备份。没有提交 Git commit。

## 实现文件与职责

| 文件 | 实现 |
| --- | --- |
| `packages/acp/src/index.ts` | `Worker` 托管真实 stdio 子进程、统一 SDK Client、初始化、显式 Client 能力、原始 wire tap、生命周期及四个内置 Profile；直接 spawn，无 Shell 拼接 |
| `packages/core/src/runtime.ts` | NativeSession / Turn 状态、会话复用、去重、原生权限、取消、配置选项、进程断连、安全停机；不实现跨 Harness 交接 |
| `packages/shared/src/runtime.ts` | Zod 输入、DTO、状态及结构化凭据脱敏 |
| `packages/shared/src/client.ts` | `HttpError`、独立 `watchConversation`；WS 建连后按 Conversation seq 分页补拉、去重与重连，仅查询、不重放命令 |
| `packages/storage/src/schema.ts`, `runtime.ts`, `index.ts` | 五张新表、事件序号、审批 CAS、请求唯一约束、单活动 Turn 索引、恢复历史、存活 Worker 的删除/重绑保护 |
| `packages/storage/migrations/0001_illegal_karnak.sql`, `meta/*` | Drizzle 生成的增量迁移；Phase 1 migration 未修改 |
| `apps/daemon/src/runtime-routes.ts`, `index.ts` | 真实 ACP HTTP API、Conversation WS 广播、活动任务 stop guard、SIGINT/SIGTERM 受控停止 |
| `apps/cli/src/agent.ts`, `index.ts`, `lifecycle.ts` | `hhu agent` 操作、requestId 提交前输出、显式原生审批、`daemon stop --cancel-active` |
| `apps/tui/src/agent-pane.tsx`, `native-events.tsx`, `index.tsx` | 最小发送、原生工具和权限、取消；Enter 发送/Shift+Enter 与 Ctrl+J 换行；成功工具折叠、手动展开优先。不是完整 Phase 4 UI |
| `tests/fixtures/mock-acp/server.mjs`, `tests/integration/phase2.test.mjs` | SDK Mock 的真实子进程及状态、故障、权限、序号、停止竞态测试 |
| `tests/integration/phase1.test.mjs`, `tests/e2e/tui.test.tsx`, `scripts/test.ts` | 保留 Phase 1 回归；schema/version 断言适配 Phase 2；增加真实 Daemon 上的 Solid 审批与工具卡片测试 |
| `scripts/verify-acp.mjs`, `README.md`, `docs/COMPATIBILITY.md`, manifests / `bun.lock` | 显式真实入口验证、使用方法、锁定依赖及实际能力矩阵 |

## Runtime 与数据契约

- Worker 的进程 `cwd` 与 `session/new.cwd` 均来自 `projectRoot(conversation.workspacePath)`，绝不取 CLI 启动目录。Mock 同时比较两者；真实四个 Harness 的工具均报告绑定的临时项目目录。
- 首次 Prompt 创建原生 Session；同一 Harness 的后续 Turn 复用当前活 Session。也可先显式创建 Session 检查能力及设置。跨 Harness 提交明确拒绝，等待 Phase 5，而不是偷偷新建无交接会话。
- `PREPARING → RUNNING ↔ WAITING_APPROVAL → COMPLETED/CANCELLED/ERROR/UNCERTAIN`。Conversation 用 IDLE / PREPARING / RUNNING / WAITING_APPROVAL / CANCELLING / ERROR / INTERRUPTED / UNCERTAIN 表示当前状态。取消请求只进入 CANCELLING，必须等 Prompt 的原生结果；取消前准备尚未提交 Prompt 时，取消后不再提交。
- 请求使用全局唯一 UUID `requestId` 和内容 hash。相同请求返回同一 Turn；同 ID 不同内容、同 Conversation 重叠 Turn 拒绝。失败/不确定请求不会自动重试。UNCERTAIN Conversation 阻止后续提交，核实历史和工作区后由用户显式新建 Conversation。
- `native_sessions` 保存 workerId、daemon epoch、Agent sessionId、能力快照、cwd、状态与时间；`turns` 保存请求、状态、首尾事件边界和 stopReason；`approvals` 保存真实 ACP requestId、原始候选与一次性决策；`harness_profiles` 只保存启动描述。
- `conversation_events` 保存完整 JSON-RPC 对象及结构化 payload（按结构化凭据字段定向脱敏）、origin、NativeSession / Turn 关联和 Conversation 自己的单调 seq。wire tap 在 SDK 验证和异步回调前同步提交，未知 session update / 自定义通知仍进入 `custom` 原始详情。原文、Markdown、工具标题、名称、rawInput/rawOutput 均不作语义重写。
- Phase 1 `metadata_changes.seq` 继续单独使用；元数据变更包是 `change`，ACP/Conversation 包是 `conversation.event`。二者互不混作同一消息流。每个事件提交 SQLite 后才推送 WS；WS 是实时提示，客户端订阅后分页读权威历史，跨页按 seq 去重，不重发 Prompt。
- 审批必须是 Agent 原始 optionId。DB 原子 `PENDING → DECIDED`、内存活连接校验和候选校验保证最多决策一次。取消/失联/重启使旧审批 CANCELLED 或 EXPIRED，不能假装仍可审批。HarnessHub 没有自动审批器。
- 模型/模式/推理及其他 config 仅来自 ACP 返回值，设置只发 `session/set_mode` / `session/set_config_option`。未暴露的选项不推断、不补造；没有读取/修改各 Harness 的模型、Key、Base URL 配置。
- 当前 Client 如实声明 fs read/write 和 terminal 均为 false。四个真实 Harness 使用自身原生工具。未实现的 Client 请求返回不支持；需要这些 Client 能力的自定义 Agent 暂不可用。
- 空闲 Worker 不自动回收，TUI 关闭不停止 Worker。关闭空闲 Worker 时，如协商支持先请求 `session/close`，再关闭 stdio、等待退出，必要时 SIGTERM；正常流程不自动 SIGKILL。停止操作锁住该 Session，防止关闭过程中又接收 Prompt。
- `hhu daemon stop` 遇活动任务拒绝。`--cancel-active` 明确请求正常取消，等待最多 5 秒；未确认结束就保持 Daemon 运行。空闲 Worker 并行受控关闭；未确认进程退出也拒绝停机。流断开但进程仍活的 UNCERTAIN Worker 必须显式 force+confirmed，不能按“无活动 Turn”默默杀掉。
- 显式强制停止 API 必须同时 `force=true, confirmed=true`，结果保守记为 UNCERTAIN；只有该路径允许 SIGKILL。没有基于陈旧 PID 杀进程。Daemon 重启只恢复 SQLite 历史，未结束 Turn 标 UNCERTAIN、旧 Session 标 INTERRUPTED、待审批失效；不加载或重放原生任务。
- 共享工作区允许并发，新增 Turn 发现其他活动 Conversation 使用同一路径时记录并展示风险提示。没有全局工作区互斥或臆测文件归属。

主要 API（均沿用 Phase 1 私有 Bearer 认证与禁止浏览器 Origin）：

| API | 行为 |
| --- | --- |
| `GET/POST /v1/harness-profiles`、`GET /v1/diagnostics` | 列表/注册 Profile；只报告可执行入口存在，不冒充握手；env 只返回变量名 |
| `GET /v1/harness-profiles/:id/capabilities` | 已协商的存活会话能力 |
| `GET/POST /v1/conversations/:id/sessions` | 历史 / 显式创建原生会话 |
| `POST /v1/conversations/:id/settings` | 原生 mode/config 的合法选项 |
| `POST /v1/conversations/:id/turns` | `{requestId,harnessId,message}`，202 后后台执行 |
| `GET /v1/turns/:id`、`POST /v1/turns/:id/cancel` | 权威状态 / 正常取消 |
| `GET /v1/conversations/:id/approvals`、`POST /v1/approvals/:id/decision` | 待审批 / `{optionId}` 一次性决定 |
| `GET /v1/conversations/:id/events?after_seq=N&limit=M` | `{events,cursor}`；limit 1..1000，独立 Conversation 序号 |
| `POST /v1/conversations/:id/session/stop` | 空闲正常停止，或显式 force+confirmed |
| `POST /v1/daemon/stop` | 默认拒绝活动任务；`{cancelActive:true}` 先原生取消并等待 |

## 真实 Harness 验证

本机 Linux x64 / WSL2，Node 24.18.0 / Bun 1.4.4；不依赖 Mock 冒充实际服务。SDK、Adapter 和 CLI 版本与官方证据见 [兼容性记录](../COMPATIBILITY.md)。

| Harness | 实际入口与协商 | 原生配置差异 | 真实任务 / 权限 / 取消 |
| --- | --- | --- | --- |
| Codex | 固定 Adapter 2.5.0 的 `dist/index.js` → Codex App Server；ACP v1 成功 | `mode`、`collaboration_mode`、`model`；本次模型未提供独立 effort | 读取 / pwd / `node --test smoke.test.mjs` 完成，1 pass；原生工具标题为 `cat smoke.txt; pwd; node --test smoke.test.mjs`；另一个运行中 Turn 正常取消返回 cancelled |
| Claude Code | 固定 Adapter 0.99.1 的 `dist/index.js` → Agent SDK 0.3.312；ACP v1 成功 | `mode`、`model`、`effort`、`ultracode`；mode 包含 default/acceptEdits/plan/auto/bypassPermissions | 读取和 pwd 成功；真实 Bash 测试请求阻塞等待审批，用户明确选择 `allow-with-updates` 后执行成功，1 pass；名称/标题保留 Agent 的 Read File / Terminal / Bash 信息 |
| Grok Build | 本机 `grok agent stdio`，CLI 1.0.50；ACP v1 成功，未返回 agentInfo | 本次仅 `model`，无 mode/effort selector | 原生 `read_file` / `run_terminal_command`，读取、pwd、Node 测试成功，1 pass；此次未请求审批；取消未单独实测 |
| OpenCode | 本机 `opencode acp`，1.18.32；ACP v1 成功 | `model`、`mode` | 原生 `read` / `bash`，读取、pwd、Node 测试成功，1 pass；此次未请求审批；取消未单独实测 |

原始会话证据保存在默认私有 SQLite，并在以下临时项目留下 `evidence.json`、`smoke.txt`、`smoke.test.mjs`，未删除用户文件：

- `/tmp/hhu-real-acp-2kyIog`：Codex / Grok / OpenCode。Project ID `4ccdfe53-612c-4d54-b0e2-c05b0dde1bbf`；原生工具报告 cwd 等于该目录，哨兵 `HARNESSHUB_REAL_ACP_SENTINEL`。
- `/tmp/hhu-real-acp-Fl7KVk`：Claude。Conversation `7d1029df-0b92-4a96-93ca-d65a85099f10`，Turn `f2c58645-fdad-4da1-8e9e-63ee41be719b`，原生审批 `fc3aa3b9-ad9b-4120-af5a-7b1e8e45e4a4`。原始选项为 `allow-once` / `allow-with-updates` / `reject`；用户在本次对话中明确选择持续允许，HarnessHub 原样转发一次，原生结果 COMPLETED / end_turn。持续权限由原生 Agent 处理，没有新增 HarnessHub 自动审批规则。
- Codex 取消 Turn `cf88cff2-b1f7-45c4-a896-c818dacdeddf`：运行中 tool_call 为 seq 118，取消请求 119、原生 cancel 通知 120、原生 usage/session 尾事件 121..122、prompt cancelled 响应 123、持久化结束事件 124。没有将发送 cancel 当成完成。
- `/tmp/hhu-real-acp-Dta4XD`：补充四入口握手证据。
- `/tmp/hhu-real-acp-tfoydT`：最终构建四入口握手全部通过；随后 `hhu daemon stop` 一次正常完成，四个 Worker 均确认关闭，没有强杀。最后一次并行复核见该目录的 `final-recheck.json`，四者再次 READY 后正常停止。

本机原有 Phase 1 Daemon 经确认 `acp:false` 后使用原 API 正常停止，真实迁移保留原 HarnessHub Project 和空会话并生成备份。真实验证发现并修复了两个兼容问题：Claude 包默认导出是库而非 CLI；部分原生进程清理超过最初 2 秒宽限期，停止保护因此拒绝退出。现先协商关闭 Session、等待实际进程退出，最终四 Worker 正常停止复测通过，未用未确认强杀掩盖失败。

## 自动化验证

最终执行结果以本节为验收基线。自动化证据目录：`/tmp/hhu-phase1-wV5U3u`、`/tmp/hhu-phase2-ChxZaZ`；真实验证结束后默认 Daemon 已正常停止，没有待审批任务。

| 命令 | 结果 |
| --- | --- |
| `bun install --frozen-lockfile` | 通过，使用固定 lockfile |
| `bun run db:generate` | 生成增量 SQL/journal/snapshot；不改 Phase 1 SQL |
| `bun run typecheck` | 通过，包含独立 Node-only Daemon 类型检查 |
| `bun run lint` | 通过，Biome recommended；未通过关闭规则规避检查 |
| `bun run build` | 通过，Bun CLI/TUI + Node Daemon |
| `bun run install:local`、在 `~` 运行 `hhu --version` / `hhu doctor` | 安装通过，实际入口报告 HarnessHub 0.2.0，运行时诊断通过 |
| `node scripts/verify-acp.mjs`、`hhu daemon stop` | 最终构建四入口真实握手通过，正常停止通过 |
| `bun run test` | 23 项 Node 集成测试（10 项 Phase 1 回归 + 13 项 Phase 2）及 3 项 Bun/Solid 测试，全部通过 |

自动化重点覆盖：

1. 从真实 Phase 1 migration 建库，保留 Project/Conversation 后升级，备份存在且 schema=2；保留原有授权、权限、双 PTY、Daemon 重启和 CRUD 回归。
2. Mock 同时断言 Worker cwd / session/new.cwd，初始化能力、原生 model 选项设置和非法值拒绝。
3. 40 个并发流式分块顺序、工具原始标题/Markdown/字段、未知 update / 扩展、结构化 key 脱敏。
4. 8 个并发相同 requestId 只执行一次；不同内容或重叠 Turn 拒绝；重连不重发 Prompt。
5. 两个原生权限请求阻塞；非法 optionId 拒绝；6 个竞争决策仅一次成功；取消使旧审批失效。
6. 取消后的消息和工具尾事件先于 Turn 结束；重复 cancel 不重复发通知；准备过程中取消不发 Prompt。
7. Worker 崩溃 / 丢失 stdio / Daemon SIGKILL 成为 UNCERTAIN；失效审批不可决定；不恢复假运行或重放；断流但进程存活时要求显式 force。
8. 两 Conversation 的序号互相独立，WS 包等于已提交数据；分页/重新订阅补拉、去重。
9. 普通 daemon stop 拒绝活动 Turn；明确 cancel-active 等尾事件结束；Agent 不响应 cancel 时 Daemon 保持服务；force 必须 confirmed。
10. 协商的 session/close、停止过程的 Prompt 竞争防护；不可用可执行程序保留可追溯错误；日志没有完整 Prompt、工具输出或 env 值。
11. 真正 Solid 组件通过真实 HTTP/WS 显示原生权限，用户编号选择后才响应；成功工具自动折叠、手动展开在后续更新中保留。

## 已知限制与未验证项

- Windows Terminal / VS Code WSL 的人工 TUI、真实 Shift+Enter 键码、原生审批键盘体验仍为 **未验证**；当前验证为 Linux PTY、Solid renderer，以及真实 Agent 的 API/用户原生选项回路，不能冒充目标终端人工验收。
- 四者都已实际使用原生工具执行任务；真实取消专门验证 Codex，其他 Harness 的取消/异常覆盖来自共享 Runtime Mock，未宣称逐个真实取消均通过。Claude 真实审批在本次对话选择后经 API 原样提交；真实 Harness 在 HarnessHub TUI 内的审批动作仍需用户验收。
- 模式/模型/推理设置通过 API/CLI 操作，完整 TUI 选择器、Markdown 高亮、虚拟列表、滚动和长历史性能属于 Phase 4。本阶段 TUI 原样显示 Markdown 文本及原始详情，没有摘要改写。
- 原生 load/resume 虽有协商能力，安全恢复尚未逐 Agent 验证，因此不执行。Daemon 重启后历史可读，原生上下文不假装仍在；UNCERTAIN 无自动解锁/自动重试按钮。
- 未声明 Client fs/terminal、AIR、子 Agent、elicitation、ACP v2；依赖这些扩展的自定义 Agent 暂不可用。未登录的 Harness 需先按其原生登录方式处理，当前不提供统一 Key/Login 管理。
- Worker stderr 仅排空并计数，不落默认日志，防止其携带原生凭据/完整工具正文；启动错误可查结构化生命周期和原始协议错误，不能保证 stderr 错误正文可追溯。
- 原始事件保留语义 JSON 对象，不保留 stdio 空白字节/原生 TTY 像素；仅按明确字段名脱敏，无法识别自然语言中所有可能的秘密。私有数据库仍含源码/对话，应按敏感数据管理。
- Native CLI 与 Adapter 版本不同，PATH 覆盖可能改变实际能力，需重新显式握手；没有宣称任意版本或全部自定义 Agent 兼容。测试留下的临时项目及 SQLite 历史保留以便复核，未强制删除。

## 用户人工验收

1. `cd ~ && hhu`，选择现有或用 `p` 注册别处的项目，按 `n` 建会话。选中会话，`h` 选 Harness，`m` 输入“读取项目文件并打印 cwd”，Enter 提交，核对原生内容和真实项目路径。Shift+Enter 应仅换行；终端不支持时用明确显示的 Ctrl+J。
2. 用 Claude 或会请求权限的原生模式执行无害测试。没有选择前应 WAITING_APPROVAL，`a` 后输入原始选项编号并 Enter；另一终端重复同审批应拒绝。不要为验收选择绕过权限模式。
3. 原生任务运行中按 `c`，观察 CANCELLING 后由 Agent 确认结束；另一个终端 `hhu daemon stop` 应先拒绝活动任务。明确 `hhu daemon stop --cancel-active` 后，只有取消与 Worker 退出确认才停止；不响应时应保留 Daemon。
4. 运行 `hhu agent --help`。用 `session` 查看原生能力与当前 model/config，按实际返回值通过 `settings` 修改；未暴露的配置应拒绝，不检查或编辑原生配置文件。
5. 消息运行时退出 TUI，Daemon/Worker 应继续；重新 `hhu` 或 `hhu agent watch <conversationId>` 应从 SQLite 补齐历史。拔断客户端连接只补拉，不重提 Prompt。需核实“请求是否已提交”时，用相同 requestId 查询已有 Turn。
6. `hhu agent register /absolute/profile.json` 接入自定义 ACP Agent；验证真实握手，未知事件可读 raw。仅执行入口存在不能当作成功。
7. 只删除应用元数据不会删除项目文件；存活 Worker 会阻止删除/路径重绑。查看 `hhu daemon logs` 不应有完整 Prompt、Token 或全部工具输出；按 README 核对数据与备份权限。
8. 分别在 Windows Terminal / VS Code WSL 完成上述操作并记录结果。本阶段到此等待验收，不自动进入 Phase 3。
