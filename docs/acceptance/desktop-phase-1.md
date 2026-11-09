# Desktop Phase 1 验收记录

日期：2026-11-08（America/Los_Angeles；机器 UTC 为 2026-11-09）。范围：Windows x64 Electron + React + WSL2 Bridge、只读会话工作界面。未进入 Desktop Phase 2。

## 交付结论

已实现 Windows 原生窗口、受控 WSL2 Bootstrap、现有 Daemon HTTP/WS 连接、真实 Project/Conversation 树及只读消息历史。原 TUI/Daemon/ACP/Handoff/Worktree 全量自动化回归通过。Windows 实机使用隔离 HOME/XDG 与 Mock ACP 验证，不能据此声称真实 Codex/Claude/Grok/OpenCode 本轮均已验证。

产品新增方向由用户明确授权，历史 MVP“不支持 Windows 原生客户端”的设计保留并追加适用范围。详见 [D1 架构决策](../03_DESKTOP_ARCHITECTURE.md)，启动/打包/排障见 [Desktop 指南](../DESKTOP.md)。

## 架构、API 与进程边界

`Windows Electron Main → wsl.exe → Linux installed Bridge → existing ensureDaemon → Node Hono/SQLite/ACP`。Renderer 经 sandbox preload 的固定 IPC 与 Main 通信；同一 WSL Daemon 同时为 TUI 和 Desktop 服务。

复用 `GET /v1/health`、`/v1/snapshot`、`/v1/preferences`、`/v1/conversations/:id/events?after_seq&limit`、`WS /v1/ws`。唯一业务写入是保存 lastConversationId 的 `PATCH /v1/preferences`。未新增后端业务路由、数据库、迁移、ACP Runtime 或任务状态机。

Main 保留 Token，校验 product/runtime、instanceId、PID、version、protocolVersion 和 WS hello。Renderer 不获得 instance/port/token、任意请求/路径/child_process/文件系统能力。IPC 验证 exact webContents + mainFrame + packaged URL，strict union 参数校验；无 Prompt、approval、session、cancel 或 stop 操作入口。

WS 先订阅再读取 SQLite，以连续 seq 分页补拉、去重；连接 epoch 和选择序列隔离过期请求，偏好写入与历史读取各自串行。每次掉线丢弃旧 Client/Token，再从 WSL 发现实例。窗口退出 dispose UI 连接，不停止后台。

Daemon 仍仅 127.0.0.1 动态端口，保留 Bearer 与 Origin 拒绝，无 CORS/0.0.0.0 绕过。Linux Workspace 原样使用；无 Windows cwd 转换或 Explorer 文件操作。

## WSL Bootstrap 与安装

- Windows `execFile` 调用绝对 System32/wsl.exe，参数数组、不拼用户 shell 命令，30 秒超时/1 MiB 输出上限，处理 UTF-16LE/BOM/UTF-8 和非零退出。
- `--list --verbose` 检测/列出发行版，仅已发现的 WSL2 可执行。首次用户选择，Windows 设置文件只保存名称。
- 固定 `/bin/sh` 脚本使用发行版默认 Linux 用户 HOME 找到 `.local/lib/harnesshub/desktop-bridge`；`--cd ~`，不依赖 shell dotfiles 或 Windows HOME/PATH。
- `install:local` 沿用 flock/安全升级/不可变 release，额外安装 0700 launcher，记录绝对 Linux Bun、安装时 PATH、解析后的 XDG。不存在或不兼容则返回固定错误和处理说明。
- `hhu desktop-bridge <version> <protocol>` 先匹配版本，再复用 ensureDaemon/health。已有实例不重启，不兼容实例不停止、不替换。成功 stdout 为仅 Main 使用的含 Token JSON，不用于日志。

## UI 架构与设计规范

`App → 顶栏/WSL 选择 → Project 分组/ConversationItem → transcript + disabled composer → Details/Debug`。数据层为 Main `DesktopConnection`，IPC contract 独立于 React；消息投影复用从 TUI 提取的 shared 纯事件分类。UI 状态与业务执行分开。

深色内容优先布局：左栏默认 260px，可隐藏、拖动至 220–420px、键盘微调；中间聊天占主要空间；右侧默认关闭，宽屏三栏、窄屏浮层。使用统一 CSS 色彩变量、系统字体、低对比度背景、克制选中态，无后台管理卡片堆叠。

用户补充的 HarnessHub Logo 已接入：用户最终指定的黑色透明原图保存在 assets，裁掉留白，保留原始 Alpha/线条并改为纯白；生成透明 PNG 与深灰底多尺寸 Windows ICO，完全移除彩色版。用于顶栏、空态、窗口/任务栏、EXE 资源；没有采用其他产品 Logo 或 AI 重新绘制。

已实现：

- 真实 Project 分组、展开折叠、鼠标会话切换、选中高亮、独立滚动。
- 会话标题/Harness/运行/审批/错误等状态；即时搜索、归档列表。
- 最近会话由 SQLite 偏好恢复；选中会话只读取，不启动 Agent Turn。
- 用户/Agent 消息原文、连续文本 chunks 合并；Thinking/Plan、原生工具标题/状态的基本只读展示。
- Loading/Empty/Error/Disconnected/Incompatible 状态、手动重连、缩放/Resize。
- Details 显示 Linux Workspace；Debug 独立展开原始事件，聊天不显示 initialize/authStatus/worker PID JSON。
- contextIsolation、sandbox、nodeIntegration=false、严格 CSP、禁导航/新窗口/webview/下载/权限；HTML 和工具输出仅作为 React 文本。

明确未实现：新建/重命名/归档/恢复/删除管理动作（仅禁用入口）、正式输入/Enter 发送/Shift+Enter 换行、草稿、ACP Slash Commands/模型/推理交互、审批、Markdown 渲染/语法高亮、完整工具详情、Diff、Handoff 报告 UI、流式渲染优化。后端已有功能不等于 Desktop 已完成。

## 主要新增/修改文件

| 文件 | 内容 |
| --- | --- |
| `apps/desktop/package.json`, `tsconfig.json`, `bunfig.toml` | Bun workspace、React 独立 TS/测试变换，锁定 Electron 45.2.3、React 19.3.1、electron-builder 26.18.0 |
| `apps/desktop/src/main/{index,window,preload,security,settings,wsl,connection}.ts` | 生命周期、窗口安全、IPC、发行版设置、WSL 参数化启动、Main HTTP/WS 数据层 |
| `apps/desktop/src/contracts.ts` | 白名单请求/状态 DTO，无实例凭据 |
| `apps/desktop/src/renderer/{App,history,index,style}`、`index.html` | 三栏 UI、原文投影、主题、CSP |
| `apps/desktop/assets/*` | 用户原图、透明 Logo、512px 图标和多尺寸 ICO、素材说明 |
| `apps/cli/src/desktop-bridge.ts`, CLI index | 非交互私有 Bridge 子命令；原 TUI 语义保持 |
| `scripts/install-local.ts`, `scripts/desktop-bootstrap.ts` | 安装受控 Bridge，捕获 Linux 启动路径/XDG |
| `packages/shared/src/client.ts`, `event-projection.ts`, shared exports, TUI transcript | 导出既有实例 schema；提取纯分类共享，保留 TUI exports |
| `scripts/desktop.ts`, `desktop-test.ts`, `verify-desktop-windows.ts` | 分离构建/Windows x64 目录包、测试、隔离真实 Windows 实验 |
| `apps/desktop/tests/*`, `tests/integration/desktop.test.mjs` | WSL/安全/原文投影、真实 SQLite/WS/Mock ACP 和 Windows UI 验证 |
| 根 package/tsconfig/lock、AGENTS、README、架构/实施文档 | Monorepo 接入、范围追加与入口说明 |

## 自动化结果与证据

| 命令 | 结果 |
| --- | --- |
| `bun install --ignore-scripts` | 完成新 workspace 依赖解析、更新单 bun.lock；未执行 Linux/Windows 原生安装脚本混用 |
| `bun run typecheck` | 通过根工程、Node Daemon 和 React Desktop 独立检查 |
| `bun run lint` | 通过 Biome recommended，无关闭规则规避 |
| `bun run build` | 通过 Linux CLI/Daemon/共享库构建（Desktop 测试与回归均执行） |
| `bun run desktop:build` | 通过 Main/Preload CJS、React browser bundle；app.getAppPath 定位资源 |
| `bun run desktop:test` | **15 项单元/渲染测试 + 8 项 Node 真实集成测试通过** |
| `umask 022; bun run test` | **101 项 Node 集成测试 + 100 项 TUI/UI 测试通过**，1439 UI 断言，零失败 |
| `bun run desktop:package` | Windows x64 目录包通过；asar 检查不含 node_modules、SQLite、OpenTUI、.node；包含自有图标 |
| `bun scripts/verify-desktop-windows.ts` | Windows Electron 45.2.3 / x64 + 当前 Ubuntu-26.04 WSL2 的隔离真实窗口/连接测试，详细 evidence 见下 |
| `git diff --check` | 通过 |

打包最初 GitHub Releases 返回 HTTP 504；使用 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 完成下载，并独立核对 npm Electron `checksums.json`。Windows ZIP SHA256 为 `489cd061908e697394b004298bf5ffd345c935d10e8ca197ba819f019ab2dec0`。未跳过哈希验证。

测试发现并修正：Bun bundle 内嵌 __dirname Linux 源码路径；electron-builder 在 monorepo 向上收集后端 native 依赖；快速选择/连接的过期响应；分隔条命中区域。Windows 拖动自动化需保留 leftbuttondown，不能把无按键 mouseMove 误当真实拖动。

覆盖映射：

1. WSL2/WSL1、本地化列表、UTF-16LE/BOM、未安装 WSL/Bridge、未知发行版与注入字符串：单元测试。
2. absent Daemon 自动启动、并发/已运行复用；客户端和活 Daemon 不兼容不停止/替换：真实 CLI/HTTP 集成。
3. 动态端口、实例/版本/协议、伪造身份拒绝；Token 不在 Renderer/设置/URL：单元、真实集成和 Windows sandbox 检查。
4. 重启自动重新发现凭据、按 seq 补拉/去重、不重复 user.message；快速选会话不混历史：真实集成。
5. Desktop 与 TUI 的同一 watchSnapshot/watchConversation 客户端同时观察真实 SQLite 历史，逐事件核对；原 TUI PTY 回归另通过。
6. Desktop dispose/真实 Windows 关闭时 Daemon 和活动 Mock Worker 保活；再次打开恢复发行版与会话：集成及 Windows 实机。
7. Linux cwd 精确匹配、非交互 HOME/PATH/XDG、空格/单引号路径、无 Windows 路径转换：shell 单元及真实会话/Windows连接。
8. 原 ACP 故障/权限/取消/WS/Handoff 去重/Worktree/恢复：原完整回归全部通过。

Windows 最终实测 `passed=true`，证据目录 `hhu-desktop-smoke-YUdQcv`；包含纯白 Logo 的宽/窄屏截图。过滤安装在无 node_modules 的隔离 checkout 中构建通过，核查不包含 ACP Harness、OpenTUI、better-sqlite3。打包后的真实 HarnessHub.exe 另验证窗口标题及正常关闭，见 packaged-evidence.json。

本目录的 [evidence/desktop-phase-1](evidence/desktop-phase-1) 保存执行日志、Windows evidence 和截图。临时实验数据库保留在日志记录的 `/tmp/hhu-*` 路径；Token 实例文件未复制到仓库。

## Windows 实机启动与用户待验收

1. 按 [Desktop 指南](../DESKTOP.md) 在 WSL 安全安装同版 hhu 和 Bridge。此轮没有替换用户默认全局安装或停止用户默认 Daemon。
2. Windows PowerShell 在独立 checkout 执行 `bun install --filter '@harnesshub/desktop' --filter '!harnesshub' --frozen-lockfile --ignore-scripts`，`node apps/desktop/node_modules/electron/install.js`，`bun run desktop:dev`。也可直接运行构建目录中的 `HarnessHub.exe`（保留全部旁文件）。
3. 显式选择自己的 WSL2 发行版，连接；在另一 WSL 终端运行 TUI，核对同一项目/会话/历史。
4. 项目展开折叠、搜索、切换、侧栏拖动隐藏、Details/Debug、缩放/窄屏；确认 HTML 原文不执行、内部 JSON 不混进聊天。
5. TUI 运行一个无害任务时关闭 Desktop，确认后台执行继续；重新打开恢复发行版/会话/消息。不要为了验证而终止真实重要任务。
6. 用专门测试库安全重启 Daemon，确认重新鉴权补拉；不兼容时仅显示说明，不停止任务。

## 限制与未验证

- Desktop Phase 1 为只读消息预览和管理入口骨架，不能宣称完整聊天/流式/权限/Handoff GUI 已完成。
- Windows 真机测试采用 Electron 注入的鼠标事件、实际 HWND/Chromium、真实 wsl.exe/localhost/SQLite 与 Mock ACP；物理鼠标/键盘、所有多显示器 DPI（125%/150%）、无 WSL/WSL1 真实安装机器、VPN/企业防火墙和不同网络模式均**未验证**。上述错误分支有 Mock/单元覆盖。
- 本轮未调用真实 Codex/Claude/Grok/OpenCode 模型；原验收中的真实 Harness 限制仍有效。TUI 与 Desktop 同时查看由真实共享客户端集成覆盖，用户实际日常库上的双窗口人工对照仍待验收。
- Windows 冷开发环境从零安装 Node/Bun/checkout 的全过程未在另一台干净机器复跑；当前实机运行使用 WSL 交叉构建的同一 Electron 资源和 Windows 二进制。
- 长历史在 Main/Renderer 内存中保留全部已读事件并传状态快照；没有虚拟化或大历史性能承诺。源事件仍留 SQLite，不被删减。
- 自定义 XDG/PATH 绑定安装时环境；移动 Node/Bun/源码后需安全重新安装 Bridge。一次连接故障不会读取原生 Agent 配置来“修复”。
- Windows 包为未签名 x64 目录包，非安装器；无自动更新、发布上传或远程服务。WSL shutdown / Windows reboot 不保证后台继续运行。

执行期间检测到非本任务的并行修改 `apps/tui/src/agent-pane.tsx`、`apps/tui/src/index.tsx` 及相关 `tests/e2e/*`，已保留。101/100 全量回归结果对应此前测试时的源码快照；最终 typecheck/lint 通过，不以该旧全量结果替并行 TUI UI 改动背书。本任务后续仅修改 Desktop/品牌/构建/文档，没有覆盖并行改动。

等待用户对 Desktop Phase 1 验收，不自动开始 Phase 2。
