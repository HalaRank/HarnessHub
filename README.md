# HarnessHub

HarnessHub 是 Linux x64 / WSL2 的本地 TUI。全局命令是 **`hhu`**。

当前实现 Phase 4 UI Refinement（0.4.1）：可收起的多项目树、全局命令面板、多行草稿、原生 Markdown/工具/计划/公开思考、原始事件详情与复制，以及真实 Git Changes。继续复用同一个 ACP Runtime、SQLite 和 WebSocket 补拉。真实 Codex / Grok 的聊天、工具、并发切换、关闭 TUI 后保活已验证；Windows Terminal / VS Code WSL 的物理键盘与剪贴板仍待人工验收。详见 [Refinement 验收记录](docs/acceptance/phase-4-refinement.md) 和 [Phase 4 验收记录](docs/acceptance/phase-4.md)；前三阶段记录保留。Handoff / Worktree 管理仍属于 Phase 5。

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

安装器生成 `~/.local/bin/hhu`，不使用 sudo、不修改 Shell 配置。此目录须已在 PATH 中；如缺失，在当前 Shell 执行 `export PATH="$HOME/.local/bin:$PATH"`。启动器引用当前源码仓库构建产物及 Bun 绝对路径，请保留仓库和 `node_modules`。重新安装前运行 `hhu daemon stop`；安装器在构建前拒绝覆盖正在使用的 Daemon 构建。

```bash
hhu /absolute/project/path   # 注册/打开已存在的目录
hhu .                       # 显式注册当前位置
hhu doctor
hhu daemon start
hhu daemon status
hhu daemon logs
hhu daemon stop             # 活动 Turn 或仍存活的不确定 Worker 会阻止停止
hhu daemon stop --cancel-active  # 明确请求原生取消；等待结束后才停止
hhu --version
```

无参数启动不会把 Shell cwd 注册为项目。在 TUI 中按 `p` 注册项目，目录默认从 `~/` 开始；按 Tab 补全目录，多个匹配时补齐共同前缀并显示候选，继续输入后可再次 Tab。支持绝对路径，`~` 和相对路径以 Home 展开，不会创建目录。按 `n` 创建会话。↑/↓ 浏览，选中 Conversation 后 `h` 选择 Harness、`m` 输入消息、Enter 发送、Shift+Enter 换行（终端不支持时用 Ctrl+J）、`a` 输入原生权限选项编号、`c` 正常取消。工具成功默认折叠，`t` 选择工具、`e` 手动展开/折叠。Esc 关闭输入，`q` 退出；Ctrl+C 优先复制有效选区并清除选区，否则清空非空输入框，再次 Ctrl+C 在空输入时退出。退出不停止 Daemon / Worker，取消 Turn 仍独立使用 `c`。Windows Terminal 和 VS Code WSL 的真实键码仍需人工验收。

Ctrl+P 打开命令面板，搜索 Project / Conversation 或执行常见操作；Ctrl+B 隐藏侧栏，少于 90 列自动收起，选择不受影响。输入框始终位于底部，`m` 聚焦编辑，Esc 返回浏览；Enter 发送、Shift+Enter 换行，默认备用 Ctrl+J。命令面板中的 `Configure Shortcuts` 接受 JSON 覆盖，例如 `{"palette":"ctrl+o","sidebar":"ctrl+s","newline":"meta+return"}`；空对象恢复默认。偏好保存在 HarnessHub SQLite，不修改终端或 Harness 原生配置。Enter、Shift+Enter、Esc 和退出键保留；终端可能拦截某些组合，需按实际环境选择。

聊天区用 `[` / `]` 选择展示项，`t` 选择工具，`e` 展开/折叠，`r` 查看对应事件序号、原始 ACP 和 normalized payload。`y` 查看并复制原始 Markdown、代码块、原生参数/结果及 Codex 终端分块；来源选择器中 Enter 复制完整原文，通过 OpenTUI Clipboard Service 优先写入可用的系统剪贴板，终端 OSC52 作为备用（是否接受由终端策略决定）。鼠标拖选松开自动复制，双击选词、三击选行；Ctrl+C / Ctrl+Y 也可复制有效选区。源视图 PgUp/PgDn 滚动、Ctrl+←/→ 分页。代码缩进和换行不做格式化，未知内容可展开查看完整原始详情。握手、控制响应和调试元数据默认不显示在正常聊天；Ctrl+P → Raw Events / Debug 可查看全部已补拉的原始协议事件，每页 100 项，Ctrl+PgUp/PgDn 翻页。

Ctrl+P → Archive Conversation 只隐藏会话，View Archived Conversations 查看归档，Restore Archived Conversation 恢复。Delete Conversation 必须再次输入 DELETE 确认；服务端拒绝活动任务、待审批及 UNCERTAIN 历史，安全关闭空闲原生会话后删除关联应用数据，不删除源码、工作目录或 Git 分支。归档与删除经现有 WebSocket 快照同步到其他客户端。

聊天 PgUp/PgDn 滚动，Ctrl+PgUp/PgDn 翻历史页，End 回到底部并跟随。用户向上阅读时暂停跟随；跨会话保留本次 TUI 的滚动位置和工具展开状态，不存 UI 快照。历史每页最多挂载 60 个展示项，极长消息按约 16,000 字符分段，跨段 Markdown 格式可能重新解析，`y` 仍复制完整连续消息。较大工具/原始详情有明确预览限制，源视图可逐页阅读或一次复制全文。

Ctrl+D 切换 Changes / Chat；Changes 用 ↑/↓ 选择文件、PgUp/PgDn 滚动、`g` 刷新、`y` 复制完整 Diff。面板读取绑定 Workspace 的 Git 状态，分别显示 Staged / Unstaged / Untracked，不推断 Agent 归属。不会提交、暂存或改写项目文件；Git 读取不是原子快照。单次 Git 输出超过 2 MiB 或查询超过 10 秒会明确报错；大 Diff 预览上限 96,000 字符，原文可在源视图阅读。非 Git 项目显示说明。工具提供的 Diff 单独内联展示。

顶部模型只来自 ACP 实际返回值，没有暴露时明确显示。命令面板的 `ACP Native Session Options` 显示原生 mode/config 候选；只有用户选择并 Enter 才调用已有设置接口。权限审批仍只使用 Agent 原始选项，不增加自动审批。

同一 Conversation 复用当前存活的原生会话。跨 Harness 提交需等待 Phase 5 Handoff；当前使用新的 Conversation 接入另一个 Harness。不同 Conversation 可以共享项目目录并行执行，界面会提示并发修改风险。

TUI 顶部汇总所有 Project 的活动 Conversation、待审批会话/请求及异常；树中每个 Conversation 显示真实状态。Running 包含准备、执行、等待审批和取消中的会话，与 Approval 数量有重叠。Ctrl+G 切换汇总显示，偏好和最近选择持久化；显式 `hhu /path` 优先打开该 Project。多个 TUI 各自保留当前选择，最近选择按最后一次保存生效。

每个 Conversation 的未发送草稿自动保存，切换/退出时补存，重新进入按 `m` 恢复。多客户端编辑同一草稿时，版本冲突会报错并保留本地文字，避免静默覆盖。若保存失败，正常退出会提示；明确按 Ctrl+Q 可放弃尚未保存的本地编辑并关闭 TUI。非正常终止可能丢失最后约 150ms 尚未保存的输入。发送前先持久化请求编号；重连只读历史，恢复未确认提交时保留相同编号，只有用户再次 Enter 才显式重试。Ctrl+C 清空未确认草稿时仍保留原 requestId；命令面板 Restore Unconfirmed Message 只恢复原文供检查，不自动发送。

Daemon 仍存活时，重新打开 TUI 会连接同一 Worker/原生会话。Daemon 崩溃后，SQLite 历史恢复，未结束的 Turn 标为 UNCERTAIN，失效原生会话标为 INTERRUPTED，旧审批过期；不加载或自动重放任务。空闲会话下次显式发送会新建原生会话；UNCERTAIN 需先检查历史和工作区，再显式新建 Conversation。

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

## 开发与数据

- `apps/cli`：Bun CLI；`apps/tui`：OpenTUI/Solid 聊天、原生内容、Changes 与命令面板。
- `apps/daemon`：纯 Node Hono HTTP/WS；`packages/acp`：共享 ACP SDK Client / Worker / 内置 Profile。
- `packages/shared`：DTO、校验、客户端、独立 Conversation 补拉；`packages/core`：项目和 Runtime 状态机；`packages/storage`：Drizzle schema / migrations / SQLite。
- Phase 4 新增 `GET /v1/conversations/:id/changes`，可通过编码的 `?path=` 查询同一 Git 状态中的文件 Diff；偏好增加侧栏与快捷键。
- Phase 3 新增 `GET/PUT /v1/conversations/:id/draft`（版本检查）、`GET/PATCH /v1/preferences`、只读 `GET /v1/requests/:requestId`；`GET /v1/snapshot` 增加 activity 汇总。草稿最多 100,000 个 UTF-16 单元，HTTP 请求体限制为 1 MiB。
- `tests/fixtures/mock-acp`、`tests/integration`：真实子进程 Mock、Daemon、SQLite、HTTP/WS、故障和生命周期；`tests/e2e`：Solid 操作及双 Linux PTY。PTY 测试需要 Python 3。

数据库默认 `~/.local/share/harnesshub/harnesshub.db`，实例凭据与锁位于 `~/.local/state/harnesshub/`，日志在其 `logs/`。尊重绝对路径的 XDG_CONFIG_HOME / XDG_DATA_HOME / XDG_STATE_HOME；目录 0700，数据、凭据和日志 0600。日志不复制完整 Prompt、工具输出或 Worker stderr；原始 ACP 和结构化事件保存在私有 SQLite，结构化凭据字段定向脱敏。

迁移前生成同目录 0600 的 `harnesshub.db.backup-*`，再执行 Drizzle migrations；不支持的更高 schema 拒绝打开。不要在 Daemon 运行时替换数据库、构建产物或删除锁文件。强制停止只通过 `POST /v1/conversations/:id/session/stop` 的 `{ "force": true, "confirmed": true }` 明确确认；结果保守标记 `UNCERTAIN`。普通停止没有自动 SIGKILL 升级。
