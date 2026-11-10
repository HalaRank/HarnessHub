# HarnessHub v0.6.3 发布验收

日期：2026-11-10。用户明确要求发布本轮 Windows App 与 CLI 修改；范围为当前 Desktop Phase 4 / TUI Phase 6 的版本发布，不进入新产品阶段。

## 版本与变更

- 根 package.json、所有 workspace、shared VERSION 和 bun.lock 统一为 0.6.3，协议仍为 1，SQLite migrations 8。本轮不新增迁移。
- Windows：会话工作面板与应用设置分离、常驻可调宽侧栏、独立归档窗口、共享目录分支选择、紧凑 WSL 环境摘要和跳至最新消息箭头。
- CLI/TUI：恢复分栏布局并改进 Commands 菜单、搜索与浮层。
- README、DESKTOP 和 DISTRIBUTION 更新当前版本及安装/兼容信息。历史版本的验收记录保留。
- 构建使用不可变版本 Tag；不覆盖 v0.6.2 及其公开资产。Windows 与 Linux/WSL 同步构建，保持精确版本匹配和无自动更新。

## 本轮检查

完整命令日志保存于 `/tmp/hhu-release-v0.6.3/`。

- `bun scripts/version.ts 0.6.3`、`bun install --ignore-scripts`、`bun install --frozen-lockfile --ignore-scripts`、`bun run version:check`：通过，依赖版本未变。
- `bun run typecheck`、`bun run lint`、`git diff --check`：通过。
- `bun run test`：退出 0，实际构建 CLI/Daemon，119 个 Node 集成与 122 个 TUI 测试通过，0 失败。
- `TMPDIR=/home/clj/.cache/hhu-release-v0.6.3/tmp bun run desktop:test`：最终退出 0，实际构建后端/Desktop，61 个 Desktop 单元与 16 个 Node 集成测试通过，0 失败。合计 318 项通过。
- 初轮 Desktop 集成 15/16 通过：共享分支活动保护测试错误使用 Mock 未定义的 `slow` 指令，Agent 实际立即完成，检查时已不再活动。`tests/integration/desktop.test.mjs` 的该项及关闭客户端保活项改为 Mock 明确定义的 `wait`，等待本 Turn 的 `started` 事件后才继续；保活项额外断言关闭后仍 RUNNING、取消后为 CANCELLED。完整 Desktop 回归重跑通过，未修改产品运行逻辑。

远端双平台构建、安装验收及公开发布状态将在完成后补录。

## 验收边界

CI Windows runner 不具备 WSL，安装器验证不能冒充完整 Windows → WSL → 真实 Harness 验收。既有专项 Windows/WSL Mock ACP、Git 与交互证据见对应 Desktop 补充验收；本次不追认物理 IME、多显示器 DPI、全新用户真实模型登录与完整工作流已通过。

本轮发布不替换用户本机安装，不停止日常 Daemon，不修改原生 Agent 配置、业务数据或用户项目。Windows 包仍 unsigned；用户升级需同时安装同一 Release 的 Windows App 和 WSL 后端。
