# Desktop 架构决策 D1：Windows 客户端 + WSL2 执行环境

2026-11-11 用户新增 Desktop 图片选择与 Ctrl+V 粘贴。新建页及已有会话发送 ACP image content block，按原生 promptCapabilities.image 检查能力，图片草稿落同一 WSL SQLite，schema 9。实现、Windows 验证和真实 Harness 未验证边界见[图片补充验收](acceptance/desktop-phase-4-images.md)。

2026-11-10 用户要求归档对话从项目列表中隐藏。Desktop 项目树始终仅展示未归档对话；“查看归档”打开独立模态窗口，集中搜索、查看和恢复归档对话，并显示原属项目。实现及真实 Windows 验证见 [归档窗口补充验收](acceptance/desktop-phase-4-archive-window.md)。

2026-11-10 用户补充 Desktop 会话行重命名/归档、免命名新建页、项目与工作树起始分支选择，以及独立会话置底和顶层缩进。实现与本轮验证见 [补充验收](acceptance/desktop-phase-4-new-conversation.md)。新建页消息草稿使用同一 WSL SQLite 的 CAS 存储，schema 8。

状态：用户明确新增的产品方向；Phase 1 为下文历史基线，Desktop Phase 2 扩展见文末。原 Linux/WSL TUI 六阶段设计及验收记录保留，不能用本决策追认历史未验证项。

## 范围变更

`01_ARCHITECTURE.md` 原 MVP 的“无 Windows 原生客户端”仅描述原六阶段范围。现在新增 Windows x64 Electron + React + TypeScript 客户端，工作区、原生 Harness、ACP Runtime、Hono Daemon 和 SQLite 仍全部在用户选中的 WSL2 发行版。保留 Bun Workspaces 与 `apps/tui`。不提供浏览器网站、远程服务、Windows Agent Runtime 或第二个业务数据库。

## 审查结论与 API 复用

已审查 CLI lifecycle、Daemon composition/runtime-routes、shared client/paths/DTO，以及既有单实例、HTTP/WS/Origin、安全、会话恢复、Handoff/Worktree 测试。

| 现有接口 | Desktop Phase 1 用途 |
| --- | --- |
| `GET /v1/health` | Windows 端再次核验 product、runtime、instanceId、PID、version、protocolVersion |
| `GET /v1/snapshot` | 同一 SQLite 中的 Project、Conversation、状态、归档与活动信息 |
| `GET /v1/preferences` / `PATCH /v1/preferences` | 恢复/保存 lastConversationId；唯一的应用数据写操作 |
| `GET /v1/conversations/:id/events?after_seq=N&limit=200` | 分页读取已提交原始/结构化事件，连续 seq 验证、去重 |
| `WS /v1/ws` | 验证 hello.instanceId；以 change/conversation.event 作失效通知，重新读 SQLite |

无需新后端业务路由、迁移或 ACP 状态机更改。只导出已有 instanceSchema，并将现有纯事件分类从 Solid transcript 提取到 shared/event-projection，TUI 原行为保持、Desktop 复用同一诊断过滤规则。

## 启动与连接

Windows Main 用绝对系统路径 `System32/wsl.exe`，`execFile` 参数数组、30 秒超时、1 MiB 输出上限、无 cmd.exe。处理 UTF-16LE/BOM 和 UTF-8；从右向左识别发行版版本列，兼容本地化状态和带空格名称。显示 WSL1 但不可选；每次连接重新确认选中名称在真实 WSL2 列表中。

首次必须由用户选择发行版。Windows userData 只存 `desktop-settings.json`（发行版名称），不存 Token/数据库/完整 UI 快照。以后自动使用，失败保留手动重连/切换入口。

固定 `/bin/sh -c` 脚本仅访问 WSL 默认用户的 `$HOME/.local/lib/harnesshub/desktop-bridge`；脚本无用户字符串拼接。发行版、期望版本/协议均通过 argv。WSL `--cd ~` 避免继承 Windows UNC/C 盘 cwd，不依赖登录 shell、`.bashrc`、Windows HOME/PATH 或 Node/Bun 恰好在默认 PATH。

`install:local` 在已有 flock/安全升级流程中额外原子安装 0700 Bridge launcher，引用同一不可变 release、绝对 Bun 路径，保存安装时 Linux PATH 和解析后的 XDG 根目录。它不保存/读取原生 Harness 凭据或 shell 配置。新入口 `hhu desktop-bridge <expectedVersion> <expectedProtocol>`：先匹配版本，再调用已有 ensureDaemon/health；私有 stdout 返回版本化 JSON，失败返回固定错误代码，不输出 Token 或子命令 stderr。已有 Daemon 直接复用；冲突/不兼容实例不停止、不覆盖；冷启动仍使用 flock + detached Node + 私有日志。常规 `hhu` 启动 TUI 的语义不变。

Windows Main 再通过 127.0.0.1 动态端口核验健康身份，然后无 Origin、Bearer Header 连接 WS。Token 只在 Main 的实例对象中；不进入 URL、Renderer IPC 状态、日志或 Windows设置文件。Daemon 仍监听 127.0.0.1，保留 Origin 拒绝，无 CORS/0.0.0.0 例外。

网络依赖 WSL2 localhost forwarding（也允许能通过相同回环路径工作的 mirrored mode）。连接失败给出 WSL、VPN/防火墙、端口冲突诊断，不改网络设置、不开放端口。如果机器网络策略无法支持该路径，本阶段明确不支持绕过。

## Main / Preload / Renderer 边界

Main 的 `DesktopConnection` 管理连接 epoch、请求失效、单序列历史读取、连续水位、偏好写入串行化和重连计时器。先 WS hello，再读取快照/历史，3 秒轮询修复漏通知。每次连接故障丢弃 Client/Token；重连重新执行 Bridge，禁止缓存旧端口/Token。历史保留并从最后 seq 补拉；发行版切换清空旧数据。手动选择/重新连接/关闭不会提交任何 Prompt、审批或 Handoff 操作。

Preload 是单 CJS bundle，暴露 `request` 和 `subscribe`，不暴露 ipcRenderer、Node、event 对象或任意 channel。请求联合严格校验，只允许 `state/discover/connect/reconnect/select`。Main 同时验证发起者 webContents、mainFrame 对象与精确打包 file URL，拒绝子帧/外部窗口。

BrowserWindow：`contextIsolation=true`、`nodeIntegration=false`、`sandbox=true`、`webSecurity=true`。CSP 默认 none，只允许自身脚本/样式，无 inline/eval，Renderer connect-src none。拒绝导航、新窗口、webview、下载和权限请求。Agent 原文经 React 文本节点显示，不执行 HTML 或 Markdown 链接。Debug 原始事件同样是纯文本。系统 zoom 菜单提供缩放；不添加监听普通输入的全局键位。

关闭窗口只 dispose HTTP/WS UI 状态，不访问 stop/session/cancel 路由；Windows 退出不等于关闭 WSL 本身。WSL shutdown/Windows 重启后任务不保证存活，沿用原 Daemon 恢复真实状态语义。

## UI 设计与 Phase 1 边界

采用 Coding Agent 工作界面的内容优先布局，不复制其他产品 Logo/商标/素材。深色 CSS 变量覆盖背景/文本/悬停/选中/边界/状态，可为后续浅色主题替换；使用系统 Segoe UI 字体与简单文字图标，不使用网络字体。用户补充提供了 HarnessHub Logo，按用户最终要求采用黑色透明原图，转为纯白透明裁剪 PNG、深灰底 512px 图标和多尺寸 ICO，用于顶栏、空态、窗口/任务栏及 EXE 图标；原图与来源保存在 apps/desktop/assets，未重新生成或复制其他品牌素材。

组件层次：React `App` 管理 Main 提供的数据快照与本地展示状态 → 顶栏/WSL 环境选择 → Project 分组/`ConversationItem` → 聊天 transcript/只读 composer → Details/Debug 工作面板。`renderer/history.ts` 负责纯消息投影，`shared/event-projection.ts` 区分内容与内部诊断。Main `window.ts` 是窗口与 IPC 组合根，`connection.ts` 与 React 无依赖，可用于 Phase 2。

左栏默认 260px，可拖至 220–420px、键盘微调、隐藏；项目展开折叠、真实标题/Harness/状态、独立滚动、即时搜索、归档列表。新建/重命名/归档/恢复/删除入口禁用并注明 Phase 2，不伪装成已实现。选择会话即读取该会话，不创建原生 session。

中间显示真实用户/Agent 原文，合并连续 chunks，保留公开 Thinking、Plan、工具原生标题/状态。Markdown 暂按原文显示，没有语法高亮/完整工具内容/正式流式优化/输入与草稿/审批 UI。内部 initialize/auth/worker PID 等不放入聊天。未知事件保留在 Debug，内部 Handoff 输入不伪装成用户消息。

右栏默认关闭，Details 显示 Linux Workspace/状态；Debug 每组 20 个原始事件可展开；Changes 禁用。宽屏三栏，窄于 900px 右栏浮层以保留主聊天宽度。长历史内存与事件数相关；Phase 1 不宣称大规模历史虚拟化完成。

所有 cwd 始终是后端返回的 Linux 绝对路径，Phase 1 没有文件写入、路径转换或 Explorer 调用。未来 Explorer UNC 定位只属 UI 功能，不得送回 ACP。

## 构建边界与依据

Bun 构建 Main/Preload 为 Node CJS（Electron external），React 为 browser bundle；不会打包 SQLite/OpenTUI/ACP Runtime。Windows 本地安装使用 `--filter @harnesshub/desktop --filter !harnesshub --ignore-scripts`，排除根后端及原生 Harness，之后只显式安装 Electron 二进制。Linux backend build 与 desktop build 独立。

electron-builder 将 dependency-free staging 放到仓库外，避免自动向上收集 workspace 原生依赖。输出 Windows x64 目录包；构建后校验 asar 不含 node_modules/.node/OpenTUI/SQLite。无签名/自动更新/云服务。

实施时读取的官方资料（2026-11-09）：

- [Electron Security](https://www.electronjs.org/docs/latest/tutorial/security)：isolation、sandbox、CSP、IPC sender、navigation。
- [Electron Process Sandboxing](https://www.electronjs.org/docs/latest/tutorial/sandbox)：最小化 preload，只 bundle 需要的代码。
- [WSL basic commands](https://learn.microsoft.com/en-us/windows/wsl/basic-commands)：list/verbose、distribution、exec、cd。
- [WSL networking](https://learn.microsoft.com/en-us/windows/wsl/networking)：Windows localhost 访问 WSL 网络服务及网络模式限制。

真实验证结果、已知限制及 Windows 操作步骤见 `acceptance/desktop-phase-1.md`、`DESKTOP.md`；本文件不等同验收通过。


## Desktop Phase 2：正式聊天（2026-11-09）

本阶段经用户授权。继续共用 WSL Daemon、SQLite、ACP Runtime；没有 Windows Agent 执行器、新业务路由、数据库迁移或自动审批。

Main 增加严格 schema 的固定 Action：草稿读取/CAS 保存、保留 requestId 的 Turn 提交、请求查询、原生审批/取消、Harness 选择、显式 Session 准备、ACP settings、Handoff 原有 action、Conversation CRUD、固定事件分页、复制文本和草稿保存后的窗口关闭。仍核验 webContents + mainFrame + 精确文档 URL；不暴露任意 REST/URL/文件/命令/Token。删除只映射已有 confirmed=true Conversation 删除路径。

提交由 Main 先 CAS 持久化 pendingSubmission，再 POST turns；Runtime 计算 requestHash、去重并原子消费匹配草稿。未知结果保留本地和/或 SQLite requestId，仅查询不重发。Renderer 的独立纯草稿队列不依赖 TUI 生命周期；冲突保留本地文本，用户复制或显式重新载入服务器版本。正常关闭先 flush；失败留窗提示，关闭本身不取消 Agent。

Main 按连续 seq、每页 200 条读取，40ms 合并失效通知，IPC events 仅包含新批次；Main 最多保留 200 条检查尾部，完整源仍在 SQLite。Renderer 缺口走固定 history Action 补拉，按增量投影合并文本/工具，工具键为 NativeSession + Turn + toolCallId（防原生 ID 跨 Turn 重用）。消息按 100 条分页挂载，手动阅读固定当前页，不强制跟随；用户展开状态独立于工具更新。Renderer 仍保留已读源事件和投影，超大历史总内存尚未完全有界。

Markdown 使用锁定 react-markdown + remark-gfm，不启用原始 HTML；lowlight 只转换 React span/text。图片不加载，链接仅展示可复制地址，禁外部导航保持不变。工具参数/输出/Diff 保留原生内容，诊断分类复用 shared/event-projection。

Harness 选择不启动 Agent；显式“连接 Agent 获取选项”只准备原生 session；跨 Harness 首条消息仍交给原有 Handoff。仅当前 READY NativeSession 的 ACP commands/config/modes 可操作，未发布能力准确说明。Phase 3 完整 Changes/Diff/Handoff 工作面板与 Phase 4 安装发布未实施。

## Desktop Phase 3：Coding Workspace（2026-11-09）

经用户授权，增加 Changes/Diff、完整 Handoff 追溯、托管 Worktree 和 WSL 文件夹定位。仍使用同一 Daemon Git 查询、Handoff 状态机、Worktree Manager、SQLite 与 ACP Worker，无第二套业务运行时。

- `changes.list/diff` 固定映射已有 `/v1/conversations/:id/changes[?path=…]`；只在面板打开时轮询，3 秒间隔，Main 合并相同未完成查询、最多 4 个 Git 查询在途。单文件按需读取；文件列表 100 项/页、Diff 30 块/页、块内 200 行/页，只有展开块进行代码高亮。Git 的既有 10 秒/2 MiB 查询上限不变；超限明确报错。Git 非原子读，显示观测时间，不声称文件属于某个 Agent。
- 工具卡的 `content.type=diff` 保留 ACP 原生 oldText/newText，显示独立来源标识及完整原文复制；不将其解释为当前 Git 状态。工具合并额外保留 content/locations 各自最新事件 seq，用于从真实来源定位文件夹。
- Handoff 数据来自已有 sessions/handoffs 查询与 WS 失效补拉；Details 展示源/目标 Harness、NativeSession、事件边界、报告、降级材料及原请求。只选择 Harness 不启动模型。仅 FAILED 提供重试/降级确认/取消；UNCERTAIN 没有重发入口。不改变服务端状态机或投递语义。
- Conversation 创建传递既有 `workspaceMode`；托管列表和确认清理映射既有 `/v1/worktrees` 与 `/cleanup`。清理前说明目标 retained 目录和保留分支，已绑定会话不能清理；保留后端 RETAINED 策略，无 force、自动分支删除或文件删除。
- 唯一新增 Daemon 路由为只读 `POST /v1/conversations/:id/workspace/location`。它接受 workspace/change/tool 的来源引用，查当前 Git 状态或该 Conversation 的原生事件后，验证 Linux 词法边界与 realpath。符号链接不能逃离 Conversation Workspace；删除文件定位最近存在的父目录。请求不能指定任意导航目标、命令或 URL。
- Main `workspace.open` 仅将该返回目录转换为所选发行版 `\\wsl.localhost\<distro>\…`，再调用 Electron `shell.openPath`。UNC 仅用于打开文件夹，不写回 SQLite 或 ACP cwd。特殊字符按字面处理；Windows 无法无歧义表示的名称拒绝定位并保留 Linux 路径复制。Renderer/Preload 无通用 shell、文件读取或任意路径 API；Token 与原 IPC 来源验证边界不变。
- 未发布的 `/xxx` 必须通过独立模态框明确确认作为普通 Prompt 发送，关闭确认框只取消意图。确认绑定当前文字/Harness、一次性消费；后续使用原 DesktopDraft 的 CAS、requestId 和未知结果查询机制，不携带 nativeCommand。Enter/IME/Shift+Enter 与已发布命令补全保留。
- 右侧默认隐藏，Changes/Diff/Details/Debug 共用可拖动面板；窄屏浮层，关闭不卸载 Composer。仅本地视图状态，不保存完整 UI 快照。

核对依据：[Electron shell.openPath](https://www.electronjs.org/docs/latest/api/shell#shellopenpathpath)、[Electron Clipboard](https://www.electronjs.org/docs/latest/api/clipboard)、[Microsoft WSL 文件系统](https://learn.microsoft.com/en-us/windows/wsl/filesystems)。实现依据锁定 Electron 45.2.3 的类型定义，剪贴板读写等待 Promise 完成。实际 Windows/Agent 结果见 `acceptance/desktop-phase-3.md`；不进入安装、签名、更新或发布阶段。

## Desktop Phase 4：Windows Distribution（2026-11-09）

客户端与后端统一为 0.6.2，协议 1；0.6.1 仍是历史验收版本。构建保持 Electron 45.2.3 / electron-builder 26.18.0。仓库外全新 staging 只打包 Main/Preload/React/品牌资源，NSIS 当前用户安装、ZIP 目录包，显式 unsigned、无发布/自动更新。固定 appId `org.harnesshub.desktop` 及 HarnessHub userData，安装/升级/卸载不调用 WSL，不删除用户数据。随包 DESKTOP.md、release-manifest、SHA256SUMS；asar 内容用严格文件白名单检查。

启动/Details 展示 Desktop/Bridge/Daemon/协议/instanceId/发行版/连接状态。Bridge 返回经过 schema 过滤的非秘密诊断；未知版本/旧 Bridge 不推断为空闲。Token/端口仍留在 Main。新增 `GET /v1/daemon/upgrade-readiness` 只读检查；`hhu daemon upgrade-check` 手动预检，`hhu daemon stop --for-upgrade` 在实际关闭前同步重查并设置 closing，阻止竞态新提交。活动 Turn、审批、未解决 Handoff、UNCERTAIN/输入投递、Session/Git/删除操作均拒绝升级停止。普通 stop 保留旧恢复语义，升级引导明确要求专用标志；旧后端不支持时拒绝或人工核对，不能自动升级。

WSL install:local 继续持同一 flock、完整 release staging、原子 launcher 替换；新 release 下保存上次精确 launcher 对及 receipt。迁移前备份、迁移错误事务回滚、拒绝未来 schema 保持不变。两份 launcher 不是跨文件原子事务：第二次替换失败恢复旧 Bridge；断电中间态按诊断拒绝连接，提供人工恢复，不覆盖唯一 DB 原件。没有原生 Agent 配置操作或 Windows Agent Runtime。

官方依据：
- https://www.electron.build/docs/nsis ：assisted/per-user、目录选择、快捷方式、卸载数据策略、稳定 appId/GUID。
- https://www.electron.build/docs/win ：`signExecutable: false` 保留资源编辑但跳过签名；Windows x64 targets。
- 锁定 electron-builder 26.18.0 的 winOptions/nsisOptions 类型和安装模板同时核对；在线资料不能替代真实产物验收。

实际 Windows、签名、真实 Harness、回滚/重启和物理 DPI 的通过与未验证边界统一记录在 `acceptance/desktop-phase-4.md`。完成后只等待人工验收，不上传正式 Release。

### Desktop Phase 4 补充：GitHub 安装包分发

用户追加要求 Windows App 也可从 GitHub 直接下载安装包。统一发布工作流调用既有 Windows NSIS/ZIP 验证管线，与 Linux 独立后端一起按同一版本 Tag 构建；两个平台成功后创建单个 draft Release。Windows 校验/manifest 上传时增加 `windows-x64-` 前缀，避免与 Linux 资产冲突。Windows 用户直接下载 exe 或 ZIP，所选 WSL2 发行版安装同 Release 的后端包，无需源码 checkout。保持 unsigned、手动发布和无自动更新；本地配置不代表远端发布或平台验收通过。实施、真实本地验证及远端未验证项见 [GitHub 分发补充验收](acceptance/desktop-phase-4-github-distribution.md)。

### Desktop Phase 4 补充：共享目录选择分支

2026-11-10 用户要求未勾选“创建工作树”也可选择分支。新建页对已有提交的 Git 项目开放本地分支选择；只选择不执行 Git，首次发送才创建 Conversation。`baseBranch` 在 Worktree 模式仍是新托管分支的起点，在 Shared 模式表示切换项目共享目录的本地分支；未传该字段的现有调用继续使用原目录。Shared 切换会影响使用同一目录的会话，界面明确提示，ACP cwd 仍绑定原项目根目录。后端在 Git 操作期间预留整个仓库路径，拒绝活动或未解决会话下的实际分支切换，不 force、不 stash，不覆盖冲突或 ignored 文件；相同分支不执行切换。验收见 [共享分支选择](acceptance/desktop-phase-4-shared-branch.md)。

### Desktop Phase 4 补充：会话侧栏与全局设置（2026-11-10）

用户修正 Desktop 的内容分区：右侧工作面板仅显示当前 Conversation 的详情、真实 Changes/Diff、原始事件和 Handoff。环境诊断、版本信息、安装/升级指南、WSL 发行版选择及全部托管 Worktree 管理统一进入左上角“应用设置”模态窗口。没有选中会话或处于新建会话页时不展示工作面板；连接故障通过独立帮助入口打开相同设置。

取消 Desktop 左侧栏隐藏按钮，左栏始终显示 Project → Conversation 树，通过分隔条拖动在 220–420px 调宽，保留键盘微调。拖动按鼠标初始位置计算增量并捕获指针；窄窗口右栏浮层展示，不覆盖用户选定的左栏宽度。上述规则取代本文早期 Phase 1 关于 Desktop 可隐藏侧栏、Details 内全局环境信息的说明，TUI 沿用自身交互。本次只调整 Desktop 视图，不新增后端、IPC、数据库或 Agent 行为。专项验收见 [会话侧栏与设置](acceptance/desktop-phase-4-conversation-layout.md)。
