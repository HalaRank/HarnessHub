# Desktop Phase 4 — Windows Distribution & Release Readiness

日期：2026-11-09 America/Los_Angeles（部分 Windows/UTC 日志为 2026-11-10）。范围仅本阶段；不自动发布或进入下一阶段。版本统一 **0.6.2**，协议 **1**，SQLite migrations **7**（本阶段无新增数据库迁移）。

## 交付结论

已实现 NSIS/ZIP 发布管线、首次启动环境指引、版本/实例展示、安全升级预检及停止、旧 launcher 保留、Windows 安装/卸载数据隔离、发布校验与 CI。真实 Codex → Grok → Codex 交接、OpenCode 消息/工具通过；Claude 因原生未登录受阻。

**尚不宣布 Release Candidate 达标**：签名缺失（明确 unsigned 测试分发）、物理 DPI/多屏/中文输入法、全新 Windows/WSL 安装机器、Windows 重启后真实恢复等仍需人工验收。自动化通过不等于这些人工项通过。不发布 GitHub Release，不启用自动更新。

## 审查及实现文件

已按 AGENTS 阅读架构 01/02/03、Desktop Phase 1–3 验收、旧 DESKTOP；审查 Main/Preload/Renderer、WSL Bootstrap、health/instance/协议、CLI lifecycle、install:local flock/staging/launcher、SQLite 迁移/备份及既有测试。开始工作区干净。

| 文件 | 结果 |
| --- | --- |
| `scripts/desktop.ts`, `desktop-release.ts` | 新鲜仓库外 staging；NSIS + ZIP x64；稳定 appId/Logo/icon/开始菜单/卸载注册；显式 unsigned/manual publish；asar 严格白名单，SHA256SUMS/manifest |
| `scripts/version.ts`, 全部 package.json/shared VERSION/bun.lock | 统一 0.6.2；版本检查和显式 bump，不将同一协议当作版本兼容 |
| `apps/desktop/src/renderer/Environment.tsx`, App/style | 首次 WSL/Bridge/Daemon 指引；Desktop/Bridge/Daemon/协议/instanceId/发行版/状态及不兼容处理 |
| `apps/cli/src/desktop-bridge.ts`, Desktop wsl/connection/contracts | 非秘密诊断 schema；只读实际健康身份/安全预检；旧版未知不推断空闲；Token 不进 Renderer |
| `packages/core/src/runtime.ts`, Daemon index, CLI lifecycle/index | `GET /v1/daemon/upgrade-readiness`、`hhu daemon upgrade-check`、`stop --for-upgrade`；活动 Turn/审批/Handoff/Session/Git/删除/未知输入阻止升级停止，实际执行同步重查 |
| `scripts/install-local.ts` | 保留完整旧 release 和 previous-launchers/receipt；第二次 launcher rename 失败恢复旧 Bridge，迁移策略不变 |
| Desktop main/index | 显式绝对 `--client-data-dir` 用于隔离/Portable 客户端配置；不修改 WSL HOME/XDG |
| `scripts/verify-windows-installer.ps1`, `verify-desktop-release.ts` | 真实 Windows 隔离安装/升级/卸载/重装/异常退出，后台 Mock Agent + SQLite/源码/Worktree/配置哨兵哈希保留检查 |
| Desktop release/windows-handoff/windows-smoke tests、integration tests | 发布边界/诊断/活动安全检查/恢复/launcher 对；真实 UI Harness 接力与新增窗口缩放检查 |
| `.github/workflows/desktop-windows.yml` | Windows x64 构建、边界测试、安装器验证、候选 artifact 保存，无 Release 发布权限；远端 CI 尚未触发 |
| `docs/DESKTOP.md`, 架构/README | 修正 Phase 3 已完成能力，首次安装、WSL 准备、版本矩阵、升级/恢复、卸载保留、验证和故障处理 |

Windows App 仍只负责 UI，业务数据和 Git/ACP 都在 WSL。无新数据库/Windows Agent Runtime/密钥管理。安装器不调用 WSL，不停止 Agent；卸载不删 WSL、SQLite、源码、Worktree、登录凭据或 Windows userData。旧 ZIP 与新安装器共享 HarnessHub 默认 userData，测试显式隔离。

## 升级、迁移和失败边界

Windows 升级独立于 WSL。版本不兼容不发送 Prompt，不重发不确定请求，不替换活动后台。Bridge 若来自旧版且没有诊断字段，显示未知，要求匹配旧版本核对；不能证明安全就不升级。

只读 readiness 不是停止许可。升级必须显式 `hhu daemon stop --for-upgrade`，实际停止前同步重查并设置 closing。普通 stop 保留历史恢复语义；回归中发现将升级约束施加给所有 stop 会破坏持久化 FAILED/UNCERTAIN 的正常恢复测试，已改为专用升级标志，而不是放宽测试。

install:local 仍拒绝任何运行/持锁 Daemon，构建 staging 完整才替换 launcher。旧 CLI 和 Bridge 精确副本、不可变 release 保留；迁移前私有备份、事务失败回滚、未来 schema 拒绝均保留并测试。两个 launcher 不是跨文件事务；断电中间态可能需人工恢复，不能声称自动回滚。恢复过程见 DESKTOP.md，必须停机持锁，先保留 DB/WAL/SHM 原件，禁止静默覆盖唯一数据。

## 自动化结果

最终日志位于 [evidence/desktop-phase-4](evidence/desktop-phase-4)。开发中出现并修正的失败没有冒充最终成功：版本展示导致旧 instanceId 隐藏断言过期；测试误用非等待 Mock 文本；升级停止与旧恢复冲突；真实事件读取 limit 超限/未分页；Windows compositor 隐藏窗口使 requestAnimationFrame 等待停滞。仅 Windows 自动化测试关闭 background throttling 并增加有界等待，产品窗口逻辑保持。

| 命令 | 最终结果 |
| --- | --- |
| `bun run typecheck` | 通过根/Daemon/Desktop |
| `bun run lint` | 通过 |
| `bun run build`、`bun run desktop:build` | 随完整/专项测试实际构建通过 |
| `bun run desktop:test` | 40 单元 + 15 Node 集成，0 失败 |
| `bun run test` | 101 Node 集成 + 116 TUI/UI，0 失败 |
| `git diff --check` | 通过 |
| `HHU_DESKTOP_REAL=1 HHU_DESKTOP_HANDOFF=1 bun scripts/verify-desktop-windows.ts` | 真实 Windows UI 主回归通过；真实 Harness 分项以以下记录为准，整体 UI passed 不替代 Harness 结论 |

专项覆盖：原生审批/取消、WS seq 补拉、ACK 丢失不重发、草稿 CAS、Handoff 去重、不同 Session 来源、Git/Worktree 保留；升级预检拒绝活动 Turn、待审批、未解决 Handoff，身份/Token 保留；安装锁阻止无响应实例；构建失败旧 release 可运行；恢复 launcher 对内容精确；迁移失败回滚与备份私有；未来 schema 拒绝。

## Windows 实机与真实 Harness

实机 Windows x64（构建器报告 Windows 10.0.26200）、Electron 45.2.3、Ubuntu-26.04 WSL2。UI 证据 Windows `hhu-desktop-smoke-FsNBaU`，隔离 Linux `/tmp/hhu-windows-smoke-tWK8eq`；Mock 与真实模型清楚区分。真实 hhu TUI 在 PTY 同时连接，关闭其自身不结束后台。已查看 OpenCode 截图，其会话/工具/Changes 与实际文件一致。

| 场景 | 结果与限制 |
| --- | --- |
| WSL 发现/选择、Bridge 冷启动、重开恢复选择/会话 | 真实 Windows wsl.exe + HTTP/WS + SQLite 通过；首次选择控件以 Chromium 事件/受控 IPC 操作，非物理键盘 |
| 完整聊天、Git Changes/Diff/Explorer、Worktree/清理保留 | Windows Mock 回归通过；OpenCode 真实文件与 Git Diff 通过 |
| 同时运行 TUI、关闭 App 保活、草稿恢复 | 真实 Windows + WSL TUI PTY + Mock Worker 通过 |
| 125%/150%/200% | Chromium zoom 无横向溢出通过；**物理屏幕 DPI 未验证** |
| 最小化/恢复/最大化/全屏 | 真实 Windows Electron 窗口调用通过 |
| 多屏拖动、物理鼠标/键盘、真实中文 IME、Ctrl+C/V/A/Z/Y 全组合 | **仍待人工**。已有自动化输入/composition/剪贴板/鼠标分隔条不替代真实硬件体验 |
| Daemon 断开/重连、真实中断状态 | Node/SQLite/WS 集成通过；Windows WSL shutdown/整机重启场景 **未执行**，避免影响用户日常任务 |

### 原生 Harness

- **Codex → Grok → Codex：通过。** Conversation `acbc4ac0-aa3c-4aa2-ae2b-6cfb024498be`。三个 user Turn 均 COMPLETED，两个 Handoff 均 COMMITTED。Session 应用 ID 和原生 ID 三个均不同；cwd 全为隔离项目。源报告包含约束 `violet lantern 47`；三个原生回复均保留约束并有工具调用。返回 Codex 使用新的原生会话，不复用原 Codex。报告/边界/来源与 2246 条真实事件保留。
- 原 Handoff 验证脚本错误拼接 JSON chunks、只读首 1000 条，最初 evidence 为失败。修正后**对原请求的完整 SQLite 事件只读复核**通过，见 `real-handoff-revalidation.json` 与 `real-handoff-events-complete.json`。没有重新发送任务，也没有修改原失败证据。Codex metadata fallback 警告原样保留。
- **OpenCode：通过。** 17 个消息 chunks、3 次原生工具调用、COMPLETED，创建 `phase3-opencode.txt` 内容精确为 `HARNESSHUB_PHASE3_opencode_TOOL_WRITE\n`；Windows Changes/截图与文件核对一致。测试沿用旧文件名前缀，不代表旧证据。
- **Claude：受阻。** 原生 initialize/session/new 成功，authStatus=`Not logged in`，Prompt 返回 `-32000 Authentication required`，Runtime 记录 UNCERTAIN；0 消息、0 工具。未读取/改动凭据、权限模式或登录，没有自动重试。
- 真实任务没有自然出现人工审批请求，**真实人工审批未验证**；Mock 测试只明确选择 Reject，不冒充真实人工授权。
- 原生 Session 可观察来源隔离通过；不声称不可观察模型内部记忆可以完全证明隔离或跨模型无损迁移。

隔离真实 Harness 测试 Daemon 正常停止因 Claude UNCERTAIN Worker 被拒绝，未强杀，现场保留于 `/tmp/hhu-windows-smoke-tWK8eq`，等待人工检查。其他成功清理的测试实例正常停止；没有操作用户默认 Daemon、全局安装或日常数据库。测试自身异常退出那轮 Windows Electron 仅在核验专属测试 executable 路径后结束；未使用 PID 操作 WSL 后台。

## 安装产物与校验

构建工具：electron-builder 26.18.0、Electron 45.2.3。Linux 交叉构建已产 ZIP，但 NSIS 构建工具下载遇 ECONNRESET；保留失败日志，不跳过校验。转为真实 Windows Node 构建同一 Bun 预编译 staging、同一发布配置。临时 Windows builder 使用精确 electron-builder 26.18.0（npm 单独安装构建工具）；因此最终产物不是“本轮完整 Windows filtered Bun 从零安装”验收，CI 标准路径仍需远端执行。

最终文件、SHA256、安装/卸载结果见下面补录。仅 unsigned 测试包，无签名证书验证，无正式发布。SmartScreen/企业策略可能阻止执行，不能通过关策略来视作发布就绪。

## 人工验收与剩余风险

1. 在隔离 Windows VM/测试账户从全新系统准备 WSL，选择发行版、Bridge、App 安装、版本不匹配、安装升级、卸载、重装恢复 Conversation；不使用日常数据库。自动化安装结果以下方补录为准。
2. 物理 DPI 125/150/200%、多屏拖动、真实中文 IME 候选 Enter、Ctrl+C/V/A/Z/Y、分隔条/滚动/窗口手感。
3. 用隔离 WSL 发行版测试 Windows reboot/WSL terminate，重连核对 INTERRUPTED/UNCERTAIN，不要求正在执行任务继续运行。
4. Claude 用户自行完成原生登录后，明确提交新的独立测试；自然审批由用户亲自选择。不要把旧 UNCERTAIN 自动重发。
5. 配置真正代码签名和发布来源认证前，保持 unsigned 测试分发；自动更新继续推迟。不能只凭 SHA256 信任发布者。
6. 双 launcher 断电中间态、迁移成功后降级恢复、所有发行版/企业网络/防火墙组合不做穷举；按文档保留旧版本与原件人工恢复。

完成后等待人工验收，不发布正式版本。

### 0.6.2 unsigned 最终产物

Windows Node 构建成功，最终文件复制到仓库 `dist/desktop/releases/0.6.2-unsigned/`。构建器未加载签名凭据；exe、uninstaller、installer 明确跳过签名。

| 文件 | 字节数 | SHA256 |
| --- | ---: | --- |
| `HarnessHub-0.6.2-windows-x64-unsigned-setup.exe` | 110726338 | `4c44190660c30a91bfa66720e64c615345781a99cfc0f7c43d2586c89925d46f` |
| `HarnessHub-0.6.2-windows-x64-unsigned.zip` | 153510243 | `825e118937fcb2687e861c420f92f4f67645102c946b5c14409312322ef17d08` |

`SHA256SUMS.txt`、`release-manifest.json` 同目录；小文件副本在 evidence。ASAR 只包含 9 个白名单文件：assets/icon.ico/icon.png/logo.png，main/index.cjs/preload.cjs，renderer/index.html/index.js/index.css，package.json。Electron/DLL/Chromium locales 和随包 DESKTOP.md 为必要资源。无 node_modules、.node、better-sqlite3、OpenTUI、ACP Worker、原生 Harness 或用户配置。

### Windows 安装/升级/卸载实测补录

`bun scripts/verify-desktop-release.ts <Windows 0.6.2 release> <Windows 0.6.1 fixture release>` **退出 0**。Windows `installer-evidence.json passed=true`，隔离 WSL `release-backend-evidence.json passed=true`。运行前拒绝任何已有 HarnessHub 安装注册/快捷方式/进程；全部写入唯一临时目录。测试安装现已正常卸载，Start menu/卸载注册清理；临时源码、数据库、客户端设置保留。

| 验收 | 本轮结果 |
| --- | --- |
| Portable ZIP 实际启动/正常关闭 | 通过，真实 Windows HWND/title；共享显式隔离 client-data |
| 当前用户 NSIS 全新安装、开始菜单、卸载入口 | 通过 |
| 0.6.1 → 0.6.2 升级安装 | 通过；0.6.1 是本轮在版本 bump 前构建的安装夹具，不冒充历史正式 Release |
| 异常退出再启动 | 通过，仅结束核验路径的测试 Windows App 进程，后台未终止 |
| 普通卸载/重装启动/客户端设置保留 | 通过；未强删目录或 WSL 文件 |
| 安装升级卸载期间活动 Agent | 同一 instanceId，Mock Turn 仍 RUNNING；通过 |
| WSL 数据保留 | SQLite DB/WAL、源码、Worktree 文件、独立模拟原生配置哨兵的 SHA256 前后完全一致；通过。没有读取日常原生凭据以作哈希 |
| 重装后已有 Conversation | 原 ID/历史在隔离后端仍可查询；**已安装生产窗口直接重连该隔离库仍未单独覆盖**（生产 Bridge 固定默认用户安装位置，未覆盖用户 Bridge）。Windows 同版 UI 的重开会话恢复由专用隔离 Bridge smoke 覆盖 |
| 旧 Phase 3 目录包 → NSIS | 本轮以新版 ZIP → NSIS 和旧 NSIS → 新 NSIS 覆盖；**原历史 Phase 3 ZIP 二进制未直接复跑** |
| 安装器签名 | PowerShell `Get-AuthenticodeSignature` 检查为 `NotSigned`，明确 unsigned |
| ZIP/安装后 payload | ZIP 与检查过的 staging ASAR 完全一致；安装后 ASAR 哈希实读相同 `80dc4847cd8c48b115f00dd766a550c87ac4fb597d925f685957bb79d6bbba3d`，见 payload-verification.json |

测试脚本第一轮将单个 PowerShell 注册对象误当数组，并假定 InstallLocation 字段存在；实际 NSIS 用 UninstallString。现改用 `@(Installed).Count` 和精确测试 uninstaller 路径判断，修正后完整流程通过。未据脚本失败删除用户安装。

这是一台已有 WSL 的真实 Windows 测试，不是全新系统镜像。无 WSL 首装、安装向导所有人工选项、重启恢复、物理设备体验、Claude 登录和真实人工审批仍按未验证项处理。**Release Candidate 判定仍为未达标，等待人工验收。**

## 2026-11-10 工具活动区优化

依据用户提供的 HarnessHub 与 Codex 截图，聊天工具区增加连续调用分组、成功摘要折叠、紧凑单行标题、状态提示和手动展开保持。实际 Windows 界面、测试结果、截图与人工验收步骤见 [工具活动区验收](desktop-tool-activity.md)。

## 2026-11-10 会话侧栏与全局设置

右栏只展示当前会话信息，全局环境、安装指南、WSL 选择和托管 Worktree 管理移到左上角设置。左栏常驻并可拖动调宽。实现文件、实测证据及人工验收见 [专项记录](desktop-phase-4-conversation-layout.md)。

## 右边栏 UI 重构补充

2026-11-10 按用户要求重构 Desktop 右侧会话面板，详情、工作区、交接与管理分组展示，整理 Changes / Diff / Debug 导航与文件列表。实现、截图、自动验证、首次全量 PTY 超时及独立重跑结果见 [右边栏补充验收](desktop-phase-4-right-panel.md)。Windows 完整鼠标 / 窄窗序列仍待人工验收，不改变原生审批及运行行为。
