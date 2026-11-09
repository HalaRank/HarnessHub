# Desktop Phase 3 验收记录

日期：2026-11-09。范围仅 Coding Workspace Integration，不包含 Desktop Phase 4 的安装器、签名、自动更新或正式发布。

## 实现与数据来源

开发前检查 AGENTS、架构 01/02/03、Desktop Phase 1–2 验收，以及 Main、Renderer、core Changes/Handoff/Worktrees 和 Daemon routes。开发开始工作区干净。未修改原生 Harness 模型、凭据、API Key/Base URL 配置，未替换全局安装或操作用户默认 Daemon。

| 文件 | 实现 |
| --- | --- |
| `apps/desktop/src/contracts.ts`、`main/actions.ts`、`main/connection.ts` | 固定 Changes/Diff、托管 Worktree、工作区定位 Action；Git 在途查询合并及数量上限，连接 epoch 防止跨发行版旧结果泄漏 |
| `main/navigation.ts`、`main/window.ts` | 仅打开经 WSL 校验的文件夹；发行版 UNC 转换，拒绝歧义路径；异步剪贴板写入完成后才 ACK |
| `renderer/Composer.tsx`、`Confirm.tsx` | 未发布 Slash 文本的明确确认；关闭不发送、确认一次性消费，保持草稿 CAS/requestId/IME |
| `renderer/Changes.tsx`、`Diff.tsx`、`Markdown.tsx` | 真实 Git 列表、staged/unstaged/untracked Diff、块展开/行分页/语法高亮/完整复制；变更消失清除旧 Diff，列表缩小时页码安全收敛 |
| `renderer/Message.tsx`、`history.ts`、`PathActions.tsx` | 原生 ACP Diff 单独呈现，保留 oldText/newText；工具位置来自原始事件 seq/collection/index，Linux 路径复制及受控定位 |
| `renderer/Handoffs.tsx` | 当前源/目标及历次接力，真实状态、完整报告、降级材料、源事件边界和原生会话/请求追溯；FAILED 显式操作，UNCERTAIN 无重发 |
| `renderer/Worktrees.tsx`、`ConversationDialog.tsx` | Shared/Worktree 创建、全局托管列表/路径/分支/状态/归属，安全清理确认及保留目录说明 |
| `renderer/App.tsx`、`style.css` | 默认隐藏的可拖动右栏，四个入口，宽屏三栏/窄屏浮层；主聊天与草稿不因面板开关被卸载 |
| `packages/shared/src/changes.ts`、`packages/core/src/workspace-location.ts`、`packages/core/src/index.ts`、`apps/daemon/src/runtime-routes.ts` | 严格来源引用 schema 和只读目录解析；其余 Git/Handoff/Worktree 后端原样复用 |
| `apps/desktop/tests/workspace.test.tsx`、`windows-workspace.ts`、`windows-smoke.ts`、`tests/integration/desktop.test.mjs`、`tests/fixtures/mock-acp/server.mjs`、`scripts/verify-desktop-windows.ts` | 自动化、Mock ACP 故障路径、临时 Git 仓库、Windows Electron 与真实 Harness 验证 |

Git 数据沿用 `GET /v1/conversations/:id/changes` 和 `?path=`。所有 Git 命令在 WSL 执行，使用既有参数数组、literal pathspec、禁 external diff/textconv。只查询，不因选文件执行写命令。Changes 显示当前 Conversation 绑定 Workspace 和真实观测时间，Shared 模式明确提示并行冲突，不推断修改归属。

Handoff 沿用 SQLite handoffs、NativeSession 和原始/结构化事件，经既有 WS 失效通知与 HTTP 补拉同步。选择目标只显示 PENDING_SWITCH；首条目标消息触发真实 GENERATING → READY → DELIVERING → COMMITTED。短暂状态可能在实时快照间越过，原始状态事件仍可追溯；UI 不伪造中间模型执行。FAILED 的报告、fallbackText/fallbackSources 全部可检查，操作使用原 handoff/action。UNCERTAIN 不提供重发或伪装取消。

Worktree 沿用既有创建、列表与 cleanup API。删除 Conversation 不删除源码、目录或分支。清理要求用户确认，后端再次检查绑定、归属、脏文件、忽略文件及索引标志；无 force。成功后目录移动至 `ownerRoot/retained/<id>`，状态 RETAINED，文件与分支都保留，清理不承诺释放磁盘空间。

## IPC 与文件导航安全边界

| Action | 约束 |
| --- | --- |
| `changes.list/diff` | Conversation UUID + 单文件 Git path，固定 GET；文件必须在当前真实 Git 状态中 |
| `worktrees.list/cleanup` | 仅托管 ID；cleanup 要求 `confirmed: true`，后端再次执行安全检查 |
| `conversation.create` | 项目 ID + 标题 + shared/worktree，沿用原 Worktree Manager |
| `workspace.open` | workspace 引用、Git change path，或 tool event seq/collection/index；不接受任意绝对路径/URL/命令 |
| `clipboard.copy` | 文本写入剪贴板；Main 等待 Electron Promise 并传回失败 |

新增只读路由 `POST /v1/conversations/:id/workspace/location` 从绑定 Workspace、真实 Git 或当前会话原生工具事件取路径。在 WSL 拒绝 `..`、反斜杠/控制字符和 realpath 越界；已删除文件定位存在的父目录。工具提供的外部路径不获导航能力；符号链接指向工作区外时拒绝。Windows 仅打开返回的目录，Linux 绝对路径仍用于全部 Agent/ACP/Git 工作。

`\\wsl.localhost\<发行版>\…` 仅用于 UI。空格、Unicode、`&`、`$`、`#`、`%` 等按字面转换，不拼接 shell 命令；分隔符、遍历、控制字符、Windows 歧义名称（如冒号、尾随点/空格）拒绝打开并提示复制 Linux 路径。Renderer 不持 Token、不执行 Git、不获得 Node/shell/openPath/child_process/任意文件 API；原 sandbox/contextIsolation/CSP、精确 sender/mainFrame/document URL 验证保留。

## 性能与同步

打开 Changes/Diff 时串行获取列表，每次完成后 3 秒再刷新；手动刷新有 1.5 秒门限。Main 合并相同在途 Git 查询、最多 4 个不同 Git 查询同时进行。关闭面板停止轮询；切换会话卸载读取器并丢弃旧结果，不取消 Agent。Worktree 列表每 5 秒刷新；Handoff 继续走既有 WS/快照。

文件列表最多挂载 100 项；单文件按需获取，Diff 每页最多 30 块，默认仅展开前两块，每块最多 200 行。语法高亮只处理已挂载行，超长行保持纯文本，完整原文仍可复制。刷新导致文件/块数缩小时页码收敛；文件离开 Git 状态时不继续显示旧补丁。

保留既有 Git 每次查询 10 秒、2 MiB 输出上限。超限明确报错，需用户在 WSL 检查；不是无限大 Diff 流式服务。单文件补丁仍整段从后端读取，块/行按需加载指 Renderer DOM 和高亮；未添加第二套 Git 分块协议。工作区同时被修改时 Git 查询不是原子快照。

## 自动化结果

所有有写入/清理风险的测试使用 `/tmp/hhu-*` 下隔离 Git 仓库、XDG 数据和 Windows userData，不使用用户项目作为测试目标。

| 命令 | 结果 |
| --- | --- |
| `bun run typecheck` | 通过 |
| `bun run lint` | 通过 |
| `bun run build` | 通过 |
| `bun run desktop:build` | 通过 |
| `bun run desktop:test` | 36 项单元 + 14 项真实 Daemon 集成通过 |
| `bun run test` | 101 项 Node 集成 + 116 项 TUI/UI，0 失败 |
| `git diff --check` | 通过 |

新增覆盖：真实 Git Added/Modified/Deleted/Untracked、staged/unstaged/untracked 补丁；原生 Diff 来源与工具位置事件合并；50,000 行及 400 块有界 DOM；Handoff 往返创建新 Session、失败重试/降级确认/取消、UNCERTAIN 拒绝三种 action 且用户消息不重复；Shared/Worktree 路径与保留清理；删除后源码和分支仍在；严格 IPC、确认 Slash 后 ACK 丢失不重发、WSL 特殊字符、目录遍历/符号链接拒绝；`/path`、路径前缀和未发布 Slash 普通文本确认。Phase 1–2 的 CAS、ACK 丢失、重复发送/审批、取消、WS 重连/seq、并发会话、TUI 同步和关闭保活回归全部保留。

开发中修正的验证问题：集成测试读取快照早于 COMMITTED 更新；Windows 脚本在旧会话仍结束中发送下一条、混用原生 Diff 与 Workspace Diff 的 DOM 选择器、未等待 React 投影，以及 Windows 异步布局后的坐标点击偶发漏点；Electron 45 的剪贴板 Promise 需等待。失败轮次不作为成功证据。

## Windows 与真实 Harness

**通过**：`HHU_DESKTOP_REAL=1 bun scripts/verify-desktop-windows.ts` 最终退出码 0，Windows evidence `passed=true`。运行环境为 Windows x64 Electron 45.2.3 + Ubuntu-26.04 WSL2；验证使用真实 Windows 窗口、Chromium 键盘输入、原生鼠标拖动与单次 DOM 控件点击、wsl.exe、localhost HTTP/WS 与 SQLite，同时运行真实 WSL hhu TUI PTY。Mock ACP 不冒充真实 Codex/Grok 模型。

最终 Windows 证据目录为 `hhu-desktop-smoke-7nzTUe`，隔离 WSL 为 `/tmp/hhu-windows-smoke-WKQOTF`。本目录 [evidence/desktop-phase-3](evidence/desktop-phase-3) 保存 Windows/TUI JSON、命令日志、Changes/Diff/Handoff/Worktree/窄屏截图、真实 Harness 可观察事件和截图。没有复制实例 Token、原生配置或用户日常数据库。隔离 Daemon 已正常停止，测试文件和 retained Worktree 保留供检查。

Windows 实际覆盖 Phase 1–2 原有流程及本阶段：未发布 `/path` 关闭确认保留草稿、确认双击只产生一条用户消息；真实 Git 四类文件状态；1200 行 Diff 的分页/滚动/高亮/完整复制；原生工具 Diff 和 Workspace Git Diff 并列区分；Main 成功调用 Explorer 打开 WSL 文件夹；跨 Mock Harness 往返产生三个不同 NativeSession；完整交接报告、源事件边界；Shared/Worktree 创建、切换后的正确 Git 状态；删除会话保留 Worktree；清理取消不变、确认后 RETAINED；窄屏浮层无页面横向溢出。真实 TUI PTY 同时显示 `native-34`，最终只关闭其自身。

| 真实 Harness | 请求与证据 | 结果 |
| --- | --- | --- |
| Codex | requestId `6363199c-a3ab-4a3d-be4e-fd5ff101884c`；103 个回复 chunks，3 次原生工具调用；`COMPLETED/end_turn` | 创建 `phase3-codex.txt`，内容精确为 `HARNESSHUB_PHASE3_codex_TOOL_WRITE` 加换行；真实 Git untracked Diff 与 Windows Changes 可见 |
| Grok Build | requestId `27a25889-2d81-424a-830a-25af0e970ae7`；149 个回复 chunks，5 次原生工具调用；`COMPLETED/end_turn` | 创建 `phase3-grok.txt`，内容精确为 `HARNESSHUB_PHASE3_grok_TOOL_WRITE` 加换行；真实 Git untracked Diff 与 Windows Changes 可见 |

两次任务均从真实 Windows 文本框输入并提交，只允许临时仓库中的指定新文件；无自动重发、无 failed 工具更新，原始可观察事件与实际文件内容再次核对一致。Codex 先输出模型 metadata fallback 警告，约 122 秒后正常完成；警告没有被掩盖，也没有通过改配置重试。两次均未请求用户审批；HarnessHub 未改原生权限模式，也未替真实 Agent 自动批准。Mock 审批测试显式选择 Reject。

本轮**未验证真实 Codex → Grok → Codex 的完整跨模型接力**：该往返本轮用真实 Daemon/SQLite/Windows UI + Mock ACP 覆盖，真实 Codex/Grok 分别覆盖修改文件与 Changes。FAILED/UNCERTAIN 的 Desktop 呈现与操作由单元、真实 Daemon 集成及原有故障回归验证，未在 Windows 上通过真实模型故障注入重跑全部分支。Claude/OpenCode 本轮未真实调用。

Windows evidence 中沿用旧检查名称 “Real mouse conversation switching”；实际按钮自动化使用 Chromium DOM 控件的单次 click，等待模态框关闭、渲染和后端状态；不绕过产品 action 直接调用 Git/Runtime。原生鼠标事件覆盖侧栏拖动，键盘事件覆盖输入；物理鼠标、右栏真实鼠标拖动及全部 DPI 的人工手感仍待用户验收。截图已人工查看，真实 Codex/Grok 图均显示对应会话与 Changes 文件；不以旧 compositor 帧代替成功证据。

## 用户待验收与限制

1. Windows 启动应用，选择 WSL，打开多个 Shared/Worktree Conversation；核对右栏路径与 `git status`，查看 staged/unstaged/untracked、删除文件和大 Diff，复制原文及打开目录。确认面板拖动、窄屏浮层、关闭面板保持输入。
2. 日常 TUI 与 Desktop 同时操作，确认新建/切换会话、Handoff、审批和草稿 CAS 一致；共享 Workspace 并行执行可能互相影响文件，不提供 Agent 修改归属。
3. 使用已认证真实 Harness 做跨模型接力，展开源报告和降级材料；明确选择失败后的重试、确认或取消。UNCERTAIN 检查历史与文件，不能自动重发。
4. 新建临时 Worktree 会话后删除会话，确认源码和分支还在；清理前核对 retained 目标和保留说明，尝试取消，脏 Worktree 必须拒绝清理。RETAINED 目录后续人工删除不在本阶段自动执行。
5. `/path`、`/不是命令 普通文本` 的确认、Esc 关闭、重复点击与断线行为；真实中文输入法候选窗口、物理键盘和多显示器 DPI 仍待人工验收。自动化组合键/composition 事件不等于所有真实 IME 已验证。
6. 极大历史/超限 Diff、路径被外部进程持续重命名的竞争、各企业 VPN/防火墙、所有 WSL 发行版名称与 Windows 不支持的文件名未做穷举；失败准确提示，不修改用户环境或绕过边界。

不自动实施 Desktop Phase 4，等待本阶段人工验收。
