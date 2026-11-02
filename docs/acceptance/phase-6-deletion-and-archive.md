# Phase 6 补充：删除项目、删除及归档会话

2026-11-01。按用户要求补齐现有 MVP 的生命周期操作，不进入新阶段；版本 0.6.1 / SQLite schema 6，无迁移。

## 行为及文件

- `apps/tui/src/index.tsx`、`delete-confirmation.tsx`、`command-palette.tsx`：所选项目/会话的操作菜单（o / 侧栏 Actions / Ctrl+P），Delete 键进入确认；对话框提供 Cancel / Delete，默认 Cancel，Tab / 方向键和鼠标选择，Esc 取消；不再要求输入 DELETE。项目确认显示包含归档的会话总数。
- 归档直接隐藏会话，保留历史、草稿和运行任务；归档视图仅列出已归档会话，可恢复并返回主列表。既有 WebSocket 快照同步到其他 TUI。
- `apps/tui/src/draft-session.ts`：其他客户端删除会话后，草稿 PUT 的真实 404 使保存器退役，不复建草稿，不阻塞退出；409、网络断开等其他失败仍保留原保护。
- `apps/daemon/src/index.ts`、`packages/shared/src/index.ts`：项目删除要求 `{ confirmed: true }`，与会话一致，经 Runtime 安全关闭空闲 Worker 后删除。
- `packages/core/src/runtime.ts`、`packages/storage/src/index.ts`：先检查项目全部子会话，再预留项目及子会话并关闭空闲 Worker，最后事务级联删除；运行、审批、UNCERTAIN、未解决 Handoff、Worker 准备/配置/退出未确认均阻止删除。预留期间阻止新会话、Turn、重绑和重复删除。失败不强制终止、不删除历史；此前已合作式关闭的空闲 Worker 不自动重启。
- 删除仅清理 HarnessHub 元数据、草稿和历史；保留项目文件、Git 分支、Worktree 目录及管理记录，不隐式执行 Worktree cleanup。
- `tests/integration/deletion.test.mjs`、`tests/e2e/phase4.test.tsx`、`scripts/test.ts`：项目级联、实际进程退出、Worktree 保留、预留竞态、拒绝运行任务、关闭失败后显式重试、确认取消、归档恢复、双客户端同步及失效草稿保存回归；既有项目 DELETE 测试补传确认参数。README 和 OPERATIONS 同步使用方式。

当前工作区同时包含侧栏树鼠标交互调整（`project-tree.tsx` 及 `mouse-sidebar.test.tsx`），本功能兼容其按稳定 ID 选择和会话菜单，不将其单独视为删除功能新增阶段。

## 验证

临时 XDG 下真实运行 Node Daemon、Bun/OpenTUI renderer、SQLite、Git、受控 Mock ACP 子进程；没有删除用户现有项目/会话，没有操作默认数据库、原生配置或全局安装。

定向集成：`HARNESSHUB_BUN=$(command -v bun) node --test tests/integration/deletion.test.mjs`，**4/4 通过**，证据 `/tmp/hhu-deletion-JM7WMx`，日志 `/tmp/hhu-deletion-integration.log`。验证级联历史和草稿、最近选择置空、无外键违规、其他项目 Worker 不受影响、脏 Worktree/分支/管理记录保留、关闭期间拒绝并发写入、未确认退出保留数据且允许显式重试。

定向 UI：`bun test tests/e2e/phase4.test.tsx -t 'action menu archives|archive, restore'`，**2/2 通过**，证据 `/tmp/hhu-phase4-ui-Stn72W`，日志 `/tmp/hhu-deletion-ui-target2.log`。

最终 `bun run typecheck`、`bun run lint`、`bun run build`、`git diff --check` 通过。完整集成测试 **83/83 通过**（`bun run test` 中的 Node 阶段，日志 `/tmp/hhu-deletion-full-test.log`）；最终完整 UI 回归命令：

```bash
bun test tests/e2e/tui.test.tsx tests/e2e/phase4.test.tsx tests/e2e/phase5.test.tsx tests/e2e/mouse-sidebar.test.tsx
```

**40/40 通过，0 失败/跳过**，日志 `/tmp/hhu-deletion-ui-final2.log`；Phase 4 UI 证据 `/tmp/hhu-phase4-ui-FcjKpl`，鼠标侧栏证据 `/tmp/hhu-mouse-sidebar-TjIfW7`。最终验证合计 **123 项通过**。

保留修复过程边界：首轮完整 runner 的 Node 阶段全过，但 UI 曾有 2 项失败；后续 UI 曾剩 1 项鼠标确认失败。确认按钮文字禁用文本选择，测试等待新对话框完成渲染后再读取点击坐标，菜单测试等待前一次操作完成；最终重跑全部 40 项 UI 全过，没有放宽确认、删除数据或工作区保留断言。83 项 Node 测试之后后端没有再改；最终是该完整 Node 结果与完整 UI 重跑结果组合，不把早期 runner 的非零退出改写为一次性成功。

最终整套 runner 补充复核：`bun run test` 在 `/tmp/hhu-mouse-final.log` 中完整通过，**83 项 Node 集成 + 40 项 UI = 123 项，0 失败/跳过**；UI 证据 `/tmp/hhu-phase4-ui-pphsYM` 与 `/tmp/hhu-mouse-sidebar-Y72ivf`。此前失败及分步重跑记录仍保留。推送前再次执行 build、typecheck、lint 与 diff 检查，均通过。

## 用户待验收及限制

1. Windows Terminal / VS Code WSL 的真实键盘、鼠标操作仍**未验证**。手动启动新版 TUI，选择会话 → o / ⋯ → 归档；在 Ctrl+P → View Archived Conversations 中恢复。再选择会话/项目 → Delete，分别验证默认 Cancel、Esc 取消、Tab 后确认及鼠标按钮。项目删除须显示全部会话范围，用户源文件和 Worktree 应保留。
2. 运行中会话可归档，不能删除；先正常取消并等待真实结束再删除。UNCERTAIN 不提供绕过删除，不清除不确定执行证据。
3. 本轮未发送真实 Harness 模型 Prompt；Mock ACP 验证安全退出和故障，不能扩大为四种真实 Harness 的退出兼容性全部通过。原生模型配置及权限策略不变，沿用既有真实兼容性记录。
4. 未自动安装新版 `hhu`、替用户删除现有数据或宣布 MVP 最终验收通过。源码构建不会替换已有独立安装发布；需要更新安装时按 OPERATIONS 先安全停 Daemon 再安装。
