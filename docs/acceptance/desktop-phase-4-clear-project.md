# Desktop Phase 4 补充验收记录

2026-11-11，按用户截图调整新建会话的项目选择。

## 实现

- `apps/desktop/src/renderer/NewConversation.tsx` 将项目选择显示为带 × 的紧凑控件。× 清除当前新建页的项目选择，焦点回到消息输入，文字、图片草稿和已填工作目录继续保留。项目菜单仅提供已有项目，空态显示“选择项目”。
- 清除后展示显式 Linux 工作目录，收起分支和工作树选项。重新选择项目时重新加载真实分支并复位工作树开关。首次发送复用 `conversation.standalone`，由 Conversation 绑定的目录提供 ACP cwd。
- `apps/desktop/src/renderer/style.css` 复用既有深色变量及原生 Select，项目名与 × 位于同一圆角背景中，保留可见焦点、禁用状态及长名称省略。
- `apps/desktop/tests/new-conversation.test.tsx` 覆盖项目选择与清除后的渲染、目录和菜单选项。
- `apps/desktop/tests/windows-new-conversation.ts` 增加点击、Enter 激活、草稿保留、重新选择、工作树复位、窄窗及清除后首条消息的真实 Windows / WSL2 回归。

## 验证

- `bun run typecheck`、`bun run lint` 通过。日志为 `/tmp/hhu-clear-project-typecheck.log`、`/tmp/hhu-clear-project-lint.log`。
- `bun run desktop:test` 通过，含后端和 Desktop 构建、68 项 Desktop 单元测试及 18 项 Node 集成测试。日志为 `/tmp/hhu-clear-project-desktop-test-unrestricted.log`，隔离集成现场为 `/tmp/hhu-desktop-integration-A1SDqM`。
- `bun run test` 通过，120 项 Node 集成测试及 123 项 TUI 测试全部通过。日志为 `/tmp/hhu-clear-project-full-test.log`。
- `git diff --check` 通过。
- `HHU_DESKTOP_NEW_ONLY=1 bun scripts/verify-desktop-windows.ts` 通过。真实 Windows x64、Electron 45.2.3、WSL2 与受控 Mock ACP 验证了点击 / 键盘清除、保留草稿与目录、重新选择、720px 窗口及首条消息仅提交一次。新 Conversation 的 `projectId=null`，NativeSession.cwd 等于显式工作目录。日志为 `/tmp/hhu-clear-project-windows-final.log`，隔离 WSL 现场为 `/tmp/hhu-windows-smoke-ECaCTE`。已查看宽窗项目控件与清除后窄窗截图，截图和结果保存在 `evidence/desktop-clear-project/`。

初轮 Desktop 集成测试受沙箱本机回环限制而停滞，已结束该次测试并在允许回环的环境重跑通过。初轮 Windows 点击清除通过，键盘探针遗漏 Enter 字符事件而超时；补全与现有探针一致的字符事件后全部通过。失败日志保留在 `/tmp/hhu-clear-project-desktop-test.log` 和 `/tmp/hhu-clear-project-windows.log`。

## 人工验收

1. 进入项目的新建页，输入文字或添加图片，点击项目名左侧 ×，检查目录和草稿。
2. 用 Tab 定位 ×，按 Enter 清除，再通过“选择项目”重新选择。检查分支、工作树开关及长项目名显示。
3. 清除项目后确认 Linux 工作目录并发送，核对新会话的目录和首条消息。

真实 Harness、物理键盘、屏幕阅读器、中文 IME 与物理 DPI 为本轮未验证项。当前交付包含源码和本地构建，安装版使用此交互需要重新打包。
