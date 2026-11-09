# Phase 6：恢复两次 Delete 删除快捷键

2026-11-09。恢复既有快捷操作，仍在当前阶段，无数据库或 ACP 协议变更。

- `apps/tui/src/index.tsx`：浏览所选 Conversation / Project 时，第一次 Delete 打开删除确认并消费该按键，避免同一次事件直接确认。输入框、聊天历史、Changes 和其他弹窗保留原有键盘所有权。
- `apps/tui/src/delete-confirmation.tsx`：第二次无修饰键 Delete 确认删除；Ctrl / Alt / Shift + Delete 不触发此操作。默认仍选 Cancel，Enter 或 Esc 可以取消。
- `tests/e2e/phase4.test.tsx`：原两次 Delete 用例改为真实按两次键；补查输入框删字、修饰键、Esc 和默认 Enter 取消。README、OPERATIONS 同步说明。
- 删除沿用现有服务端路径：确认删除 Conversation 会停止其活动任务和 Worker，再清理应用数据；项目文件、Worktree、Git 分支保留。

验证结果：

- `bun run typecheck`、`bun run lint`、`bun run build`、`git diff --check` 通过。
- `bun test tests/e2e/phase4.test.tsx -t 'two Delete presses|Delete edits|confirmed deletion cancels|archive, restore|action menu archives'`：5/5 通过，26 个断言。日志 `/tmp/hhu-restore-delete-ui-final.log`，隔离实例 `/tmp/hhu-phase4-ui-1lUkEx`。
- `HARNESSHUB_BUN=$(command -v bun) node --test tests/integration/deletion.test.mjs`：8/8 通过。日志 `/tmp/hhu-restore-delete-integration.log`，隔离实例 `/tmp/hhu-deletion-iJvBlc`。

最初沙箱内测试无法启动隔离 Daemon；获准使用本地回环端口后完成验证。新增 UI 用例首轮因测试未等待 Esc 的终端解析而失败，补足等待后上述定向回归全过。未执行全量测试。

Windows Terminal / VS Code WSL 物理键盘未验证；手动选中测试会话，退出消息输入后按 Delete，应仅弹出确认框，再按 Delete 才删除；另查 Esc / 默认 Enter 取消和输入框 Delete 删字。本轮仅交付源码及构建产物，未升级全局安装或重启用户 Daemon，未删除实际用户会话。
