# Desktop Phase 4 补充：右边栏 UI 重构

日期：2026-11-10。范围为用户要求的 Desktop 右侧工作面板界面优化，沿用当前阶段，不进入新的产品阶段。

## 实现

- `apps/desktop/src/renderer/WorkPanel.tsx`：从 App 提取独立的会话工作面板。固定顶部展示当前会话标题、关闭按钮与 Details / Changes / Diff / Debug 导航，内容区独立滚动。详情分为会话概览、Workspace、Context Handoff 和默认折叠的会话管理。状态颜色区分执行、待审批、不确定和错误；断线明确说明状态来自最后收到的数据。
- `apps/desktop/src/renderer/App.tsx`：仅将当前会话、已有事件/交接数据与原有操作回调传给面板。按发行版和 Conversation 设置 key，切换会话清理本地视图。调宽以抓取点的初始宽度和位移计算，保留 300–700px 限制、指针捕获和键盘方向键调宽。
- `apps/desktop/src/renderer/Changes.tsx`：文件列表突出文件名，次行显示目录；保留完整路径悬停、重命名前路径及 Git 原始双列状态。添加读取中、干净工作区和未选择 Diff 的空态，维持原有查询、轮询、分页与 Diff 数据来源。
- `apps/desktop/src/renderer/Handoffs.tsx`：交接数量与标题并列，NativeSession 标识、事件边界等追溯字段折叠查看，完整报告、原始材料、失败原因和原操作确认继续保留。
- `apps/desktop/src/renderer/style.css`：右栏的排版、分组间距、状态点、工作区路径卡片、文件行、事件列表及空态。窄窗口沿用浮层，长路径换行，文件名省略。

沿用原有后端和原生权限操作。浏览右栏不创建会话、不提交消息、不审批、不触发交接。全局环境设置继续由应用设置承载。工作区同期存在其他聊天布局修改及 shared-branch 证据修改，本记录仅覆盖上述右栏范围。

## 验证

| 命令或环境 | 结果 |
| --- | --- |
| `bun run typecheck` | 根 / Daemon / Desktop 通过 |
| `bun run lint` | 通过，无新增 warning |
| `bun run desktop:test` | 后端及 Desktop 构建、61 单元测试、16 Node 集成测试通过 |
| 最后一次 `bun run desktop:build` 与 `bun test --cwd apps/desktop tests` | 构建、61 单元测试通过 |
| `bun run test` | 118 / 119 Node 集成通过；1 项真实 PTY 测试在 Ctrl+C 退出第二个 TUI 时超时，整条命令退出 1，未运行后续 TUI 测试 |
| 独立重跑 `HARNESSHUB_BUN=/home/clj/.local/lib/node_modules/bun/bin/bun.exe node --test tests/integration/phase1.test.mjs` | 11 / 11 通过，包含上述冷启动 / Ctrl+C 退出测试；首次全量失败记录保留 |
| `bun test tests/e2e` | 122 项 TUI 测试通过 |
| 隔离 Chromium + 实际 App / WorkPanel / CSS + 夹具 API | 7 组交互检查通过 |
| `git diff --check` | 通过 |

Chromium 检查覆盖详情绑定、默认折叠管理、文件列表、Changes / Diff 切换保留选择、原始事件、方向键调宽、浏览器鼠标拖动及指针捕获（420 → 490px）、760px 浮层及长路径无横向溢出、左栏保持 260px、关闭面板。检查确认没有 `turn.submit`、`approval.decide`、`session.prepare`、`handoff.action` 或会话修改 / 删除请求。

Windows Electron 45.2.3 实际展示当前 App 和 CSS，通过夹具 API 提供数据，已核对 Details / Changes / Diff 截图与 Debug 原文展开。Windows 完整交互序列**未验证通过**：首次入口点击过早，重试后视图断言通过；鼠标模拟未改变宽度，后续尝试遇到显示表面不可捕获 / 等待合成帧超时。故完整拖动与窄窗口检查改由隔离 Chromium 验证，不将其冒充 Windows 整体通过或物理鼠标实测。

证据位于 [evidence/desktop-right-panel](evidence/desktop-right-panel)，包含三张 Windows 截图、浏览器交互及指针结果、Windows 部分验证说明、Desktop 单元、全量失败、Phase 1 重跑和 TUI 测试日志。夹具及运行器保留于 `/tmp/hhu-right-panel-preview`，Windows 隔离目录为 `C:\Users\31970\AppData\Local\Temp\hhu-right-panel-fctfxt4h`。没有调用日常数据库或真实模型。

## 待用户验收与限制

1. 使用本轮 Desktop 构建，打开会话右栏，检查分组层级、字体间距、工作区复制 / 文件夹入口和折叠的会话管理。
2. 在真实项目中查看 Changes，点击长路径文件进入 Diff；查看交接记录与 Debug，确认原始内容完整可展开。
3. 在 Windows 用物理鼠标拖动右栏边缘，收窄窗口、调整 DPI，检查导航和长内容。物理鼠标、多显示器 DPI、读屏器及本轮真实 Harness 会话均未重新验证。

本轮交付源码和构建产物，没有生成或安装新安装包，也没有发布版本。
