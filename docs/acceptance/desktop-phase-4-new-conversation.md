# Desktop Phase 4 补充验收记录

2026-11-10，会话行操作与新建会话页面。本次继续当前 Desktop 阶段。

## 实现

- 会话行右侧提供重命名与归档，当前选中行常显，其他行在鼠标悬停、键盘聚焦或触摸设备上可见。归档列表提供恢复入口，操作绑定当前行的 Conversation ID。
- 独立会话位于全部项目之后，使用顶层缩进和行内小字标识。没有项目式标题、计数、折叠按钮或独立分组的新建按钮。顶栏新建入口和新建页的项目选择仍可创建独立会话。
- 新建会话使用现有 HarnessHub Logo、包含所选项目名的引导语和底部输入框。项目、Git 分支、创建工作树开关放在输入框上方。
- 首次发送才创建 Conversation。省略显式 title，沿用既有 hhu 首条接受消息自动命名逻辑。先保存真实 Conversation 的 CAS 草稿，再使用现有 DesktopDraft 提交，保留 requestId 查询和不确定结果处理。
- 原实现 Shared 模式只显示当前分支，工作树模式可选择真实本地分支。后端校验完整 ref 并解析为 commit，再创建既有托管 hhu 分支和目录。未指定分支的旧 TUI/API 调用继续从 HEAD 创建。用户后续要求 Shared 模式也可选分支，现已由 [共享分支选择补充](desktop-phase-4-shared-branch.md) 扩展。
- 新建页首条消息也写入 WSL SQLite，复用 DesktopDraft 的串行保存、CAS 和加载竞态保护。多个窗口编辑同一新建页草稿时，过期保存返回冲突，可显式重新载入。SQLite schema 从 7 升到 8，沿用迁移前私有备份与失败回滚。

Git 参数依据已核对官方文档。[git-worktree](https://git-scm.com/docs/git-worktree)、[git-rev-parse](https://git-scm.com/docs/git-rev-parse)。

## 主要文件

- `apps/desktop/src/renderer/App.tsx`、`NewConversation.tsx`、`ConversationDialog.tsx`、`drafts.ts`、`style.css`
- `apps/desktop/src/contracts.ts`、`src/main/actions.ts`、`src/main/connection.ts`
- `apps/daemon/src/index.ts`、`packages/core/src/index.ts`、`packages/core/src/worktrees.ts`、`packages/shared/src/index.ts`
- `packages/storage/src/index.ts`、`schema.ts`、`migrations/0007_absurd_sally_floyd.sql` 与生成的迁移元数据
- `apps/desktop/tests/new-conversation.test.tsx`、`windows-new-conversation.ts`、`windows-smoke.ts`、`windows-workspace.ts`、`tests/integration/desktop.test.mjs`

工作区同时存在其他 TUI、输入栏、工具活动分组、WSL 环境和分发改动。保留这些改动，验证结果对应本轮实际工作区。

## 自动化验证

- `bun run typecheck` 通过，日志 `/tmp/hhu-new-conversation-final-typecheck.log`。
- `bun run lint` 通过，166 个文件，日志 `/tmp/hhu-new-conversation-final-lint.log`。
- `git diff --check` 通过。
- `bun run desktop:test` 的后端构建、Desktop 构建、60 个单元测试与 16 个 Node 集成测试通过。日志 `/tmp/hhu-new-conversation-desktop-test-final-complete.log`，隔离数据 `/tmp/hhu-desktop-integration-5lj0Tz`。随后增加新建页草稿跨编辑器/CAS 回归，完整 Desktop 单元测试重跑为 61/61 通过，日志 `/tmp/hhu-new-conversation-desktop-unit-all.log`。
- `bun run test` 通过，119 个 Node 测试与 121 个 TUI 测试。日志 `/tmp/hhu-new-conversation-full-test.log`。该次测试在本轮进行中启动，后续补充的新建页草稿与独立会话界面由上述最终 Desktop 测试覆盖。
- 定向集成覆盖省略标题、首条消息自动命名、真实分支列表、所选分支的文件内容、共享目录分支保持、无效分支拒绝、游离 HEAD、无提交及非 Git 项目、独立会话，以及新建页草稿持久化和过期 revision 拒绝。

初轮沙箱拒绝本机回环监听，隔离 Daemon 无法启动。后续允许本机回环的测试通过。初轮 Desktop 静态测试在组件新增 draft 参数后缺少参数，已同步测试接口。工作区并行编辑曾导致重复 JSX 属性，移除重复后 typecheck/lint 通过。保留失败日志。

## Windows 与人工验收

`HHU_DESKTOP_NEW_ONLY=1 bun scripts/verify-desktop-windows.ts` 在真实 Windows x64 / Electron 45.2.3 / WSL2 中通过，最终 evidence.passed=true。日志 `/tmp/hhu-new-conversation-windows-delivery.log`，Windows 现场 `/mnt/c/Users/31970/AppData/Local/Temp/hhu-desktop-smoke-30yPA3`，隔离 WSL 数据 `/tmp/hhu-windows-smoke-o7oXTY`。

已通过 Logo/项目文案和输入框上方选项、无名称弹窗、切换页面恢复 SQLite 首条草稿、双击发送仅一个用户 Turn、真实托管 Worktree 和 NativeSession.cwd、会话行重命名/归档/恢复，以及独立会话置底/顶层缩进/行内标识检查。使用受控 Mock ACP。最终截图与检查清单保存于 `evidence/desktop-new-conversation/`。

此前完整 Windows 流程在工具活动分组检查处超时，新建页探针还遇到 WSL 互操作发现/重复 Bridge 超时。最终定向探针复用已连接的 DesktopConnection 读取真实历史，避免额外启动 Bridge。测试脚本尝试 reload 时会触发现有关闭保护，已改为验证切换页面恢复，跨编辑器恢复另由单元与 SQLite 集成覆盖。保留初轮失败日志，不将失败记为通过。完整 Windows 流程仍未在本轮重新通过。

人工步骤如下。

1. 点击项目右侧加号或新建会话，确认直接进入 Logo、项目引导语与消息输入，无名称弹窗。
2. 切换项目，核对引导语和真实分支。开启工作树并选择起始分支，发送首条消息后核对标题、Workspace 和 Changes。
3. 新建页输入后切换会话、重开窗口，再进入新建页，确认未发送草稿恢复。两个窗口竞争编辑时确认显示冲突。
4. 在未选中会话的右侧重命名、归档并恢复，确认目标正确。
5. 检查独立会话位于所有项目之后，没有分组大标题，缩进与行内标识能区分项目会话。

物理中文 IME、DPI、多屏和真实 Harness 的本轮交互仍需人工验收。Mock ACP 结果不替代真实 Harness 验收。

本轮更新源码与构建产物，未替换用户安装目录中的客户端或日常 Daemon。

## 推送前独立快照复核

2026-11-10，从 Git index 导出仅含本次会话功能的独立快照，排除并行 WSL 环境 UI 片段。复用现有第三方依赖，并将 Workspace 包链接指向快照源码。`bun run typecheck`、`bun run lint`、后端及 Desktop 构建通过，Desktop 单元 58/58、Node 集成 16/16 通过。日志 `/tmp/hhu-conversation-push-20261110/desktop-test-verified.log`，集成现场 `/tmp/hhu-desktop-integration-wbEB1t`。初次验证缺少 Workspace 本地包链接，补齐快照内链接后通过，没有重新安装依赖或修改锁文件。
