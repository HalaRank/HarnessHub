# Desktop Phase 4 补充验收 — 会话侧栏与全局设置

日期：2026-11-10。

## 范围

依据用户要求，右侧工作面板仅呈现当前 Conversation 的内容：Workspace、模式、执行状态、会话管理、Handoff、Changes/Diff 和原始事件。全局环境诊断、版本、安装/升级指南、WSL 发行版选择与全部托管 Worktree 管理进入左上角齿轮“应用设置”。设置使用原生模态框，支持关闭按钮和 Escape；内层 Worktree 确认框取消不会连带关闭设置。未连接/版本不兼容时可通过聊天区帮助入口打开相同设置。

左栏取消隐藏功能，始终展示项目与会话。分隔条拓宽至 6px，使用水平缩放光标，按初始抓取位置计算宽度增量并捕获指针，支持 220–420px 拖动与左右方向键微调。右栏在窗口较窄时浮层展示，不再强制将左栏改为 220px。新建会话页或删除当前会话后不显示旧会话详情。

只调整 Desktop 视图；复用既有连接、草稿保存、Worktree 清理确认及后端协议。工作区有并行的会话创建、归档及 TUI 改动，本记录不替代其验收。

## 文件

- `apps/desktop/src/renderer/App.tsx`：常驻左栏、设置入口、指针增量拖动、右栏仅绑定实际查看的会话。
- `apps/desktop/src/renderer/AppSettings.tsx`：环境/安装指南与全局工作区管理模态窗口。
- `apps/desktop/src/renderer/Environment.tsx`：安装指南默认展开，指引改为设置内上方发行版选择。
- `apps/desktop/src/renderer/style.css`：设置布局、拖动光标与分隔条、窄窗口面板布局。
- `apps/desktop/tests/windows-smoke.ts`、`windows-workspace.ts`：更新入口、删除后面板消失、Worktree 管理路径及实际交互检查。
- `docs/03_DESKTOP_ARCHITECTURE.md`：记录用户修正，替代早期 Desktop 侧栏可隐藏和 Details 混入环境信息的说明。

## 自动验证

| 检查 | 结果 |
| --- | --- |
| `bun run typecheck` | 根/Daemon/Desktop 通过 |
| `bun run lint` | 通过 |
| `bun run desktop:test` | 后端与 Desktop 构建通过；61 单元测试、16 Node 集成测试通过 |
| `git diff --check` | 通过 |
| 隔离 Chromium + 实际打包 Renderer + Mock Desktop API | 3 组 DOM 断言通过，见 `evidence/desktop-conversation-layout/browser-interactions.json` |

浏览器检查覆盖右栏排除全局信息、切换会话后的正确 Workspace、新建页隐藏右栏、左上角设置/关闭、内层取消不关闭设置、未发送草稿保留、窄屏浮层保持左栏宽度、版本不兼容帮助入口。没有投递 Prompt、审批、Handoff 或执行 Worktree 清理。该检查通过 DOM 控件调用和模拟键盘/取消事件，不能冒充物理输入。

Linux Chromium 的常规 Playwright 点击等待渲染帧超时，故最终浏览器结果采用 DOM 交互，不提供该环境的渲染截图。真实鼠标输入和截图以 Windows 记录为准。

## Windows 实测记录

运行 `bun scripts/verify-desktop-windows.ts`，使用隔离客户端目录、隔离 WSL SQLite/项目与 Mock ACP。没有发送真实模型请求或操作日常数据库。

前期失败证据保留：第一轮旧测试在删除会话后继续查找“关闭工作面板”，按新需求改为验证面板已消失；第二轮发现既有测试重复声明全局 `const h`，改为局部函数作用域；第三轮发现工具分组展开早于最终 Diff 事件进入 Renderer，调整为有界轮询中展开后再检查实际工具标题。这些失败不能记为整体通过。

最终第四轮 `bun scripts/verify-desktop-windows.ts` **退出 0，`passed=true`**。Windows x64 / Electron 45.2.3 / Ubuntu-26.04 WSL2，现场 Windows `hhu-desktop-smoke-PIMLEA`，隔离 WSL `/tmp/hhu-windows-smoke-QBPTGQ`。24 组检查通过，覆盖设置入口、常驻左栏、Electron 实际鼠标拖动调宽、会话切换、真实 Git Changes/Diff、往返 Mock ACP Handoff、新入口内 Worktree 清理取消/确认、草稿保留、关闭重开保活，以及 Chromium 125/150/200% 缩放。全部后台为隔离 Mock ACP，不冒充真实模型验证。

结果与截图在 [evidence/desktop-conversation-layout](evidence/desktop-conversation-layout)：`windows-result.json`、`conversation.png`、`settings-worktrees.png`、`narrow.png`。已查看实际 Windows 截图，右栏只有会话详情/Handoff，左上角为齿轮入口；设置窗口承接全局 Worktree 管理。

## 待人工验收

1. 启动本轮构建的 Windows Desktop，左上角齿轮打开应用设置，检查环境选择、安装指南与工作区管理；关闭或按 Escape 后保持当前会话及输入。
2. 查看任意会话的 Details、Changes、Diff、Debug，确认右栏仅显示该会话内容；切换会话、进入新建页及删除当前会话，检查不会展示旧详情。
3. 拖动左栏右边缘，确认光标、宽度变化与释放手感；窗口收窄和重新放大后左栏不被强制折叠或重设宽度。
4. 物理鼠标/触控、屏幕阅读器与真实多显示器 DPI 仍未验证。未生成或安装新版 NSIS，也未发布版本；本次构建与 Windows 自动化结果不代表用户已安装的旧 App 已更新。
