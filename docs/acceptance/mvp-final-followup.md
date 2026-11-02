# MVP 最终验收跟进：OpenCode 兼容性调查

首次调查：2026-10-31；授权后复测：2026-11-01（America/Los_Angeles，UTC 为 11-02）。版本保持 **0.6.0 / schema 6**；这是最终验收问题调查，没有启动新阶段。

**最新结果：用户允许使用既有登录后，原生 CLI（显式 --dir）、直连 ACP 与 HarnessHub Runtime 均真实通过纯文本、读取和 pwd。旧 UNCERTAIN 隔离 Worker/Daemon 已按用户确认清理。** 初次全隔离失败证据仍保留，详见末节授权后复测；不能将全隔离 Big Pickle 的限制改写为通过，MVP 仍待 Windows 双终端人工验收。

## 结论与证据边界

**发现了真实验证环境的差异，尚未发现 HarnessHub Runtime 的兼容性缺陷。** Phase 2 和 Phase 6 的 OpenCode 都是 1.18.32，但实际协商的模型不同：前者为 `codeforce/baizhi-cloud/grok-4.6`，后者为 `opencode/big-pickle`。Phase 6 脚本重新指定全部 XDG 配置、数据和状态目录，不能视为在相同原生配置/认证环境下复测。

本轮在完全临时环境中，以最简单的纯文本任务直接调用 `opencode acp`，**不使用 HarnessHub 或 ACP SDK**，仍复现 120 秒无文本/工具、cancel 后 `end_turn` 与零 usage。原生 `opencode run --format json` 也在全隔离环境中 120 秒无 JSON 输出。由此可确定原症状可以发生在 HarnessHub 之外；不能把它归因于 Runtime 吞事件。

只保留原生配置路径、仍隔离数据/状态/缓存时，ACP 重新协商到 Phase 2 的 CodeForce 模型，但返回 `-32603 / Internal error: Missing Authorization header`；原生 CLI 返回 HTTP **401**、`APIError`、`isRetryable=false` 及相同错误正文。HarnessHub 接收到的原始错误也完全一致。**这是这一环境组合的明确认证错误，不是权限等待。** 没有检查认证文件或服务端日志，不能进一步断言认证保存位置、原账号失效、Key 错误或网关故障，也不能将这个 401 当作 Big Pickle 无输出的具体原因。

因此没有修改生产 Runtime、ACP 初始化、模型/权限策略或取消状态。初次调查时 Big Pickle 等待的上游具体原因、使用既有登录环境的当前工具能力均未确认；后者已在用户授权后完成复测。**不将初次失败改写为成功，也不将当前基础消息/工具通过扩大为全部 OpenCode 能力或 MVP 最终验收通过。**

## 隔离与安全约束

- 新增 `scripts/verify-opencode.mjs`，仅显式运行才调用真实 Harness；每次创建 `/tmp/hhu-opencode-followup-*`，Project 位于其 `project/`。Runtime 模式创建新的 Project / Conversation / NativeSession，数据库、实例、日志及 HarnessHub 配置全部临时隔离。
- 三种入口：`cli`、不经 SDK 的逐行 JSON-RPC `acp`、真实 HTTP/SQLite 的 `runtime`。两种环境：`isolated` 全隔离；`native-config` 仅让 OpenCode 自己使用继承的 `XDG_CONFIG_HOME`（未设置时为 `~/.config`），数据、状态、缓存仍独立。Runtime 用临时 Profile 的环境覆盖实现这一对照，HarnessHub 自身配置仍在临时目录。
- 没有读取/复制/编辑原生模型、API Key、Base URL 或认证配置；没有指定模型、发送 `session/set_config_option` / `session/set_mode`、传入 `--auto` 或应答允许权限。
- 历史 Phase 2 仅以 SQLite readonly 查询指定 Conversation 的事件/Turn，以及读取旧验证的 `evidence.json`；没有启动、迁移或修改用户默认 HarnessHub 数据库，没有让 Agent 在用户项目执行任务。
- 每次纯文本请求使用不同随机 marker；每次只提交一次。纯文本成功后才进入只读文件，再成功才运行一次 `pwd`。失败、权限请求或超时即停止该阶梯，不重发、不切模型、不自动进入工具任务。
- ACP 普通请求边界 20 秒，Prompt 120 秒；取消后等待 15 秒。权限请求只触发取消，不选择原生选项。CLI 120 秒后 SIGINT；它的进程退出不能冒充 ACP `cancelled`。没有 SIGKILL 或默认强制关闭。
- 时间戳、请求/响应、原始 stdout/stderr 只写显式探针的私有证据，目录 0700、文件 0600；不增加应用默认日志。原始诊断可能包含原生文本及服务端元数据，不应直接公开。

## Phase 2 / Phase 6 对比

| 项目 | Phase 2 | Phase 6 | 本轮对照 |
| --- | --- | --- | --- |
| OpenCode | 1.18.32 | 1.18.32 | `--version` 及 ACP agentInfo 均为 1.18.32 |
| ACP SDK | 2.2.0 | 2.2.0 | Runtime 仍为 2.2.0；另做无 SDK 的 wire 对照 |
| initialize | v1；clientInfo HarnessHub 0.2.0 | v1；HarnessHub 0.6.0 | wire 对照使用 0.6.0 |
| Client 能力 | fs read/write=false，terminal=false | 相同 | 相同；没有补造能力 |
| session/new | 绑定临时 Project 的绝对 cwd，mcpServers=[] | 相同，路径为另一个临时 Project | 每次均为新的临时 `project/`；进程 cwd 同步绑定 |
| Agent 能力 | load、close、fork、list、resume 等 | 相同 | 相同；宣告不代表恢复已经验证 |
| 原生模型 currentValue | codeforce/baizhi-cloud/grok-4.6 | opencode/big-pickle | 全隔离为 Big Pickle；保留配置路径为 CodeForce |
| 模型选项 | CodeForce + OpenCode 列表 | 仅 OpenCode 列表 | 保留配置才出现 CodeForce；各次 OpenCode 免费模型列表有变化，未将目录固定性当作兼容保证 |
| 模式 | build（另有 plan） | 相同 | 相同；没有设置请求 |
| 环境 | 旧脚本继承 Daemon 环境 | config/data/state 全部换临时路径 | 分开对照配置路径；cache 也临时隔离 |
| 执行 | 原生 read/bash，Node 测试 1 pass；约 17.5 秒 | 120 秒无文本/工具；cancel 后 end_turn | 见下方逐项记录 |

Phase 2 原始依据：`/tmp/hhu-real-acp-2kyIog/evidence.json` 与默认库指定 Conversation `d7fead93-95bb-443e-a966-5e236bd4d931`。其 seq 1/3 为 initialize/session/new；seq 4/11 的 session/new 返回都选择 CodeForce。真实 Turn `9756340c-db8e-49ab-8a9e-1994fac8ed46` 关联 NativeSession `554bc485-7f7e-4b84-95fd-898f591621b6`，COMPLETED/end_turn，创建/结束相差 17,481ms。旧脚本结果对象的预先握手 sessionId 与真实 Turn session 不能混为一谈。

Phase 6 原始依据：`/tmp/hhu-real-phase6-mwxQPP/opencode-debug.json`。seq 1/3 为客户端请求；seq 2/4 为服务端握手/建会话结果；seq 6 为 available_commands；seq 8 为 Prompt；约 120,016ms 后 seq 10 发 cancel；seq 11 usage_update used=0，seq 12 Prompt 返回 end_turn/零 tokens；seq 13 为应用完成记录。没有 agent_message_chunk、tool_call、权限请求或 ACP error。available_commands 的描述只是原始数据，不作为本次执行指令。

## 本轮真实执行

统一命令如下；每次调用生成新目录、新 marker，绝不恢复或重发旧会话：

```bash
bun run build
node scripts/verify-opencode.mjs cli isolated
node scripts/verify-opencode.mjs acp isolated
node scripts/verify-opencode.mjs cli native-config
node scripts/verify-opencode.mjs acp native-config
node scripts/verify-opencode.mjs runtime native-config
node scripts/verify-opencode.mjs runtime isolated
```

| 入口 / 环境 | 私有证据目录后缀 | 客户端已发送 | 服务端实际可观察结果 | 边界与取消终态 |
| --- | --- | --- | --- | --- |
| CLI / isolated | `5lt8vP` | argv 纯文本、stdin EOF；不代表已证实上游收到请求 | stdout 无 JSON 事件；没有可观察的模型响应或工具 | 120,000ms 超时；SIGINT 后 98ms 进程退出，signal=SIGINT；模型执行终态未知 |
| ACP / isolated | `PgLqNU` | initialize、session/new、一次 Prompt；wire.jsonl 按时间记录 | 握手成功；Big Pickle/build；available_commands；无文本/工具/权限请求 | 120,070ms 后 cancel；94ms 内 usage=0、end_turn；session/close={}，进程 code=0 |
| CLI / native-config | `pKAIdf` | argv 纯文本、stdin EOF | error JSON：HTTP 401 / Missing Authorization header / isRetryable=false；无文本/工具 | 总计 5,161ms，进程 code=1；未取消、未重试 |
| ACP / native-config | `HsilaO` | initialize、session/new、一次 Prompt | CodeForce/build；约 1,807ms 返回 -32603 / Missing Authorization header；无文本/工具/权限 | 无需 cancel；session/close={}，进程 code=0；Prompt 本身失败 |
| Runtime / native-config | `xWwgLE` | HTTP 202 后 raw seq 9 为真实 session/prompt | seq 10 原样收到同一 -32603；发 Prompt 到错误约 1,718ms | Runtime 保守记录 UNCERTAIN/prompt_result_unknown；未重发；普通停机拒绝，见下文 |
| Runtime / isolated | `GL8Lgh` | 新 Project/Conversation；raw seq 9 为一次纯文本 Prompt | Big Pickle/build；0 文本/工具/权限；seq 12 零 usage，seq 13 end_turn | wire Prompt 至 cancel 120,048ms；cancel 至结果 141ms；COMPLETED/end_turn，探针仍失败；Daemon 正常停止 |

完整路径前缀均为 `/tmp/hhu-opencode-followup-`；每个目录的 `evidence.json` 是汇总，ACP 的 `wire.jsonl` 区分 client/server 且逐条落时间；CLI 的 `text.jsonl` 保留实际 stdout；Runtime 的 `runtime-debug.json` 保留 SQLite raw/normalized 事件。客户端写出 ACP Prompt 并不证明模型网关已接受请求；无上游日志的超时不会推断为网关成功或失败。

**探针自身的无效实验保留说明**：最早 CLI 两次（`48GUwV`、`p6iUoM`）漏关闭 stdin，原生 run 会等待管道 EOF，不能用它们证明模型无输出。已修正为 argv Prompt 后立即 stdin.end，再用全新目录/marker 执行上述有效对照；没有重发相同任务。

## 修改与回归

新增诊断脚本及本记录，更新 `docs/COMPATIBILITY.md` 的当前结论入口；原 Phase 6 失败证据保留。生产 Runtime、四个内置 Profile、依赖、版本、migration、Handoff、Worktree、TUI 均未修改。没有证据支持修改 Runtime，因此没有为了使 OpenCode 测试通过而放宽成功/取消断言，也没有将 mock 当作真实验证。

实际执行 `bun run typecheck`、`bun run lint`、`bun run build`、`bun run test`：全部通过。完整测试 **70 项 Node 集成 + 32 项 Bun/Solid = 102 项，0 失败、0 跳过**；日志 `/tmp/hhu-mvp-followup-test.log`。既有 Codex/Claude/Grok 通用协议、权限一次决定、取消末尾事件、WS 补拉、Handoff 去重/UNCERTAIN、Worker 后代退出与 Worktree 安全测试全部保留。真实复测限于本问题的 OpenCode；没有把 Phase 6 的其他 Harness 历史结果重新记为本轮真实通过。

收尾再次执行 typecheck、lint、build 和 `git diff --check` 通过。真实探针六组均按事实返回非零退出码，没有将握手成功、错误后 code=0 的 ACP 进程退出或取消后的 end_turn 计为任务成功。官方网站请求本轮返回 403，尝试的官方版本源码路径返回 404；没有以不可获取的网页证明本机行为，以上判断仅基于可复核的本机版本、旧 wire/SQLite 和本轮真实请求/响应。

## 进程与剩余验收

`xWwgLE` 的隔离 Daemon PID **1881503**，Conversation `36c81fb9-5c85-4564-8466-eed8f2eed9ca`，Turn `57dc5e10-4f91-464e-80d6-5dacabac6d87`。原生明确返回错误后，现有 Runtime 仍保守将“已提交但未成功获得 PromptResponse”的回合标 UNCERTAIN；普通 stop 被安全保护拒绝。实例在该目录 `state/harnesshub/instance.json`，未默认 force、删库、杀进程或清除不确定状态。若用户明确允许强制清理，应先核对实例身份/进程，再只针对该隔离 Conversation 调用 `session/stop` 的 `force=true, confirmed=true`，然后普通停 Daemon；不能凭本文旧 PID 发信号。

初次调查的文件读取和 pwd 阶梯**未验证**：六组有效环境都未通过纯文本门槛，因此没有继续发工具任务。随后用户明确允许使用既有原生登录并清理隔离 Worker，实际结果见下节；没有读取/迁移认证材料。

Windows Terminal / VS Code WSL 的物理键盘、鼠标、剪贴板验收仍须按 [人工清单](windows-terminal-checklist.md) 分别完成；本次没有这些环境的人工结果。Claude/OpenCode 的真实 Handoff、四者所有真实权限场景及原生恢复边界仍沿用 Phase 6 未验证项。**不宣布 MVP 最终通过，不进入 Phase 7。**

## 用户授权后的既有登录对照（2026-11-01）

用户明确回复“确认允许”，授权使用现有 OpenCode 登录环境，并强制清理上次隔离的 UNCERTAIN Worker。新增显式 `native-login` 探针模式：仅 OpenCode 子进程继承原生 config/data/state/cache 的 XDG 路径或标准 Home 默认路径。没有打开、复制或修改认证、模型、Key、Base URL 配置。原生 OpenCode 会写入测试会话历史；HarnessHub Daemon 的四个 XDG 路径始终留在新临时目录，通过临时 Profile 仅向 OpenCode Worker 传递原生路径，不接触默认 HarnessHub 库/实例。

执行命令：

```bash
node scripts/verify-opencode.mjs cli native-login
node scripts/verify-opencode.mjs acp native-login
node scripts/verify-opencode.mjs runtime native-login
```

直连 ACP 与 Runtime 的 currentValue 均为 `codeforce/baizhi-cloud/grok-4.6` / `build`，无需 `session/set_*`、模型替换或权限应答。均在临时 Project 执行三个不同 Prompt，保留原生 streaming 思考、文本、read/bash 工具事件与 end_turn 返回，120 秒内完成，没有取消、超时或权限请求。

| 入口 | 证据目录后缀 | 纯文本 | 读取 sentinel.txt | 原生 pwd | 关闭 |
| --- | --- | --- | --- | --- | --- |
| 原生 CLI，显式 --dir | `n6kovx` | 6,705ms，精确随机 marker | 11,243ms，read completed、哨兵匹配 | 8,873ms，bash completed、exit=0、目录匹配 | 三个 CLI 进程均 code=0 |
| 不经 SDK 的 ACP | `Tdp3z1` | 4,817ms，精确随机 marker，0 工具 | 5,519ms，read 成功、哨兵匹配 | 6,426ms，bash 成功、目录匹配 | session/close={}，进程 code=0 |
| HarnessHub Runtime | `zEVv7w` | Turn 5,362ms，首文本距 wire Prompt 4,888ms | Turn 5,899ms，首文本 2,827ms，1 工具、哨兵匹配 | Turn 4,504ms，首文本 4,228ms，1 工具、目录匹配 | 普通 Daemon stop 成功，实例已移除 |

Runtime Conversation 为 `e8f15afb-4092-4c87-a88e-3352f64738d8`，三个 Turn 均为 COMPLETED/end_turn；0 approvals，raw/normalized 事件分别 39/55/30 条。Worker 进程 cwd、session/new.cwd 及工具 pwd 都是 `/tmp/hhu-opencode-followup-zEVv7w/project`。该目录 `runtime-debug.json` 是停止前完整导出，因此其 session 快照为 READY；实际停止成功以 `evidence.json.shutdown`、实例文件移除及受控退出核对为准。

原生 CLI 第一次对照 `5K1qIW`：纯文本 8,486ms 成功；读取 17,062ms 失败，模型实际尝试 `/home/clj/HarnessHub/HarnessHub/sentinel.txt` 等错误路径，原生 read 返回 File not found，另有原生权限拒绝。没有读取到哨兵，没有向该失败阶梯继续发送 pwd，也没有自动应答允许权限。虽然子进程 spawn.cwd 已设置为临时项目，原生 CLI 仍表现出目录不一致；仅凭此不能确定来自原生 CLI 的路径解析、继承 PWD、会话上下文还是模型工具参数。探针改为使用本机 `opencode run --help` 明确支持的 `--dir <workspace>`，随后使用全新目录/marker 重新执行 CLI 阶梯，三步全部成功，保留原失败而不放宽断言。CLI 每步为新原生会话；两条 ACP 路径则在单个新会话连续执行三步，未宣称二者内部上下文完全等价。ACP 两条路径一直显式发送 session/new.cwd，不受该 CLI 对照差异影响。

结论：**当前既有登录下的 OpenCode ACP 基础消息/原生工具与 HarnessHub Runtime 真实通过。Phase 6 失败与测试将原生 XDG 配置/登录环境替换这一差异相符，不是已证实的 Runtime 回归。** 同一 CLI 版本的原生登录环境可工作，全隔离环境则选择另一模型，不能用后者推翻前者，也不能用前者解释 Big Pickle 的具体上游卡点。仍未证明全隔离默认模型可用、真实取消返回 cancelled、OpenCode Handoff/恢复或所有权限场景通过。

已授权清理：读取 `xWwgLE` 实例后通过 health 校验 instanceId/PID，核对指定 Conversation 与实际 Daemon cmdline，仅调用其 `session/stop {force:true,confirmed:true}`，返回 stopped=true；随后 `/v1/daemon/stop {}` 返回 stopping=true。实际未需手工发 SIGKILL；旧 Daemon 1881503 / Worker 1881570 均已退出，实例文件移除。证据 `/tmp/hhu-opencode-followup-xWwgLE/authorized-cleanup.json` 保留清理前后 session 元数据。历史 Turn 的 UNCERTAIN 不被篡改为成功，没有重放 Prompt、删除项目、库或证据。

授权后收尾再次完成 `bun run typecheck`、`bun run lint`、`bun run build`、`bun run test` 和 `git diff --check`，均通过。完整 **70 项 Node 集成 + 32 项 Bun/Solid UI，102 项，0 失败/跳过**，日志 `/tmp/hhu-mvp-followup-native-login-test.log`。复测三个成功目录的证据文件为 0600、目录 0700；本轮 OpenCode 进程已全部退出，Runtime 的临时实例移除，没有遗留需再次强制清理的 Worker。原有依赖、版本、生产 Runtime 和测试断言不变。
