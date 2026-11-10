# Desktop Phase 4 补充验收 — WSL 环境选中状态

日期 2026-11-10，Asia/Shanghai。

## 范围与设计选择

依据用户提供的 WSL 执行环境截图，增强连接后的选中感与固定感。采用连接状态驱动的常驻摘要，连接成功后使用深绿色底色、完整边框、勾选标识、发行版名称与 WSL2 标识。用户点击“切换”展开选择器，点击“取消”回到当前环境。提交连接前选择其他候选仅修改本地候选值。

初次选择后，下拉框显示更明确的底色与边框。连接中禁用重复提交和切换。断开、版本不兼容、连接失败时保留所选环境名称，并展示真实状态。名称过长时截断，title 保留完整名称。

## 文件

- `apps/desktop/src/renderer/WslEnvironment.tsx` 实现选择器与固定摘要之间的交互。
- `apps/desktop/src/renderer/App.tsx` 接入已有连接和发行版发现请求。
- `apps/desktop/src/renderer/style.css` 增加独立 WSL 环境区样式。
- `apps/desktop/tests/wsl-environment.test.tsx` 覆盖初始选择、连接成功、连接中和故障状态。
- `docs/acceptance/evidence/desktop-wsl-environment/browser-interactions.json` 保存隔离浏览器交互及窄侧栏断言结果。

工作区同时存在其他功能改动，本记录仅涵盖以上 WSL 环境区调整。

## 自动验证

| 检查 | 结果 |
| --- | --- |
| `bunx biome check` 指定以上四个代码与测试文件 | 通过 |
| `bun run desktop:build` | 通过 |
| Desktop 单元测试，使用 `apps/desktop` 的 React TS 配置 | 最终执行 60 项通过，其中新增 WSL 环境测试 3 项 |
| `HARNESSHUB_BUN=/home/clj/.local/bin/bun node --test tests/integration/desktop.test.mjs` | 16 项通过，隔离 SQLite、Daemon 与 Mock ACP |
| Chromium 中通过真实 App 组件执行选择、连接、切换、取消、错误状态和 220px 侧栏检查 | 5 组断言通过，连接请求使用隔离 Mock Desktop API |
| `git diff --check` 指定本次修改的 App 与 CSS 文件 | 通过 |
| `bun run typecheck` | 最终通过根、Daemon、Desktop 检查 |
| `bun run lint` 全仓库 | 最终通过。检查过程中安装与发布脚本的格式问题和集成测试末尾空行已由工作区其他改动修复 |

初次 `bun run desktop:test` 在受限环境中通过 59 项单测，进入 Node 集成测试后等待超时。核验本轮进程后使用 SIGTERM 结束该测试 runner，单独在允许本地连接的环境运行同一 Node 集成测试，16 项通过。

## 未验证与人工步骤

Chromium 截图接口连续超时，未取得可验收的渲染截图。浏览器交互与 DOM 尺寸断言通过，Windows Electron 实机视觉、物理 DPI、键盘与屏幕阅读器体验仍待人工验收。本轮没有提交真实 Harness 消息。

1. 启动本轮构建的 Desktop，在初始状态选择 WSL2 发行版并点击“连接”。确认连接成功后出现固定摘要、勾选和“已连接”，选择器收起。
2. 点击“切换”，选择另一发行版后点击“取消”，确认仍显示原环境。再次展开并明确连接，成功后摘要显示目标发行版。
3. 断开连接或使用不可用 Bridge，确认区域展示对应故障状态。通过顶部“重新连接”重试，检查成功后的摘要。
4. 将侧栏收窄到 220px，检查长名称截断、完整名称悬停提示以及状态和 WSL2 标识的可读性。在 Windows 125%、150%、200% DPI 下复查。

## 推送前独立检出复核

2026-11-10，将本次 WSL 环境 UI 的 6 个文件和对应片段整理到独立 worktree。Desktop 49 项单元测试、lint、Desktop 构建通过。前述 60 项单测与 16 项集成结果来自当时的共享工作区，其中包含其他并行功能改动。独立检出复用已安装的依赖，未重新安装依赖。
