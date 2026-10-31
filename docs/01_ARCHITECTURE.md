# HarnessHub — 完整技术方案（MVP v1.0）

> 状态：28/28 项设计决策已确定；CLI 可执行命令：`hhu`；产品及 Git 仓库名：`HarnessHub`。
> 平台：Linux x64 / WSL2，local-first，仅 TUI，无 Web UI。
> 本文是工程目标与约束，不代表当前代码已经实现。实际 ACP 特性须通过版本锁定和兼容性测试确认。

## 1. 产品目标及边界

HarnessHub 是一个统一管理多个 AI Coding Harness 的 Linux/WSL 终端应用。统一项目、会话、执行状态和用户界面；复用原生 CLI/ACP Agent 的模型连接、权限决策、工具调用以及可观察输出；支持在同一应用 Conversation 中跨 Harness 接力。

**必须支持**：内置 Codex、Claude Code、Grok Build、OpenCode，以及用户注册的自定义 ACP Agent；Project → Conversation → Harness；并行会话；Project 根目录和可选独立 Git Worktree；源 Harness Handoff；后台 Daemon；历史与草稿持久化；权限审批、取消、Changes/Diff；全局 `hhu` 命令。

**明确不做**：Web UI、云同步/远程访问、Windows 原生客户端、统一模型代理及 Key 管理、非 ACP Agent 的自研协议接入、独立记忆/RAG/向量数据库、自动审批规则、第三方插件运行平台、npm 发布/自动在线更新、完整 UI 快照、保证跨 Harness 无损上下文迁移。

## 2. 产品交互与主要不变量

1. 在 `~` 或任何位置执行 `hhu`，连接或自动启动 Daemon，打开全局 Project → Conversation 列表；**不将启动位置作为 Agent 的工作目录**。可选 `hhu .` / `hhu /abs/path` 快速打开或注册项目。
2. Project 注册一次 Linux 绝对根目录；新 Conversation 默认继承该目录，不再次要求路径。Conversation 可以在创建时选择独立 Git Worktree。
3. 一个 Conversation 同时至多存在一个能够开始开发写操作的活动 Harness Turn；多个不同 Conversation 可并发，甚至允许共享工作目录（给冲突警示，不做全局互斥）。
4. 同一 Harness 连续对话复用它的当前原生会话；Codex → Grok → Codex 重新创建返回后的 Codex 原生会话，并使用应用层 Handoff；不会假定能跨提供商加载原生内部上下文。
5. 仅切换下拉/选择器不触发 Handoff、模型调用或进程终止。用户向目标发送第一条 Prompt 时才真正执行交接。
6. 原生权限：Agent 决定何时请求审批；HarnessHub 负责显示、用户选择及应答，**不得自动批准**。每个审批只能有效完成一次。
7. 正常取消使用 `session/cancel`，等待 Agent 明确结束及末尾事件落盘；强制终止须明确确认。状态不明确标记 `UNCERTAIN`，不能静默重新执行同一可产生副作用的 Prompt。
8. UI 字体、配色、布局统一；文字、Markdown、工具名称、可观察思考、计划、原始工具输出 **不做语义重写**。原始 ACP 事件另行持久化（已知敏感字段允许定向脱敏）。ACP 数据不等于 CLI 屏幕逐字符复刻。
9. TUI 关闭不停止 Daemon / Worker。Daemon 重启后必须恢复 SQLite 历史，但原生会话仅在明确支持且安全时恢复；其他情况展示中断或不确定状态。
10. 默认输入：`Enter` 发送，`Shift+Enter` 换行；必须在 Windows Terminal 和 VS Code WSL 终端实际测试，若无法辨识提供备用键位，但不得擅改默认产品定义。

## 3. 技术栈和进程架构

| 子系统 | 技术 |
|---|---|
| TUI | OpenTUI + `@opentui/solid` + SolidJS + TypeScript，**Bun** 运行 |
| Daemon | Node.js + TypeScript，Hono + Node adapter，HTTP + WebSocket |
| 统一协议 | `@agentclientprotocol/sdk`，MVP 以稳定 ACP v1 为基线；扩展能力动态协商 |
| 存储 | SQLite（WAL），`better-sqlite3` + Drizzle Schema / Migration / CRUD，事件高频写入可使用预编译 SQL |
| Monorepo | Bun Workspaces，单锁文件，Daemon 构建后由 Node 执行，避免 Bun 专属 API 泄漏 |
| 项目变更 | Git 命令获取真实工作树状态及 Diff |

```text
任意目录 → hhu (Bun CLI/TUI)
                     │  HTTP: commands/queries; WS: events/resync
                     ▼
             Node.js Daemon (single instance, 127.0.0.1)
             ├── Hono API / WebSocket Gateway
             ├── Project / Conversation / Draft services
             ├── Runtime Orchestrator + Permissions + Cancellation
             ├── Handoff Manager + Git Workspace Manager
             ├── SQLite (events, handoffs, approvals, metadata)
             └── Generic ACP Client Runtime (stdio)
                 ├── Codex: codex-acp → Codex App Server
                 ├── Claude: claude-agent-acp → Claude Agent SDK
                 ├── Grok: grok agent stdio
                 ├── OpenCode: opencode acp
                 └── custom: configured command + args
```

具体可执行文件、版本和适配器环境变量须以实际安装验证，不能硬编码一个未经测试的路径。Daemon 启动 Worker 时继承用户 WSL 环境，允许显式覆盖指定变量，但不自管 AI Proxy、API Key、Base URL，不修改原生配置。

## 4. 推荐 Monorepo 结构

```text
HarnessHub/
  apps/
    cli/                 # `hhu` 入口、daemon 子命令、安装逻辑
    tui/                 # OpenTUI + SolidJS 视图/键位/交互
    daemon/              # Hono API / WS / 生命周期 / 组合根
  packages/
    shared/              # DTO、Zod schema、错误代码、事件规范
    acp/                 # ACP Client、Profiles、Process、原始事件适配
    core/                # project, conversation, workspace, handoff, orchestration
    storage/             # Drizzle schema/migrations/repositories
  tests/
    fixtures/mock-acp/   # 可脚本控制的 Mock ACP Server
    integration/
    e2e/
  scripts/               # build, install-local, doctor
  docs/
  AGENTS.md
  package.json
  bun.lock
```

目录可在不破坏边界的情况下合并。`packages/core` 不应直接依赖 TUI；共享包不依赖 Bun 特有运行时 API。

## 5. 核心领域模型

**Project**：`id`, `name`, `root_path`（规范化绝对路径、唯一）, `created_at`, `updated_at`。失效路径只提示重新绑定，不能自动创建空项目目录。

**Conversation**：`id`, `project_id`, `title`, `workspace_mode(shared|worktree)`, `workspace_path`, `worktree_metadata?`, `selected_harness_id`, `active_native_session_ref?`, `runtime_status`, `last_user_activity_at`, `created_at`, `updated_at`。各会话历史严格隔离。

**NativeSession**：`id`, `conversation_id`, `harness_id`, `agent_session_id`, `worker_id`, `epoch`, `status`, `capability_snapshot`, `cwd`, `created_at`, `ended_at`。同一应用 Conversation 可以有多段原生会话；持久化不代表 Agent 能恢复。

**Turn**：`id`, `conversation_id`, `native_session_id`, `client_request_id`（去重）, `state`, `origin(user|handoff_internal)`, `start_event_seq`, `finish_event_seq`, `stop_reason`, timestamps。**网络重试不能重复执行已提交的不确定请求**。

**Event**：`id`, `conversation_id`, `native_session_id`, `turn_id?`, `seq`（Conversation 单调递增）, `raw_event_json`, `normalized_kind`, `normalized_payload_json`, `origin`, `sensitivity_flags`, `created_at`。关联 streaming chunks、toolCallId、源消息 ID。遇到未知事件时保留 raw 和 `custom` 显示路径，不能静默丢弃。

**Approval**：`id`, `conversation_id`, `native_session_id`, `turn_id`, `acp_request_id`, `options_json`, `status`, `selected_option_id?`, timestamps。处于失效 Worker 上的未决请求不能在重启后伪装成仍可审批。

**Handoff**：`id`, `conversation_id`, `source_harness`, `target_harness`, `source_native_session`, `target_native_session?`, `source_event_boundary`, `report_text`, `fallback_sources`, `status`, `first_target_request_id?`, timestamps，保存可追溯的失败原因。

**Draft / UI preferences**：会话未发送草稿、最近打开项目/会话、侧边栏开关、基础配置；**不持久化完整滚动位置、焦点和 UI 快照**。

建议 SQLite 核心约束：`UNIQUE(conversation_id, seq)`、`UNIQUE(client_request_id)`（按请求语义选择作用域）、外键完整性、事务内先提交关键事件再推送 WS；WAL、批量低风险流式碎片写入和高优先级状态立即提交。不要把数据库锁作为共享工作区 Agent 执行锁。

## 6. HTTP / WebSocket 契约（建议稿）

**HTTP**（均在本地回环，需本机客户端访问控制）：

- `GET /v1/health`, `GET /v1/capabilities`
- `GET/POST /v1/projects`, `GET/PATCH/DELETE /v1/projects/:id`
- `GET/POST /v1/projects/:id/conversations`
- `GET/PATCH/DELETE /v1/conversations/:id`
- `GET /v1/conversations/:id/events?after_seq=N&limit=M`
- `PUT /v1/conversations/:id/draft`
- `POST /v1/conversations/:id/turns`（含 requestId、message、harnessSelection；有副作用的请求要求幂等保护）
- `POST /v1/turns/:id/cancel`
- `POST /v1/approvals/:id/decision`（一次性原子决策；验证所选 optionId 属于 Agent 提供的候选）
- `POST /v1/conversations/:id/handoff/confirm`（降级确认）
- `GET /v1/conversations/:id/changes`（真实 Git 工作区）
- `GET/POST /v1/harness-profiles`, `GET /v1/harness-profiles/:id/capabilities`
- `GET /v1/diagnostics`, `GET /v1/export/...`

URL、JSON 字段以代码实现及 Zod Schema 为最终契约；以上是职责边界而非必须照抄的路由表。删除项目/会话不能默认删除用户文件或 Git 分支。

**WebSocket**：可按 Conversation 或全局状态订阅；事件包含 `eventId`、`conversationId`、`seq`、`type`、`payload`。TUI 建连后先读历史水位，再订阅，并基于 `seq` 补拉缺失数据、去重。断线重连不能丢失持久化事件，也不得重发用户 Prompt。实时状态包括 `RUNNING`, `WAITING_APPROVAL`, `HANDOFF`, `ERROR`, `INTERRUPTED`, `UNCERTAIN`。

**状态操作**：对当前执行回合采用服务端串行化的状态机；审批决定用 DB CAS/事务保证最多一次；取消消息和审批取消互相协调；客户端不推断服务器已成功，只接受明确 ACK/重查状态。

## 7. 通用 ACP Runtime / Profile

Profile 只保存 `id/name/command/args/envOverrides` 和少量确有必要的原生事件/能力适配声明。内置四个，另外允许自定义 ACP Agent 注册（**不是**任意第三方执行代码插件平台）。

启动顺序：检查可执行程序 → spawn Worker（stdio 传 ACP，日志不能污染 stdout 协议）→ initialize → 能力协商 → `session/new`（`cwd=conversation.workspacePath`，绝对路径）→ prompt → event/update → prompt completion。对“支持模型/推理配置/模式/会话恢复”只信实际协商结果，不解析原生配置文件。

ACP Client 应实现协议要求的文件/终端请求与权限回调；所有文件写入和终端执行仍遵守原生审批，不擅自重解释权限；Client 端能力必须如实声明，未实现不能宣称支持。

一套 generic event collector，将原始消息与结构化呈现模型双轨记录，输出顺序一致，保留原生工具标题、代码、Markdown 和可观察状态。自定义/未知事件降级为 raw 详情。**不得承诺与原生 CLI TUI 像素一致**。

**Worker 生命周期**：Daemon 直接托管，不创建独立 Runner；空闲保活，无自动 idle reap；TUI 退出不杀 Worker；交接真正提交后安全释放旧会话/独占 Worker；Daemon 停止时受控关闭，异常时状态 UNCERTAIN。是否能关闭单个原生 Session 需看该 Agent 能力。

## 8. Context Handoff 精确定义

- 只选择目标 Harness：状态 `PENDING_SWITCH`，不触发任何模型调用。选择回源且无消息，复用原源会话。
- 用户在目标 Harness 发送第一条消息，只有源会话当前 Turn 已结束/确证取消才进入 `GENERATING`。源 Harness 在**原生已有会话**生成结构化纯文本报告，要求概括用户目标、约束、决策、已完成与未完成工作、相关文件、验证结果、已知问题和不确定性。
- 若有明确可导出的原生 compact 文本，可作为素材；不把不透明原生压缩状态当作通用导出。报告是内部 Turn，必须标记来源并落盘，不能悄悄混入用户正常回复；尽力限制其工具副作用。
- 报告持久化后创建目标新原生会话，首次 Prompt 包含标明为背景材料的交接文本以及**独立保存**的真实用户消息。目标成功接受首次 Prompt 后，标记接管边界并安全释放源 Worker；目标执行失败是目标 Turn 失败，不自动回退重发。
- 源不可用/报告失败时，从已有交接与适量原始历史构建降级材料；显示“可能不完整”，**用户确认才发给目标**；允许取消或手动重试。
- 请求已发但结果无法确定：`UNCERTAIN`，不能自动重发。每次交接记录源 event sequence 边界与首次目标请求 ID，避免重复和不明来源。
- 正常 Handoff 在聊天历史以独立可展开记录出现；保存完整报告，不强制人工编辑。多轮 Handoff 可能丢失早期信息，保留完整可观察历史作追溯，不开发 RAG。

## 9. Git Workspace 和 Changes

默认共享 Project 根目录；可在创建 Conversation 时建立并绑定**独立 Git Worktree**，按安全规则创建关联分支。共享工作目录下多 Conversation 可并行工作，展示冲突警示，不做锁或强制串行。Changes 面板通过真实 `git status` / diff 展示当前工作树全量变更；内联 Diff 来自工具事件。**不推断共享目录变更归属某个 Conversation**。删除 Conversation 不删除用户文件；删除受控 Worktree 必须核查脏文件、关联分支和受影响会话，不自动 `--force`。

## 10. TUI 规范

Project → Conversation 树形侧边栏，可隐藏，窄终端自动收起；全局命令面板搜索项目、会话和操作；显示后台执行、待审批、故障、Handoff。主要区域 Chat/Changes，Markdown 与代码高亮，原生 Plan/TODO、可观察思考，Unknown events 可展开 raw。

工具：成功后默认折叠，运行中/失败/审批中默认展开；用户手动展开状态优先，不因自动状态转换收起。Changes 独立页，工具卡内联 Diff；支持复制原始 Markdown。

输入：**Enter 发送；Shift+Enter 换行**；多行/粘贴/草稿持久化；Ctrl+P 命令面板、Ctrl+B 侧边栏等可配置，实际终端兼容测试。Terminal 不支持 Shift+Enter 独立键码时提供明显的备选方式而非改变默认。查看历史时新流式内容不强制拉到末尾。只存草稿/基础偏好，不持久化完整 UI 快照。

## 11. Daemon / CLI / 启动和安装

**最终用户入口 `hhu`**，不是 `HarnessHub`/`harnesshub`；产品/仓库/代码命名保持 HarnessHub。支持 `hhu`, `hhu .`, `hhu /path`, `hhu doctor`, `hhu daemon start|stop|status|logs`, `hhu --version`。`hhu` 无参数默认全局项目列表，不要求事先 `cd`。

Daemon 单实例，监听 127.0.0.1，正确处理重复启动、实例验证、锁和陈旧锁，API 需有本机访问控制（loopback 不是认证）。CLI 启动 Daemon 时确保 stdio/会话脱离 TUI，Daemon 继续托管 ACP 子进程；WSL 关闭实例或 Windows 重启后**不保证 Daemon 继续存活**。仅当无活动任务或明确确认安全停止时停止 Daemon。

源码构建 + 用户级安装：Bun Workspaces 统一安装和构建；Daemon 由 Node 运行；`install:local` 把 `hhu` 安装到 `~/.local/bin`，不使用 sudo、不过度更改用户 Shell。首版 Linux x64/WSL2；Node LTS 与 Bun/OpenTUI/SQLite 的**具体兼容版本在实施阶段锁定并测试**，不要在规范中宣称任意新版本都可运行。安装/升级时数据库迁移先备份、检测活跃任务。

## 12. 数据安全及日志

XDG 默认：`~/.config/harnesshub/config.json`, `~/.local/share/harnesshub/harnesshub.db`, `~/.local/state/harnesshub/logs/`；尊重用户 XDG 环境变量，`umask 077`、目录 0700、文件 0600。数据库包含敏感源码和对话，即使不加密也必须限制权限；已知 Token/Authorization 凭据按来源/结构做定向脱敏；原始事件的语义保真不能等同于无条件保存泄漏的明文 secret。日志不默认记录完整 Prompt、工具正文或敏感环境变量，按大小轮转。提供数据导出/删除；项目文件和用户原生 Harness 配置不受其影响。

## 13. 状态机与失败处理

Conversation 执行：`IDLE → PREPARING → RUNNING → WAITING_APPROVAL ↔ RUNNING → SETTLING → IDLE`；取消：`RUNNING/WAITING_APPROVAL → CANCELLING → SETTLING → IDLE`，确认失败或进程状态不明 → `UNCERTAIN`。错误可进入 `ERROR/INTERRUPTED`。实际实现可用正交状态避免指数级枚举，但必须有明确合法转换表。

Handoff：`PENDING → GENERATING → READY → DELIVERING → COMMITTED`；失败进入 `FAILED`，无法确定是否提交进入 `UNCERTAIN`。对每步保证幂等、持久化边界和明确用户可见状态。

断线重连：TUI 不触发任何默认运行请求；按序补拉、去重。Daemon 崩溃后不能把原本运行/审批状态当作可继续执行；只能经 Agent 实际支持且已验证的原生会话恢复机制尝试恢复。

## 14. 实现与验收总原则

1. 先保证一个真实 ACP Harness 贯通，再扩展其余四种入口；Mock 用于故障/并发的确定性测试，不能替代真实 Agent 验收。
2. 严格保留 Prompt、Tool、Approval、Cancel、Handoff 的来源和事件边界；不自动重放可能造成副作用的用户请求。
3. 针对协议差异提供 capability matrix，未支持功能显示不可用而不是伪造。
4. 安全/正确性优先：原生审批、状态可追溯、工作区正确、任务不重复、后台续跑，优先级高于视觉特效。
5. 六阶段开发，每阶段测试并留有验收记录；见 `02_CODEX_IMPLEMENTATION.md`。

## 15. 参考资料（实施前再次校验）

- ACP TypeScript SDK: https://github.com/agentclientprotocol/typescript-sdk
- ACP v1 Prompt Turn / cancellation: https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/prompt-turn.mdx
- ACP SessionCapabilities: https://agentclientprotocol.github.io/typescript-sdk/types/SessionCapabilities.html
- Codex ACP adapter: https://www.npmjs.com/package/@agentclientprotocol/codex-acp
- OpenTUI runtime: https://opentui.com/docs/getting-started/runtime-support/
- OpenTUI Solid: https://opentui.com/docs/bindings/solid/
