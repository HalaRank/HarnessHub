# Desktop 首条消息与会话准备竞态

2026-11-12，Asia/Shanghai。本次继续 Desktop Phase 4。

## 原因与修复

新建页先提交首条 Turn，再进入 Conversation。Turn 已进入 PREPARING，但 ACP 初始化尚未完成，Conversation 的 activeNativeSessionId 仍为空。Composer 的自动准备 effect 原先只检查发送禁用条件。运行中发送功能开放后，该条件允许 PREPARING，effect 因此额外调用 sessions 接口，触发 HTTP 409 与 `Conversation has an active operation`。已接受的原 Turn 仍可完成。

自动准备现在同时检查已有 busy 状态，覆盖 PREPARING、RUNNING、WAITING_APPROVAL、CANCELLING 及本地提交操作。新建 Turn 的准备流程按既有 Runtime 执行。运行中 Enter 与排队继续使用各自发送条件。

## 变更文件

- `apps/desktop/src/renderer/Composer.tsx`
- `apps/desktop/tests/windows-new-conversation.ts`
- `scripts/verify-desktop-windows.ts`

Windows 新建会话探针增加单次 ACP Prompt 和无 active operation 错误断言。定向 `HHU_DESKTOP_NEW_ONLY=1` 流程将 Mock initialize 延迟 2500ms，以覆盖首条 Turn 尚未绑定 NativeSession 的窗口。

## 验证

- `bun run typecheck` 通过，日志 `/tmp/hhu-first-message-typecheck.log`。
- `bun run lint` 通过，日志 `/tmp/hhu-first-message-lint.log`。
- `bun run desktop:test` 的后端与 Desktop 构建、71 项 Desktop 单元测试及 20 项 Node 集成测试通过，日志 `/tmp/hhu-first-message-desktop-test.log`。
- `bun run test` 通过，122 项 Node 集成测试与 125 项 TUI 测试，0 失败，日志 `/tmp/hhu-first-message-test.log`。
- Chromium 加载实际 App、NewConversation、Composer，通过测试专用 HTTP/SSE 转发连接实际 DesktopConnection、隔离 Daemon、SQLite 和 Mock ACP。新建页通过 Enter 发送首条消息，初始化延迟 2500ms。修复前捕获一次额外 session.prepare、HTTP 409 和界面错误。修复后额外准备请求为零、界面错误为零。两次均观察到 PREPARING 且 activeNativeSessionId 为空，各保留一个用户消息、一个 NativeSession 和一次 ACP session/prompt。证据 `/tmp/hhu-first-message-race/before-evidence.json` 与 `/tmp/hhu-first-message-race/after-evidence.json`。
- `git diff --check` 通过。

初轮隔离 Daemon 启动受沙箱限制，随后通过允许本机子进程与回环监听的执行方式完成测试。Chromium 初轮缺少动态库，加载现有临时运行库后继续。当前环境的动画帧检查超时，测试改用定时 DOM 检查完成。首次 lint 发现测试断言格式，修正后通过。

## 待验收

Windows Electron 与真实 Agent 的本轮验证为“未验证”。源码及本地构建包含修复，用户安装版需重新打包更新后生效。

1. 使用本轮 Desktop 构建和匹配后端，在项目中新建会话，选择 Agent 后发送首条消息。
2. 观察准备、执行与完成过程，检查输入区无 active operation 错误，历史只有一次用户消息。
3. 在 Agent 执行中追加输入及排队，核对原有发送与原生审批流程。
4. Windows 定向自动化可执行 `HHU_DESKTOP_NEW_ONLY=1 bun scripts/verify-desktop-windows.ts`，需先按既有发布流程准备 Windows 测试产物与 WSL 互操作环境。
