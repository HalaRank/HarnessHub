# Desktop Phase 4 选择框 UI

日期为 2026-11-11，Asia/Shanghai。本次继续现有 Desktop 阶段，依据用户提供的项目下拉截图统一 App 内的选择框。

## 实现与文件

| 文件 | 内容 |
| --- | --- |
| `apps/desktop/src/renderer/Select.tsx` | 复用原生 select、button 和 selectedcontent，传递原有 value、onChange、disabled、id 及可访问名称 |
| `apps/desktop/src/renderer/Composer.tsx` | Harness、ACP 模型、配置审批模式和旧协议模式入口使用统一组件，旧模式增加显式标签关联 |
| `apps/desktop/src/renderer/NewConversation.tsx` | 项目、分支和 Harness 使用统一组件，项目与分支增加显式标签关联 |
| `apps/desktop/src/renderer/WslEnvironment.tsx` | WSL 发行版使用统一组件 |
| `apps/desktop/src/renderer/style.css` | 12px 字号、32px 控件、深色菜单、选中勾号、悬停与键盘焦点、长文本省略和换行、受限高度滚动、低动态效果与系统高对比度 |
| `apps/desktop/tests/select.test.tsx` | 原生空值、禁用选项、受控选中、表单属性和非提交按钮的回归 |

收起时，长名称在一行内省略。展开后，选项可以换行完整阅读。菜单使用 8px 圆角和细边框，常规最大高度为 320px，并受视口高度约束。紧凑输入栏与新建页选项在悬停或展开时显示边界。系统高对比度使用 Highlight / HighlightText，并保留选中勾号。

使用当前锁定 Electron 的 Chromium 可定制原生选择框。菜单由原生 top layer 绘制，键盘导航、焦点和表单事件由浏览器处理。[Chrome 官方说明](https://developer.chrome.com/docs/modern-web-guidance/guides/forms/branded-select-styling)

## 验证范围

共享工作区同时有其他聊天图片功能改动，涉及 Composer、NewConversation、style.css、草稿、数据库迁移和后端。限定验证副本位于 `/tmp/hhu-select-ui-validation`，由本轮开始时的 HEAD 加上表中的选择框改动组成，依赖复用现有锁定安装。本次验收对应这一限定范围。

| 命令 | 结果 |
| --- | --- |
| `bun run typecheck` | 限定副本和原工作区最终根工程、Daemon、Desktop 均通过 |
| `bun run lint` | 限定副本 169 个文件通过 |
| `bun run desktop:test` | 限定副本 CLI、Daemon、Desktop 构建通过，63 项 Desktop 单元和 16 项 Node 集成通过 |
| `bun run test` | 限定副本 119 项 Node 集成、123 项 TUI 回归通过 |
| `bun run desktop:build` | 当前工作区最终源码构建通过，更新 `dist/desktop/app` |
| `git diff --check` | 通过 |

日志位于 `/tmp/hhu-select-ui-isolated-typecheck-final.log`、`/tmp/hhu-select-ui-isolated-lint-final.log`、`/tmp/hhu-select-ui-isolated-desktop-test.log`、`/tmp/hhu-select-ui-isolated-full-test.log`、`/tmp/hhu-select-ui-desktop-build-final.log`。

初轮 typecheck/lint 在并行图片改动中遇到图片 schema 循环类型和格式问题，后续原工作区 typecheck 还出现 stopReason 类型错误。原工作区最终 typecheck 已通过，最终 lint 在并行新增的 `apps/desktop/tests/windows-images.ts` 遇到 unsafe optional chaining，并有图片样式 specificity 警告。原工作区全量测试在 schema 6 迁移用例遇到 images 列缺失，未将其记录为通过。限定副本用于核验本次选择框代码。

初轮两个构建命令并行写入同一 dist，发生迁移文件复制 ENOENT。后续构建按顺序执行。沙箱中的 Windows 互操作和隔离 Daemon 启动被限制，使用允许这些操作的执行环境重跑。新增单元测试首次从仓库根运行加载了 Solid 测试配置，改为按现有 Desktop 工作流从 apps/desktop 运行后通过。

## Windows 实测

真实 Windows x64、Electron 45.2.3、Chromium 156.0.8078.80。隔离窗口加载当前工作区实际 App、Composer、NewConversation、WslEnvironment 和 CSS，API 为受控替身。模型候选来自已保存的原生 ACP 能力，项目、50 个分支及 WSL 发行版使用测试数据。

以下项目全部通过。

1. 三个输入栏选择框均使用 base-select，菜单与控件字号为 12px，收起高度为 32px。
2. 鼠标打开、方向键选择、Enter 确认和 Escape 关闭。模型选择仅产生一次 session.settings 请求。
3. 项目选择的空字符串进入独立会话。分支列表支持 50 项滚动，长分支选项换行，选中后保留完整值且控件保持 32px。
4. 720px Windows 窗口中的新建页选择框没有横向溢出。
5. WSL 菜单显示在应用设置弹窗上层，WSL1 禁用项被键盘跳过。第一次 Escape 关闭菜单，第二次关闭设置。
6. 旧 ACP modes 回退入口使用相同选择框。
7. reduced-motion 下箭头过渡关闭。forced-colors 下文字与勾号可见，选中前景和背景不同。

Windows 探针位于 `/tmp/hhu-select-ui-preview/app/main.cjs`，构建入口为 `/tmp/hhu-select-ui-preview/build.ts`。执行 `bun /tmp/hhu-select-ui-preview/build.ts` 后，由已下载的 Electron 45.2.3 Windows executable 打开该 app 目录。完整结果和截图位于 `evidence/desktop-select-ui/`。截图来自 Electron capturePage，已查看项目、长分支、窄窗、WSL 与高对比度画面。

限定副本的编译、lint、Desktop 和全量回归日志同时保存到 `evidence/desktop-select-ui/`，便于独立核对 63 / 16 / 119 / 123 的测试结果。

初轮 Windows 探针使用 ArrowDown，Electron 输入事件需要 Down，修正后实际选择通过。长名称首轮存在增高及溢出，增加 selectedcontent 容器后保持单行省略。高对比度首轮出现选中文字背景覆盖，使用系统色并设置选中项 forced-color-adjust 后复验通过。UNC 路径缓存的 Chromium 沙箱诊断保留在 `/tmp/hhu-select-ui-preview/electron-high-contrast-final.log`。

## 待人工验收

本轮真实 Harness 的模型/权限变更、物理键盘、屏幕阅读器、真实多屏和物理 DPI 为未验证。Windows 自动化验证使用 UI 替身，后端行为由既有 Mock ACP 集成覆盖。

1. 打开新建会话，逐一检查项目、分支和 Harness。用较长分支名检查收起省略与展开阅读。
2. 在真实会话中检查模型和审批模式入口，用键盘选择并核对实际设置返回。
3. 在应用设置中打开 WSL 下拉，检查禁用项、菜单位置和 Escape 关闭顺序。
4. 调窄窗口，在系统高对比度和减少动态效果下检查文字、焦点与选中标记。

本轮交付源码及本地构建。安装版更新仍需重新打包并验收。
