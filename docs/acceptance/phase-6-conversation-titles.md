# Phase 6 补充：会话自动命名与重命名

2026-11-01。当前 MVP 交互补充，不进入下一阶段；SQLite schema 6，无迁移。

## 行为与文件

- `apps/tui/src/index.tsx`：`n` / Ctrl+P → New Conversation 直接创建共享目录会话、选中新会话并进入消息输入，不再填写名称。Ctrl+P → New Conversation in Git Worktree 保留独立 Worktree 创建入口，同样无需命名。
- `packages/shared/src/index.ts`、`packages/core/src/index.ts`、`packages/storage/src/index.ts`：创建 API 的 `title` 可省略，初始标题为 `New conversation`；显式标题仍须非空且不超过 200 字符，旧客户端调用兼容。
- `packages/core/src/runtime.ts`、`packages/storage/src/index.ts`：首条接受的用户消息自动命名，折叠空白，超过 80 个 Unicode 码点截取前 79 个并加省略号；保留原始消息，不增加 Agent Prompt 或模型调用。后续 Turn、重复 requestId 和内部 Handoff 不再改名。使用现有 SQLite 元数据记录 `conversation.created_named` / `conversation.title_set` 保存已设置标题的事实，显式创建/重命名到占位标题也不会被覆盖；归档不锁定自动命名。
- `apps/tui/src/project-tree.tsx`、`index.tsx`：会话行 `⋯`、`o` 和 Ctrl+P 均提供 Rename Conversation；预填当前标题，Enter 保存、Esc 取消。操作绑定目标 Conversation ID，可重命名未选中的会话，其他 TUI 按既有 WS 元数据同步。
- `tests/integration/phase3.test.mjs`：覆盖自动标题、首条消息、原消息保留、去重、后续消息不覆盖、重启持久化、显式占位名称、Unicode 截断及非法标题。既有并发测试等待两个 Worker 都准备完成再读能力，避免在另一 Worker 已等待审批时读取尚未握手完成的会话。
- `tests/e2e/tui.test.tsx`、`phase5.test.tsx`、`mouse-sidebar.test.tsx`：更新免命名创建、键盘重命名及 Worktree 流程，覆盖鼠标对目标会话重命名、取消及两个 TUI 同步。README / OPERATIONS 更新操作说明。

## 验证与边界

验证仅使用临时 XDG 下的真实 Node Daemon、SQLite、OpenTUI/Solid renderer、Git 与受控 Mock ACP。没有操作用户默认数据、全局安装或原生 Agent 配置，没有发送真实模型 Prompt。

已实际通过新增 Linux PTY 验证：从 `/home/clj` 启动构建后的 `hhu`，按 `n` 无标题输入即创建、确认没有启动 NativeSession，随后通过 `o` → Rename Conversation 用真实终端按键编辑并保存；退出 TUI 后 Daemon 保活，后续 Mock ACP Turn 不覆盖手动名称。证据 `/tmp/hhu-title-pty-8yr266kk/evidence.json`、`terminal.log`（目录 0700，文件 0600），脚本结束正常停止临时 Daemon。该结果不替代 Windows 物理终端或真实模型验证。临时探针初次把 requestId 写成无连字符 UUID，被 API 400 拒绝；修正探针格式后在全新临时环境通过，没有重发已提交 Turn。

最终验证：`bun run build`、`bun run typecheck`、`bun run lint`、`git diff --check` 通过。`bun run test` 的 Node 阶段 **84/84 通过**，日志 `/tmp/hhu-auto-title-full-final.log`；该次 UI 阶段受同时进行的聊天投影调整影响失败，不能记为整套 runner 一次通过。最终单独重跑完整 UI：

```bash
bun test tests/e2e/tui.test.tsx tests/e2e/phase4.test.tsx tests/e2e/phase5.test.tsx tests/e2e/mouse-sidebar.test.tsx
```

**49/49 通过，0 失败**，日志 `/tmp/hhu-auto-title-ui-verified.log`；其中鼠标重命名证据 `/tmp/hhu-mouse-sidebar-tD9Sc9`，Phase 4 UI 证据 `/tmp/hhu-phase4-ui-tbAXS3`。最终合计 **133 项通过**，为完整 Node 阶段与后续完整 UI 重跑结果组合。Node 阶段之后会话命名后端没有再改；后续调整仅涉及 UI 测试等待可见内容、让第二个 TUI 选中待重命名会话以观察标题同步，以及同时进行的聊天投影测试修正。保留此前 UI 失败日志 `/tmp/hhu-auto-title-ui-complete.log`，不回写为通过。

初轮定向验证中，新自动标题集成用例通过；既有并发用例因 Worker 能力尚未就绪失败，后续停机检查因此拒绝活动 Turn。UI 初轮两项在 Esc / 删除后立即发送下一按键时失败；增加渲染/选择完成等待后重跑完整测试，保留初轮日志 `/tmp/hhu-auto-title-integration.log` 与 `/tmp/hhu-auto-title-ui.log`，不将初轮失败计为通过。首轮完整 runner 的元数据 WS 一致性测试还发现标题状态与更新各记一个事件、只广播后者的问题；现改为单个 `conversation.created_named` / `conversation.title_set` 事件同时承担变更通知和标题状态记录，保持落盘与广播一致，再跑完整 runner。

Windows Terminal / VS Code WSL 物理操作**未验证**。手动验收：选择项目按 `n`，应直接出现空会话和消息输入；发送第一条消息，树与页头应显示自动标题；通过 `o` / `⋯` → Rename Conversation 修改名称，再发消息及重启后确认名称保留；Esc 取消应保留原名。Ctrl+P → New Conversation in Git Worktree 应创建独立工作区并直接进入消息输入。

既有四 Harness 兼容性及 Windows 人工验收限制继续保留，不宣布 MVP 最终验收通过。


## 推送前独立提交验证

从暂存区导出 `/tmp/hhu-title-push-trk7m1cc`，只包含会话命名改动，保留工作区中并行进行的聊天投影修改不提交。该隔离快照的 `bun run build`、`bun run typecheck`、`bun run lint` 通过；`HARNESSHUB_BUN=$(command -v bun) node --test tests/integration/phase3.test.mjs` **10/10 通过**，随后 `bun test tests/e2e/tui.test.tsx tests/e2e/phase5.test.tsx tests/e2e/mouse-sidebar.test.tsx` **19/19 通过**，0 失败/跳过。证据目录 `/tmp/hhu-phase3-EBfeDa`、`/tmp/hhu-phase5-ui-3lc3ei`、`/tmp/hhu-mouse-sidebar-YnzCAe`。这 29 项是独立提交快照的定向复核，不将此前混合工作区的 133 项测试宣称为本次隔离快照的完整回归。
