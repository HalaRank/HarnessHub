# Phase 6：左侧项目与会话树持续显示

2026-11-10。用户澄清要求左侧持续显示 Project → Conversation，右侧显示会话内容，不通过隐藏项目树来适应窄终端。本次属于现有 Phase 6 UI 修正。

## 根因和修改

- 当前全局实例实际返回 `showSidebar=false`；恢复前版 UI 并不会清除用户的持久化隐藏设置。
- `apps/tui/src/index.tsx` 还保留前版小于 90 列自动隐藏的条件，即使保存为显示，80 列终端仍不会默认显示项目树。
- 移除宽度触发的隐藏条件及单独的窄窗开关状态；仅显式 Toggle Sidebar 改变可见性并保存。缩窄、回宽及重新打开不会自动改变保存的显示选择。
- 保留原项目树与右侧会话结构、名称、排序、间距和点击行为。侧栏随宽度缩放，上限 34 列，下限 12 列，不被右侧内容挤掉。
- 已通过运行中 Daemon 的 `/v1/preferences` API 将当前实例 `showSidebar` 恢复为 `true`。现有 TUI 仅在启动时读取该设置，需关闭客户端后重开；没有停止 Daemon、Worker 或提交任何 Agent 请求。

## 验证

- `bun run build` 通过：`/tmp/hhu-sidebar-build.log`。
- `bun run typecheck` 通过：`dist/verification/persistent-sidebar/typecheck.log`。
- `bun run lint` 通过：`dist/verification/persistent-sidebar/lint.log`。
- 定向 UI 第一轮 41/41 通过，484 个断言：`/tmp/hhu-sidebar-targeted.log`。
- 新增 80 列启动、鼠标会话切换与重开回归；尺寸回归覆盖 150/100/89/80/70/35 列及回宽，并检查项目树位于聊天左侧、历史与输入不越出右栏。
- 最终完整 UI 回归 **123/123 通过，1728 个断言，94.23 秒**：`TMPDIR=/home/clj/.cache/hhu-ui-tmp bun test tests/e2e`，日志 `dist/verification/persistent-sidebar/ui-verified.log`。`git diff --check` 通过。
- 首轮完整 UI 遇到鼠标侧栏用例仍要求 72 列时自动隐藏，已按新需求改为持续显示，显式隐藏/显示继续验证。该轮 115 通过、8 失败，OpenTUI 断言输出大量对象，随后确认系统 `/tmp` 已满；未清理其他任务文件。首轮结果保存在 `dist/verification/persistent-sidebar/ui-initial.log`。改用仓库内长路径临时目录的回归为 119 通过、4 失败，旧测试匹配完整 Workspace 路径时遇到 UI 正常截断；最终改用较短的 `/home/clj/.cache/hhu-ui-tmp` 作为 `TMPDIR`，以避免此环境因素。
- 构建产物的隔离 Linux PTY 检查通过，含 80 列启动无需切换直接显示项目树及聊天、项目 N/独立 Ctrl+N、保存草稿与重开、退出后 Daemon 保活、零 ACP 请求：`/tmp/hhu-sidebar-narrow-pty.log`，证据 `/tmp/hhu-new-conversation-pty-mqjyc7xk/evidence.json`。

未改动后端，本轮不重复运行后端集成测试。Windows Terminal / VS Code WSL 物理终端及真实远端 ACP 本轮未验证。

## 交付和人工验收

首次交付遵循用户“先保留当前运行，交付源码和构建”的选择，没有更新全局启动器。随后用户明确要求“安装最新 hhu”，已完成下述全局安装。

- `hhu daemon upgrade-check` 返回 `safeToStop=true`、无阻塞项；运行任务和待审批均为 0。
- 使用 `hhu daemon stop --for-upgrade` 安全停止，再执行 `bun run install:local`；安装器持有既有内核锁完成构建与原子替换。
- 全局入口 `~/.local/bin/hhu` 已指向 `dist/releases/e1e20dee-ffa7-4022-8df4-fd6c6ad1e4bc/cli/hhu.js`，包含取消窄窗自动隐藏的最新源码；`hhu --version` 为 `HarnessHub 0.6.3`。
- 原启动器对保存在该发布的 `previous-launchers/`。安装日志 `dist/verification/persistent-sidebar/install-latest.log`。
- 已通过新版 `hhu daemon start` 重启默认实例，健康检查通过，确认 `showSidebar=true`。没有取消任务、强制终止进程、删除历史或重放 Turn。
- 安装产物的隔离 Linux PTY 复核通过，包含 80 列启动双栏、重开和 Daemon 保活；日志 `dist/verification/persistent-sidebar/installed-pty.log`，证据 `/home/clj/.cache/hhu-ui-tmp/hhu-new-conversation-pty-7swh3e0v/evidence.json`。

可直接从任何目录执行 `hhu`。开发构建也可连接现有 Daemon：

```bash
bun /home/clj/HarnessHub/HarnessHub/dist/cli/hhu.js
```

1. 在 80 列及更宽终端打开构建产物，左侧项目与会话树直接可见，右侧显示最近会话。
2. 点击左侧不同会话，右侧随之切换，项目树持续存在。缩窄后回宽，项目树保持可见。
3. 显式 Toggle Sidebar 仍可用于用户主动隐藏；关闭后重开恢复该显式选择。
4. 打开 Commands 菜单、输入草稿及退出客户端，检查后台执行继续。
