# HarnessHub Windows Desktop

Windows x64 Electron + React 客户端，连接用户选择的 WSL2 Linux 环境。Agent、Git、Worktree、Handoff、SQLite 全部在 WSL。Desktop Phase 1–3 已完成聊天、草稿、原生审批/取消、Changes/Diff、Handoff、Worktree、Explorer 定位；Phase 4 增加 unsigned NSIS 安装器、Portable ZIP、发布校验和安全升级说明。未提供自动更新或云服务。实际验收边界见 `acceptance/desktop-phase-4.md`。

## 首次安装（Windows 用户）

1. 从下节 [GitHub Releases](https://github.com/HalaRank/HarnessHub/releases) 获取同版本的 `HarnessHub-0.6.2-windows-x64-unsigned-setup.exe` 或 `HarnessHub-0.6.2-windows-x64-unsigned.zip`，以及 `windows-x64-SHA256SUMS.txt`。本地/Actions 构建目录中的校验文件仍名为 `SHA256SUMS.txt`。当前是 **unsigned 测试包**。
2. 校验 SHA256 后运行安装器。默认当前用户安装，可选择安装目录，创建开始菜单/桌面快捷方式及 Windows“已安装的应用”卸载入口。不需要管理员权限；Windows App 安装不安装 WSL、Bun、Node 或原生 Harness。
3. ZIP 用户将**整个目录**解压到独立目录，运行 `HarnessHub.exe`，不能只复制 exe。ZIP 不创建卸载项；关闭客户端后可手动移除该 ZIP 解压目录。不要把项目或数据存入安装目录。
4. 双击 HarnessHub，应用自动检查 WSL 并显示发行版。第一次需显式选择 WSL2 开发发行版（不要选 docker-desktop）；WSL1 不可选。以后恢复所选发行版；连接成功进入 Project → Conversation 界面。
5. WSL 未安装时，PowerShell 检查 `wsl --status`、`wsl --list --verbose`，按 Microsoft 官方指南自行安装 WSL2/发行版：https://learn.microsoft.com/windows/wsl/install 。应用不会静默运行 `wsl --install`、修改系统设置或下载软件。
6. Bridge 缺失时，在**所选发行版默认 Linux 用户**下按下一节准备一次。已有 Codex、Claude、Grok、OpenCode 无需重新安装或重新配置凭据。HarnessHub 不复制其 Key、模型配置或登录状态。

**SmartScreen**：unsigned 包可能触发未知发布者/下载信誉提示，企业策略也可能阻止执行。SHA256 只验证内容一致，不能证明发布者身份；不建议关闭 SmartScreen 或绕过企业策略。需要可信签名分发时，本候选包不满足条件，应等待获准签名的版本。

## 从 GitHub 下载

打开 [HarnessHub Releases](https://github.com/HalaRank/HarnessHub/releases)，选择版本并展开 **Assets**：

| 文件 | 用途 |
| --- | --- |
| `HarnessHub-<版本>-windows-x64-unsigned-setup.exe` | Windows 安装器，下载安装 |
| `HarnessHub-<版本>-windows-x64-unsigned.zip` | 免安装目录包，完整解压后运行 `HarnessHub.exe` |
| `windows-x64-SHA256SUMS.txt` | Windows 两个包的 SHA256 |
| `windows-x64-release-manifest.json` | Windows 版本、协议、签名状态及产物清单 |
| `install.sh`、`harnesshub-<版本>-linux-x64.tar.gz`、`SHA256SUMS.txt` | 在所选 WSL2 发行版中安装同版本后端 |

维护者发布后，0.6.2 的 [安装器直链](https://github.com/HalaRank/HarnessHub/releases/download/v0.6.2/HarnessHub-0.6.2-windows-x64-unsigned-setup.exe) 和 [ZIP 直链](https://github.com/HalaRank/HarnessHub/releases/download/v0.6.2/HarnessHub-0.6.2-windows-x64-unsigned.zip) 才生效。draft Release 仅维护者可见，Actions artifact 是临时构建下载；配置好工作流不代表已经公开发布。

例如将安装器和 `windows-x64-SHA256SUMS.txt` 下载至同一个目录，在 PowerShell 进入该目录后校验并启动：

```powershell
$file = 'HarnessHub-0.6.2-windows-x64-unsigned-setup.exe'
$line = @(Get-Content .\windows-x64-SHA256SUMS.txt | Where-Object { $_.EndsWith("  $file") })
if ($line.Count -ne 1) { throw 'Missing or ambiguous installer checksum' }
$expected = ($line[0] -split '\s+')[0]
if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ine $expected) { throw 'Checksum mismatch' }
Start-Process -FilePath ".\$file" -Wait
```

首次使用还需准备下节 WSL 后端。Windows 包和 Linux 包从**同一个 Release**下载；安装器不会自动安装 WSL 或修改原生 Harness 配置。

## WSL 后端准备

推荐使用同一个 GitHub Release 的 Linux 独立包，无需源码、系统 Node/Bun。先准备 WSL2 x64/glibc、Git、flock 等系统工具（完整要求见 [发行安装指南](DISTRIBUTION.md)）。在**所选发行版默认 Linux 用户**中，进入已下载 `install.sh`、Linux tar.gz、`SHA256SUMS.txt` 的目录，以 0.6.2 为例：

```bash
sh ./install.sh --archive ./harnesshub-0.6.2-linux-x64.tar.gz
export PATH="$HOME/.local/bin:$PATH"
hhu doctor
```

也可按 [发行安装指南](DISTRIBUTION.md#从-github-安装) 在线安装；Windows 客户端必须与所选后端版本一致。安装器不修改 Shell 配置，后续终端是否包含 `~/.local/bin` 由用户管理。Windows 通过 `~/.local/lib/harnesshub/desktop-bridge` 自动连接/冷启动，不必每次先启动 TUI。安装后的独立包不依赖源码或下载目录。

开发者仍可使用可信、与 Windows 版本完全相同的 Linux checkout，安装 Bun **1.4.4**、Node **24.18+ 且 <25**、Git、flock 后执行：

```bash
cd /path/to/HarnessHub
bun install --frozen-lockfile
bun run typecheck
bun run install:local
```

如果已有 Daemon，先按安全升级流程处理；不要强行停止正在工作的 Agent。将 `~/.local/bin` 加入自己的 PATH（安装器不改 shell 配置）。Windows 通过 `~/.local/lib/harnesshub/desktop-bridge` 自动连接/冷启动，不必每次先启动 TUI。

源码安装的 Bridge 固定安装时的 Linux Bun、PATH、XDG，指向完整不可变 release；此方式须保留 checkout 和 node_modules。移动源码、Node/Bun 或更改 XDG 后要重新安全安装。安装操作仅创建 HarnessHub launcher，不修改原生 Harness 配置。不要分享 `hhu desktop-bridge` stdout，其中含 Main 专用 Token；排障用 `hhu doctor` / `hhu daemon logs`。

## Windows 安装位置、用户数据、升级和卸载

- NSIS 默认当前用户安装于 `%LOCALAPPDATA%\Programs\HarnessHub`（安装向导可改变）。应用资源与数据分离。
- Windows `%APPDATA%\HarnessHub` 保存发行版选择 `desktop-settings.json` 和 Electron 客户端缓存，不含 HarnessHub SQLite/Token/完整业务历史。ZIP 与安装器使用相同应用名称和默认设置路径；需要独立客户端配置时，可显式运行 `HarnessHub.exe --client-data-dir=C:\absolute\client-config`。该参数不改变 WSL 数据目录。
- WSL 默认库为 `~/.local/share/harnesshub/harnesshub.db`，状态/日志为 `~/.local/state/harnesshub`，配置为 `~/.config/harnesshub`；自定义 XDG 以安装时实际值为准。
- 升级 Windows 前正常关闭客户端以保存草稿，然后运行新安装器。不需要关闭后台 WSL Daemon/Worker。Windows 版本升级后**不表示** WSL 已升级；版本不匹配时禁止发送 Prompt，按下节处理。
- 从旧目录包迁移：正常关闭旧客户端，保留旧目录作回退；安装 NSIS 到独立目录，启动开始菜单中的 HarnessHub。原发行版选择/WSL Conversation 自动复用。不要在旧目录包中叠加安装；两份客户端不能同时争用相同 Windows userData。
- 普通卸载只移除 Windows 应用文件和快捷方式，**保留 Windows 客户端设置及全部 WSL 数据**，不运行 wsl、stop、cancel，不删除发行版/SQLite/源码/Worktree/原生凭据。重新安装后可继续选择原发行版及已有 Conversation。
- 若确需清理 Windows 客户端配置，关闭 App 后由用户单独确认并备份 `%APPDATA%\HarnessHub`，再自行移除；不绑定普通卸载。完整 WSL 清理是独立高级操作，必须确认任务已结束、备份并逐项检查真实 XDG/Worktree/源码路径，本阶段不提供一键销毁入口。

## Windows / WSL 兼容矩阵

| Desktop | Linux Bridge | Daemon | 协议 | 行为 |
| --- | --- | --- | --- | --- |
| 0.6.2 | 0.6.2 | 0.6.2 | 全部 1 | 支持连接；Phase 4 readiness 可用性还取决于后端构建 |
| 0.6.2 | 其他版本 | 任意 | 任意 | 拒绝连接/Prompt，不停止后台 |
| 0.6.2 | 0.6.2 | 其他版本 | 1 | 拒绝；只读报告身份和可用的升级预检 |
| 0.6.2 | 任意 | 任意 | 不同 | 拒绝；不能假设旧后端支持新检查 |
| 任意 | 未安装/旧 Bridge 无诊断字段 | 未确认 | 未确认 | 显示未知，不能把未知视为空闲 |

Details/启动指引显示 Desktop/Bridge/Daemon/协议、instanceId、发行版和连接状态。断线后的历史身份仅是最近核验；重连重新发现实例，不复用旧 Token。当前策略为**精确版本相等**，不自动假定同一协议的不同版本兼容。本阶段从 0.6.1 统一升至 0.6.2；Windows 0.6.2 与旧 0.6.1 后端拒绝连接。未来发布 bump 必须同时构建客户端与后端。

## WSL 安全升级与恢复

Windows 不自动下载 Linux 依赖或停止 Agent。手动流程：

使用 GitHub 独立包时，先执行步骤 2–3 的安全检查与停止，再按 [发行安装指南](DISTRIBUTION.md#升级与恢复) 安装同版本后端；安装器会保留旧 release 和入口备份。以下 checkout 路径及 `install:local` 步骤适用于源码安装。

1. 保留当前完整 checkout/node_modules/release。准备可信目标版本独立 checkout；不要原地覆盖旧 release。正常关闭 TUI/Desktop 或避免其他客户端提交新任务，完成 Turn、人工审批和 Handoff；UNCERTAIN 必须先检查真实文件和执行结果。
2. 用**当前运行版本**的 `hhu daemon upgrade-check` 只读检查活动 Turn、审批、未解决 Handoff、输入投递、Session/Git/删除操作。未知/不可达/不支持时不得假定安全；旧版需在匹配 TUI 核对所有会话和任务。
3. 检查通过后显式 `hhu daemon stop --for-upgrade`，不带 `--cancel-active`。`--for-upgrade` 在停止前同步重查并预留关闭状态，避免预检与另一个客户端提交之间的竞争。遇拒绝就等待；不按 PID kill、不删锁文件、不重发 Prompt。升级检查“安全”也不保证原生 Session 跨 Daemon 重启恢复。
4. 在目标 checkout 执行 `bun install --frozen-lockfile` 和 `bun run install:local`。安装即使无法访问健康端点，也用同一 `flock` 防止覆盖启动中/无响应后台；构建失败不替换旧 launcher。完整 staging 后原子替换 launcher，旧 release 保留。
5. 正常启动 `hhu daemon start` / Windows“重新连接”，运行 `hhu doctor` 检查真实版本/迁移结果。SQLite 升级前自动生成私有 `harnesshub.db.backup-*`，SQL 迁移失败全部回滚并启动失败，不作为成功连接。新 schema 不允许旧程序直接打开。
6. 失败回退：先确认没有运行中的 Daemon、Worker 或锁持有者。查看本次安装输出的 `dist/releases/<id>/previous-launchers`，其中保存了上次 `hhu` 与 `desktop-bridge` 的精确内容。在**同一 Daemon flock 锁**内将两份保存的 launcher 复制到各目标旁的临时文件，核验其旧 release 存在/依赖完整，再分别 rename 原子替换。不要直接使用未核验的旧 PID 或删除 lock。首次安装没有上次 launcher。
7. 迁移失败通常无需还原数据库：旧库及备份均保留，先检查日志。若 schema 已成功升级而要降级，必须在停止且持锁状态下，先把当前 DB/WAL/SHM **完整移到新的保留目录**，再从已核验的迁移前备份复制恢复，权限 0600；不要覆盖唯一原件或只替换 DB 而留下旧 WAL。备份后的新数据不会自动并入旧 schema，须人工决定。建议先在隔离 XDG 副本验证恢复。Windows 卸载不触发此流程。

两个 launcher 的替换不是跨文件事务：第二次 rename 失败会尽力原子恢复旧 Bridge；断电可能出现两者版本不一致，连接会拒绝而非重发。旧 launcher 对和完整 release 提供人工恢复依据。此阶段不实现静默更新/自动回滚数据库。

## 日常使用与排障

左侧 Project/Conversation 树；中间聊天，Enter 发送、Shift+Enter 换行；中文 IME 确认不发送，Ctrl+C/V/A/Z/Y 使用 Windows 原生编辑。侧栏/右工作面板可拖动，窄窗面板为浮层。View 菜单支持缩放/全屏。实际多屏 DPI 和物理 IME 的人工验收见阶段报告。

Changes/Diff 显示 WSL Git 真实 staged/unstaged/untracked 变更；工具原生 Diff 单独保真呈现，Git 不推断 Agent 修改归属。Explorer 定位只做受控 WSL UNC 转换，ACP cwd 始终是 Conversation 绑定的 Linux Workspace。

Worktree 可创建、切换、查看和显式清理；安全清理将目录保留至 retained，不删除源码/分支。Handoff 只有目标首条消息才生成源报告/新 NativeSession；失败可展开材料，降级必须人工确认，UNCERTAIN 不自动重发。草稿 CAS 冲突和提交 ACK 丢失时保留本地内容，只查询原 requestId。

| 情况 | 处理 |
| --- | --- |
| Bridge 不存在 | 确认所选发行版默认用户，然后按 WSL 准备步骤安装 |
| 版本不匹配 | 查看环境信息与安全升级步骤；不自动重复发送 |
| 启动/迁移失败 | `hhu doctor`、`hhu daemon logs`；检查 Node/Bun/PATH、锁、schema；保留备份 |
| 持续断开/身份冲突 | 检查 WSL localhost forwarding、VPN/防火墙和端口冲突；不改 0.0.0.0/鉴权 |
| WSL 停止/Windows 重启 | 重新启动原发行版，App 重连；恢复 SQLite 历史，正在运行任务可能 INTERRUPTED/UNCERTAIN，不伪装继续 |
| App 异常退出 | 重新打开，恢复已 ACK 草稿/历史；最后未确认输入可能未持久化，提交状态未知时先查询 |
| 发行版移除/降为 WSL1 | 显式重新选择 WSL2，不自动切换到其他数据库 |

关闭 Windows App 不结束 WSL Daemon/Worker；Windows 重启或关闭整个 WSL 则不保证任务存活。请用隔离测试库验证恢复，不能通过关闭日常发行版破坏正在开发的任务。

## 构建、验证与分发

Windows 本地独立 checkout（不共用 WSL node_modules），PowerShell：

```powershell
bun install --filter '@harnesshub/desktop' --filter '!harnesshub' --frozen-lockfile --ignore-scripts
node apps/desktop/node_modules/electron/install.js
bun run desktop:dev
bun run desktop:release
```

产物目录 `dist/desktop/releases/0.6.2-unsigned/`：NSIS、ZIP、`SHA256SUMS.txt`、`release-manifest.json`。只在可信网络/源码上构建；WSL 交叉构建可能还需 Wine/NSIS 下载，官方构建工具链：https://www.electron.build/docs/nsis 。本脚本明确 `publish: never`，打包本身不上传。GitHub Release 由下述工作流单独处理；不使用签名密钥，本轮明确 unsigned。依赖下载失败时不跳过校验，Electron 镜像仅按官方下载器配置；不从未知来源安装依赖。

版本以根 package.json 为准，`bun scripts/version.ts <version>` 同步全部 workspace 与 shared VERSION，然后 `bun install --ignore-scripts` 更新 lockfile；`bun run version:check` 验证一致。Protocol 仍单独按契约管理。构建在仓库外新 staging，asar 白名单拒绝 Linux SQLite/OpenTUI/ACP Worker/node_modules/.node/链接/额外执行文件；Windows 自带 Electron DLL 属于运行时。包内不包含 Harness 登录配置或业务数据库。

PowerShell 校验：

```powershell
Get-FileHash .\HarnessHub-0.6.2-windows-x64-unsigned-setup.exe -Algorithm SHA256
Get-FileHash .\HarnessHub-0.6.2-windows-x64-unsigned.zip -Algorithm SHA256
Get-AuthenticodeSignature .\HarnessHub-0.6.2-windows-x64-unsigned-setup.exe | Select-Object Status
```

SHA256 应与 Release 的 `windows-x64-SHA256SUMS.txt`（本地构建为 `SHA256SUMS.txt`）一致；签名预期为 `NotSigned`。校验不等同安全审计或发布者认证。

Linux 全部检查：`bun run typecheck`、`bun run lint`、`bun run test`、`bun run desktop:test`。Windows UI/WSL/TUI 隔离验证：`bun scripts/verify-desktop-windows.ts`；真实模型使用显式环境开关（见脚本），不自动审批。安装器验收脚本在未安装 HarnessHub 的 Windows 测试账户中运行，遇已有注册/快捷方式即拒绝；不要在用户日常库或项目做破坏性验证。

`.github/workflows/desktop-windows.yml` 可手动构建，也供统一发布工作流调用；PR 继续执行 Windows 候选验证。`.github/workflows/linux-release.yml`（显示名 **HarnessHub release**）手动运行时保存两个平台的 artifact，推送与 package.json 一致的 `v<版本>` Tag 后，等待 Linux 构建/安装验收与 Windows 构建/安装器验收全部成功，校验两个平台资产后创建一个 **draft Release**。Windows 校验和 manifest 在上传前增加 `windows-x64-` 前缀，Linux 文件名保持下载脚本所需名称。维护者检查 draft 资产及验收限制后手动发布，无自动更新；远端执行与公开下载结果须单独验收。

Windows 安装专项（仅隔离测试账户/目录）可在 WSL 执行：

```bash
bun scripts/verify-desktop-release.ts /mnt/c/path/to/release /mnt/c/path/to/previous-release
```

第二个参数可省略，省略时仅验证同版重装；提供旧版时验证旧 NSIS → 新 NSIS。该测试创建临时 SQLite/Git/Worktree/Mock Agent，实际运行安装、异常退出、升级、卸载和重装；拒绝覆盖已有 HarnessHub 注册与快捷方式，正常清理测试安装，保留证据。不覆盖/安装日常 Bridge，不自动批准真实工具。
