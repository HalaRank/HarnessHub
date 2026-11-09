# HarnessHub

HarnessHub 是 Linux x64 / WSL2 的本地 TUI。全局命令是 **`hhu`**。

当前为 Phase 6 审计修复版 **0.6.1（SQLite schema 6）**：修复最终独立审计的 Worktree 文件安全、Worker 后代管理、上下文/设置状态、安装一致性及测试断言。Worktree 清理改为保留式移动，不自动物理删除文件；安装采用完整独立发布目录。原审计与修复验证分别见 [独立审计报告](docs/acceptance/official-final-audit.md) 和 [审计修复记录](docs/acceptance/phase-6-audit-remediation.md)。Windows 双终端人工验收及真实 Harness 未验证项仍须单独完成，**尚未宣布 MVP 全部通过**。

## 安装与运行

使用 Node **24.18.0** 和 Bun **1.4.4**；需要 Linux `flock`、Git。版本与官方参考见 [兼容性记录](docs/COMPATIBILITY.md)。

```bash
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run test
bun run install:local
cd ~
hhu
```

安装器生成 `~/.local/bin/hhu`，不使用 sudo、不修改 Shell 配置。此目录须已在 PATH 中；如缺失，在当前 Shell 执行 `export PATH="$HOME/.local/bin:$PATH"`。启动器引用仓库 `dist/releases/<UUID>` 中完整的独立发布产物及 Bun 绝对路径，请保留仓库、该发布目录和 `node_modules`。安装失败不会修改上一发布；旧发布和失败的 staging 目录保留供检查，不自动删除。重新安装前运行 `hhu daemon stop`；安装器在构建前拒绝覆盖正在使用的 Daemon 构建。

```bash
hhu /absolute/project/path   # 注册/打开已存在的目录
hhu .                       # 显式注册当前位置
hhu doctor
hhu doctor --acp <conversationId> codex  # 显式握手，不发送模型 Prompt
hhu daemon start
hhu daemon status
hhu daemon logs
hhu daemon stop             # 活动 Turn 或仍存活的不确定 Worker 会阻止停止
hhu daemon stop --cancel-active  # 明确请求原生取消；等待结束后才停止
hhu --version
```

无参数启动打开全局 Project → Conversation 树。浏览时按 `/`，或点击顶部 Commands，搜索项目、会话及操作。Add Project 注册已有目录，路径默认从 `~/` 开始，支持 Tab 补全。命令面板的 New Conversation 创建共享目录会话，New Conversation in Git Worktree 创建独立 worktree 会话；聊天输入中的 `/new` 不执行 HHU 会话管理。首条消息自动生成标题，Rename Conversation 支持手动重命名。

选中项目或项目下的会话、且未进入聊天输入/历史或弹窗时，按 `N`（小写 `n` 亦可）在该项目根目录创建新会话；即使选中的是 Worktree 会话，也不会继承其 Worktree。按 `Ctrl+N` 在**本次启动 `hhu` 的目录**创建不属于任何项目的独立会话，不注册项目、不使用 Daemon 的工作目录。独立会话直接显示在侧栏顶层，历史和草稿照常持久化；聊天输入中 `N` 保持输入文字，`Ctrl+N` 仍可新建，弹窗打开时不触发创建。

默认键位按 Codex CLI 收敛。

| 操作                        | 键位或入口                                                 |
| --------------------------- | ---------------------------------------------------------- |
| 发送消息 / 运行中追加指令   | Enter                                                      |
| 运行中排队到下一轮          | Tab                                                        |
| 换行                        | Shift+Enter，备用 Ctrl+J                                   |
| 打断当前任务                | Esc，优先关闭命令候选或顶层弹窗                            |
| 浏览已发送消息 / 搜索历史   | ↑↓ / Ctrl+R                                                |
| 复制最近完成的回复          | Ctrl+O，有选区时复制选区                                   |
| 进入 / 离开聊天历史         | Ctrl+T，历史中 ↑↓ 选择、Enter 展开、End 到末尾             |
| 切换 Harness                | Ctrl+H，循环选择；首次发送消息才交接                       |
| Harness 原生命令            | 聊天输入 `/`，仅列出当前会话通过 ACP 发布的命令            |
| HHU 管理和帮助              | 点击 Commands，或在空输入框按 `?`                          |
| 新会话 / 查找会话 / Changes | Commands 面板：New Conversation / 搜索 / Toggle Changes    |
| 当前项目新会话              | 浏览项目或其会话时按 N                                     |
| 启动目录独立新会话          | Ctrl+N（不归属项目）                                       |
| 删除所选会话 / 项目         | 浏览时 Delete 打开确认，再按 Delete 删除                   |
| 原生模型及权限设置 / 审批   | Commands：HarnessHub ACP settings / Choose Native Approval |
| 切换 Harness / Handoff 材料 | Commands：Select Next Harness / Handoff Failure            |
| 排队消息管理                | Commands：Message Queue，支持暂停后继续、编辑和移除        |
| 侧栏 / 键位设置             | Commands 面板                                              |
| 退出 TUI                    | Commands：Quit TUI，或空输入无选区时 Ctrl+C                |

运行中 Enter 仅在 Agent 实际声明 `_meta.steering.supported` 时使用原生 `_session/steering`，并要求空闲竞态回到宿主控制。Agent 未声明该能力时，输入框明确显示排队降级。Tab 按 FIFO 等待当前 Turn 正常结束再发送。所有排队、发送及不确定状态保存在 SQLite 事件日志，TUI 退出后仍由 Daemon 管理。Esc 取消、Harness 切换及 Daemon 重启会暂停未投递消息，通过 Commands → Message Queue 明确恢复。投递结果为 UNCERTAIN 时保留历史并阻止自动重发。

原生 ACP 命令按当前 Harness 会话发布的名称、说明和参数提示补全，不混入 HHU 命令。Tab/Enter 选择只补全，再按 Enter 原样发送给对应 Harness，由其实现原生行为；HHU 不解释 `/new`、`/model`、`/quit` 等名称，也不替换为本地管理操作。原生 CLI 命令不保证通过 ACP 暴露；未发布时不补造菜单，明确提示不可通过 ACP 原生执行。用户仍可确认将未发布的 slash 文本作为普通 Prompt 发送，但这不保证命令执行。HHU 管理入口独立保留在 Commands 面板、按钮和快捷键中。

聊天历史使用滚轮连续上下查看，无需翻页；阅读旧消息时新输出不会拉回底部，Esc / End 返回最新消息。工具保持紧凑摘要，标题一行、正文最多末尾三行，手动展开状态优先。Ctrl+T 进入历史后用 ↑↓ 选择、Enter 展开，底部 More / less、Source、Raw 也可点击。Source 展示完整原始 Markdown、代码及工具输出，Enter 复制全文，PgUp/PgDn 滚动、Ctrl+←/→ 分页。鼠标拖选松开自动复制，双击选词、三击选行。Ctrl+C 优先复制有效选区，否则清空非空输入，再次在空输入时退出。

Changes 用 ↑↓ 选择文件，点击 Refresh 刷新、Source / copy 查看完整 Diff。读取 Conversation 绑定 Workspace 的 Staged、Unstaged 和 Untracked，不推断 Agent 修改归属。单次 Git 输出超过 2 MiB 或查询超过 10 秒时明确报错。

命令面板和侧栏 `⋯` 保留归档、恢复、重命名及确认删除操作。确认删除 Conversation 会取消任务和待审批请求、关闭所属 Worker，必要时终止不响应的受控进程，待异步写入收尾后删除历史与草稿。FAILED Handoff、UNCERTAIN 会话也可通过此入口删除。Project 删除仍预检全部子会话。用户项目目录、Worktree 和 Git 分支保留。Manage Worktrees 继续要求核对路径、分支和 CLEAN 确认，按已有安全规则将目录移入保留目录。

同 Harness 连续消息复用原生会话。`/harness` 仅选择目标，首次向目标提交消息才生成源报告并创建目标原生会话。源执行、审批或取消未结束时等待。失败通过 `/handoff` 查看报告、重试、确认降级或取消，已发送但结果不明的请求保持 UNCERTAIN。

多 Conversation 可在各自 Workspace 并行工作，共享目录显示冲突提醒。关闭 TUI 保留 Daemon 和 Worker，重新打开按序补拉历史。草稿自动保存并使用 CAS 防止多客户端覆盖。默认快捷键可经 `/keymap` 显式覆盖或以空字符串解除绑定，`{}` 恢复默认。Windows Terminal / VS Code WSL 的物理键盘和桌面剪贴板验收仍待完成。

## ACP 与脚本操作

Codex / Claude 的 Adapter 随 lockfile 安装，优先使用 PATH 中的 `codex-acp` / `claude-agent-acp`，否则用仓库固定版本的 CLI 入口。Grok Build 使用 `grok agent stdio`，OpenCode 使用 `opencode acp`，后两者需用户先安装。登录、API Key、Base URL 和原生默认值由各 Harness 自行管理；HarnessHub 不读取/改写其配置，也不自动选择审批选项。

```bash
hhu agent --help
hhu agent list                                      # 仅检查入口；不冒充已握手
hhu agent session <conversationId> codex             # 真实 initialize + session/new；显示原生能力和配置
hhu agent prompt <conversationId> codex 'Read README.md' <requestId>
hhu agent watch <conversationId>                     # 逐条 JSON；断线后按 seq 补拉
hhu agent status <turnId>
hhu agent approvals <conversationId>
hhu agent decide <approvalId> <nativeOptionId>       # 必须由用户选择 Agent 提供的原始 optionId
hhu agent cancel <turnId>
hhu agent settings <conversationId> '{"kind":"config","configId":"model","value":"<advertised-value>"}'
hhu agent stop <conversationId>                      # 停止空闲 Worker
hhu agent export <conversationId> chat conversation.md  # 原文 Markdown；新建 0600 文件
hhu agent export <conversationId> debug debug.json       # 原始 ACP 调试导出；拒绝覆盖
```

`prompt` 返回 Turn，执行在后台继续。`requestId` 是 UUID；命令会在提交前打印它。HTTP 响应丢失时只能用相同 ID 和相同消息查询/重试，服务器返回已有 Turn，不重复提交 Prompt。已发出但结果无法确定的任务标记 `UNCERTAIN`，查看事件并核实工作区后显式创建新 Conversation；不会自动恢复或重放。

只允许 Agent 实际提供的 mode/config 选项；推理强度若未通过 ACP 暴露就不可设置。客户端如实声明 `fs=false`、`terminal=false`：四种已验证 Harness 使用自身原生文件/终端工具。需要 Client 代执行文件/终端操作的其他 Agent 当前不受支持，相关请求明确返回不支持。

自定义 Profile 使用相同 Runtime，通过 `hhu agent register /absolute/profile.json` 注册。文件格式如下，`command` 必须为 PATH 命令或绝对可执行路径，直接 spawn，不经过 Shell：

```json
{
  "id": "my-agent",
  "name": "My ACP Agent",
  "command": "/absolute/path/to/agent",
  "args": ["acp"],
  "envOverrides": {}
}
```

Worker 继承 Daemon 启动时的原生进程环境，并使用 Conversation 工作区作为进程 cwd 和 `session/new.cwd`。修改 Profile 前必须停止使用该 Profile 的 Worker。`envOverrides` 仅用于普通启动参数；新增 API Key、Token、Password 等已知凭据变量会被拒绝，请通过原生登录或 Daemon 继承的环境提供。列表/API 只返回 override 变量名。升级前已有的敏感 override 不会被静默删除，列表中的 `sensitiveEnvOverrideKeys` 会标出名称；请停止相关 Worker、以不含敏感值的 Profile 重新注册。旧数据库备份仍可能含旧值；不要在 args 中传凭据或把凭据文件提交到 Git。

可显式执行 `node scripts/verify-acp.mjs` 检查四个真实入口。脚本创建临时项目并保留 SQLite/`evidence.json` 证据，默认只握手；`HARNESSHUB_REAL_PROMPT=1` 会向第一个成功的 Harness 发送无害读取/测试请求，并可能等待用户原生审批。该脚本不在自动化测试中运行。

可用 `node scripts/verify-phase4.mjs` 显式验证真实 Codex / Grok，或传两个 Harness ID。它创建隔离 XDG 数据和两个临时项目，从 Home 打开三个真实 `hhu` PTY，提交无害读取/测试任务，检查并发、退出保活、同会话重连、键码、命令面板切换及每任务一次 Prompt，并以真实持久化事件检查 Markdown/代码/工具原文复制。遇原生审批会停下并报告，绝不自动选择；结束时尝试正常取消/停止隔离 Daemon，保留证据文件。

可用 `node scripts/verify-phase5.mjs` 显式运行真实 Codex → Grok → Codex；脚本在临时 Git 项目的独立 Worktree 中依次更新无害 progress.txt，检查同一 Conversation、三段原生会话、零调用选择、5 次原生 Prompt、交接决策、TUI 退出保活和真实报告渲染/复制。遇原生审批不会自动选择。证据与工作目录保留，测试 Daemon 尝试正常停止。

可用 `node scripts/verify-phase6.mjs` 显式检查四个真实 Harness 的握手、Workspace、读取/Markdown 输出和取消。脚本在私有临时目录运行，会实际调用模型；遇审批或 120 秒无结果时请求原生取消，不选择审批、不重发 Prompt。各 Harness 的原始 debug 导出及结果保留在打印的证据目录；任何消息或取消验证未通过时返回失败状态，不能把握手成功当作完整兼容。

## 开发与数据

- `apps/cli`：Bun CLI；`apps/tui`：OpenTUI/Solid 聊天、原生内容、Changes 与命令面板。
- `apps/daemon`：纯 Node Hono HTTP/WS；`packages/acp`：共享 ACP SDK Client / Worker / 内置 Profile。
- `packages/shared`：DTO、校验、客户端、独立 Conversation 补拉；`packages/core`：项目和 Runtime 状态机；`packages/storage`：Drizzle schema / migrations / SQLite。
- Phase 5 新增 `PUT /v1/conversations/:id/harness`、`GET /v1/conversations/:id/handoffs`、`POST /v1/conversations/:id/handoff/action`（`{handoffId, action: retry|confirm|cancel}`）、`GET /v1/worktrees`、`POST /v1/worktrees/:id/cleanup`（`{confirmed:true}`）；创建 Conversation 支持 `workspaceMode`。
- Phase 6 新增 `GET /v1/conversations/:id/export?format=chat|debug`（`readable`/`raw` 为兼容别名）；`chat` 为可读对话投影，`debug` 包含脱敏 raw ACP 事件、来源序号、Session、Turn、审批和 Handoff。
- Phase 4 新增 `GET /v1/conversations/:id/changes`，可通过编码的 `?path=` 查询同一 Git 状态中的文件 Diff；偏好增加侧栏与快捷键。
- Phase 3 新增 `GET/PUT /v1/conversations/:id/draft`（版本检查）、`GET/PATCH /v1/preferences`、只读 `GET /v1/requests/:requestId`；`GET /v1/snapshot` 增加 activity 汇总。草稿最多 100,000 个 UTF-16 单元，HTTP 请求体限制为 1 MiB。
- `tests/fixtures/mock-acp`、`tests/integration`：真实子进程 Mock、Daemon、SQLite、HTTP/WS、故障和生命周期；`tests/e2e`：Solid 操作及双 Linux PTY。PTY 测试需要 Python 3。

数据库默认 `~/.local/share/harnesshub/harnesshub.db`，实例凭据与锁位于 `~/.local/state/harnesshub/`，日志在其 `logs/`。尊重绝对路径的 XDG_CONFIG_HOME / XDG_DATA_HOME / XDG_STATE_HOME；目录 0700，数据、凭据和日志 0600。日志不复制完整 Prompt、工具输出或 Worker stderr；原始 ACP 和结构化事件保存在私有 SQLite，结构化凭据字段定向脱敏。Daemon 和启动日志达到 1 MiB 时轮转，最多保留 5 个历史文件，旧文件不会无限增长。

迁移前生成同目录 0600 的 `harnesshub.db.backup-*`，再执行 Drizzle migrations；SQL 失败会事务回滚，保留旧库和备份，不自动覆盖。不支持的更高 schema 拒绝打开。不要在 Daemon 运行时替换数据库、构建产物或删除锁文件。强制停止使用 `POST /v1/conversations/:id/session/stop` 的 `{ "force": true, "confirmed": true }` 明确确认，结果保守标记 `UNCERTAIN`。确认删除 Conversation 也授权停止其受控 Worker。普通停止没有自动 SIGKILL 升级。恢复步骤见[操作指南](docs/OPERATIONS.md)。

Conversation 导出通过 `hhu agent export <id> chat|debug [新文件]` 或 `/v1/conversations/:id/export?format=...` 使用。`chat` 提供用户消息、Agent 内容、工具、公开思考/计划和 Handoff 的 Markdown；`debug` 另含原始 ACP、序号、Session、Turn、审批和用途。已知结构化凭据字段脱敏，不注入 Daemon Token 或 Profile 环境值；原生文本/源码仍可能含秘密，导出和备份需私密保存。`doctor` 默认不握手；`hhu doctor --acp <conversationId> <harnessId>` / `hhu agent session ...` 才显式执行握手。

## Windows Desktop（Phase 1）

新增 Electron + React 原生窗口，Agent/Daemon/SQLite 继续在 WSL2 中运行，保留 Linux TUI。当前为真实项目树与只读会话预览；Windows 安装、启动和验证见 [Desktop 指南](docs/DESKTOP.md)，阶段范围与证据见 [验收记录](docs/acceptance/desktop-phase-1.md)。
