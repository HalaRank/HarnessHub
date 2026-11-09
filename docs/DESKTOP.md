# HarnessHub Windows Desktop

支持 Windows x64 + WSL2。Desktop 是原生 Electron 窗口；Agent、Harness 安装和 SQLite 都在 WSL 中。Desktop Phase 2 已接入正式聊天、草稿、原生审批/取消、模型/命令和会话管理；完整 Changes/Diff 与 Handoff 工作面板留给 Phase 3。

## 在 WSL 中准备一次

使用已有 Linux checkout、Bun 1.4.4 与 Node 24.18+ (<25)：

```bash
bun install --frozen-lockfile
bun run typecheck
bun run build
# 若已有 Daemon，先等待任务结束，再用匹配版本正常停止。
hhu daemon stop
bun run install:local
```

已有 Daemon 正在执行任务时不要强制停止/升级。安装器会拒绝活跃或持有锁的 Daemon；等任务完成再继续。未安装过 hhu 时直接 `bun run install:local`。

安装器保留 `~/.local/bin/hhu`，并额外安装 `~/.local/lib/harnesshub/desktop-bridge`，绑定这次安装的 Linux Bun、PATH、XDG 与不可变 release。以后 Windows App 自动通过它连接或启动 Daemon，无需每次开终端输入 hhu。若移动源码、Bun/Node 安装或改变 XDG，请按相同安全流程重新安装。不会加载登录 shell，也不会复制原生 Agent 配置。

**不要在终端分享 `hhu desktop-bridge` 的 stdout**：成功响应包含本机 Daemon Token，只供 Windows Main 读取；故障诊断用 `hhu doctor` / `hhu daemon logs`。

## Windows 开发启动

在 Windows 本地目录（例如 `C:\src\HarnessHub`）另建同一版本 checkout，不与 WSL 共用 node_modules。安装 Windows x64 Node 与 Bun（当前 lockfile 对应 Bun 1.4.4）。PowerShell：

```powershell
cd C:\src\HarnessHub
bun install --filter '@harnesshub/desktop' --filter '!harnesshub' --frozen-lockfile --ignore-scripts
# 只安装 Electron 的 Windows 二进制；不在 Windows 编译 SQLite 或安装 Linux Harness。
node apps/desktop/node_modules/electron/install.js
bun run desktop:dev
```

`desktop:dev` 构建并启动本地文件应用，无网络开发服务器；修改后关闭窗口重新运行。`bun run build` / `bun run install:local` 属于 Linux 后端，不在 Windows 执行。过滤安装只安装 Desktop 及 shared 依赖，显式排除根 workspace；实测不含 ACP Harness、OpenTUI 或 better-sqlite3。不要省略过滤参数在 Windows 安装整个后端。

第一次选择 WSL2 发行版并点击“连接”。后续自动恢复该发行版，以及 SQLite 中最近选择的会话。若列表包含 docker-desktop，应选择安装了 HarnessHub 的日常开发发行版；不会自动挑第一个发行版。WSL1 不可选。

## Windows x64 目录包

```powershell
bun run desktop:package
.\dist\desktop\windows\win-unpacked\HarnessHub.exe
```

需要保留整个 `win-unpacked` 目录。当前不提供签名安装器、自动更新或发行上传。Linux/WSL 也可以交叉构建同一 Windows x64 目录包，但必须在 Windows 执行 exe。构建脚本检查 asar 只包含 Main/Preload/Renderer，无 native Linux 模块。

依赖下载需要访问 Electron GitHub Releases。若所在网络不能访问，可按 Electron 官方下载器的镜像配置设置 `ELECTRON_MIRROR`；不要跳过校验。此次实际构建曾因 GitHub 504 使用 npmmirror，并用 npm Electron 包自带 checksums.json 独立核验 Windows ZIP SHA256。该环境变量不是应用运行所需配置。

## 使用与故障处理

- 左栏鼠标选择 Project/Conversation；项目可折叠、搜索、查看归档；侧栏边缘可拖动或聚焦后用左右键调整。
- 顶部显示连接状态，支持重新连接。右上按钮打开 Details / Debug；Changes 入口尚未实现。
- 中间安全渲染原生 Markdown 与工具卡；底部输入框可发送消息，Enter 发送、Shift+Enter 换行。
- 菜单 View 支持放大、缩小、重置；默认右栏收起，窄窗打开右栏时为浮层。
- 等待审批时在 Desktop 或 TUI 主动选择真实 Agent 选项；后台只接受一次决定，没有自动审批或未知请求自动重发。
- 关闭 App 只断开 UI，Daemon 与 Worker 继续运行。关闭整个 WSL/重启 Windows 则不保证后台存活。

| 状态 | 处理 |
| --- | --- |
| 未找到 WSL / 发行版 | PowerShell 检查 `wsl --status`、`wsl --list --verbose`；安装并启动 WSL2 |
| 未安装 Bridge | 在所选发行版中按上面的安全安装步骤更新 HarnessHub |
| 版本不兼容 | 完成后台任务后，用匹配版本正常停止并更新 WSL 安装；Desktop 与 Daemon 版本须一致 |
| WSL 启动失败 | 所选发行版运行 `hhu doctor`、`hhu daemon logs`；检查安装时 PATH 对应的 Node/Bun 仍存在 |
| 持续断开 / 端口不对应 | 检查 WSL localhost forwarding / mirrored mode、VPN、防火墙和本机端口冲突；不改 0.0.0.0、不开放未鉴权端口 |
| 选中的发行版被移除/降级 WSL1 | 刷新列表，显式重新选择 WSL2；不会自动切到别的数据库 |

Linux Workspace 如 `/home/clj/project` 原样显示，不会转换成 C 盘并交给 Agent。本阶段没有 Explorer/文件写入入口。

## 自动化与手动验证

WSL 中：

```bash
bun run typecheck
bun run lint
bun run desktop:test
bun run test
bun run desktop:package
# 可选：当前机器有 Windows interop 时，运行隔离真实 Windows Electron/WSL UI 验证。
bun scripts/verify-desktop-windows.ts
```

最后一条创建临时 WSL HOME/XDG 与 Windows userData，使用 Mock ACP，不访问默认项目库，不终止用户已有 Daemon。保存 screenshot/evidence，最后正常关闭其测试 Daemon。

手动验收请使用同一 WSL Daemon 同时打开 Desktop 和 TUI：创建/归档/重命名测试会话，检查 Desktop 列表变化；TUI 发送无害消息，检查 Desktop 历史；在 TUI 保持运行任务时关闭再打开 Desktop，检查任务与历史；安全停止并重启空闲测试 Daemon，确认重新发现端口/Token 后补拉无重复；检查 100%/125%/150% DPI、中文、拖动侧栏、窄屏、缩放及 Markdown 原文。具体已测/未测边界见验收记录。


## Desktop Phase 2 聊天

连接 WSL 后，点击项目或“独立会话”旁的 `＋` 新建；独立会话显式填写现有 Linux 绝对目录。Details → 会话管理支持重命名、归档/恢复和确认删除；删除不删除源码、分支、Worktree。已注册自定义 ACP Profile 与四个内置 Harness 共用同一下拉列表；注册 Profile 仍使用既有 WSL TUI/CLI 能力。

输入 Enter 发送、Shift+Enter 换行，Ctrl+C/V/A/Z/Y 使用 Windows 编辑行为。输入法组合确认不发送。草稿实时 CAS 保存；切换/正常关闭等待保存，冲突保留本地文字，可复制后显式载入服务器草稿。断网/提交结果未知时先点“查询请求状态”，不能重复发送未确认请求。UNCERTAIN 需检查历史与工作区，不能把它当作安全取消。

需要提前查看模型和 Slash Commands 时点击“连接 Agent 获取选项”；不调用模型。只有 ACP 实际发布的选项和命令可用，`/` 候选支持方向键、鼠标、Tab/Enter 补全，补全后再次发送才执行。选择其他 Harness 只保存目标，首条消息才触发交接；失败提供报告/降级材料和原有显式操作。

工具成功默认折叠，运行/失败/审批默认展开，手动选择优先；展开可看完整原生参数、输出和工具 Diff 并复制。链接作为文本展示，远程图片和 HTML 不执行。历史每页挂载 100 条，使用“查看较早/较新消息”和“回到最新消息”；滚动阅读时暂停自动跟随。

专项验证：`bun run desktop:test`；Windows + WSL Mock/真实 TUI：`bun scripts/verify-desktop-windows.ts`；明确执行真实 Codex/Grok：`HHU_DESKTOP_REAL=1 bun scripts/verify-desktop-windows.ts`。真实验证使用临时应用数据库与项目，继承原生 Harness 的 HOME/PATH，不读取/修改原生配置。遇真实审批不自动选择，记录并取消测试任务。证据和未验证项见 [Phase 2 验收](acceptance/desktop-phase-2.md)。
