# Desktop Phase 4 补充：独立归档窗口

2026-11-10。用户要求归档对话不再显示在项目中，改用独立窗口查看。本次仅调整现有 Desktop 阶段的归档呈现。

## 实现与文件

- `apps/desktop/src/renderer/App.tsx`：左侧项目及独立会话列表始终只显示 `archivedAt === null` 的对话，项目计数也只统计这些对话。“查看归档”打开模态窗口，不切换或替换项目树。
- `apps/desktop/src/renderer/ArchiveDialog.tsx`：单独列出所有已归档对话，按归档时间倒序排列，显示原属项目或“独立会话”。可按标题、项目名、Harness 搜索；搜索与侧栏独立。查看历史成功后关闭窗口，保留归档状态；恢复成功后从归档列表移除并返回原属项目或独立会话列表。数据继续来自实时快照。
- `apps/desktop/src/renderer/style.css`：归档窗口、列表及窄窗样式。使用原生 `dialog.showModal()` 管理焦点，可通过关闭按钮或 Esc 返回；提交期间禁用重复操作，失败在窗口内显示错误，断开时禁用查看及恢复。
- `apps/desktop/tests/windows-new-conversation.ts`：更新原归档回归，覆盖项目树隔离、归属说明、搜索、只查看不恢复、实时恢复、空态、Esc、独立会话及窄窗。

复用已有 select / conversation.patch IPC、同一 WSL SQLite 和快照订阅；没有新增数据库或 ACP 接口。保留工作区中已有的设置、新建会话与 TUI 改动。

## 验证

```bash
bun run typecheck
bun run lint
bun run desktop:test
HHU_DESKTOP_NEW_ONLY=1 bun scripts/verify-desktop-windows.ts
git diff --check
```

- 类型检查、全仓 lint、后端构建、Desktop 构建和 diff 检查通过。
- Desktop 单元测试 **61/61**、Node 集成测试 **16/16** 通过。
- 真实 Windows x64 Electron **45.2.3** + WSL2 验证通过。使用隔离 XDG/SQLite/userData 与受控 Mock ACP，归档后的项目树不含目标对话；打开窗口不改变项目树；按原项目名搜索、查看归档历史后保持归档、恢复后回到原列表、空态与 Esc 均通过。独立会话归档恢复及 1440×940 / 720×780 窗口检查通过，已人工查看捕获截图。
- 本轮未运行全量 TUI 测试，未重新验证真实远端 Agent；没有更改 TUI 或原生运行协议。未安装或替换用户当前 Desktop 应用。

构建、测试及 Windows 日志、机器结果、宽窄截图保存在 [evidence/desktop-archive-window](evidence/desktop-archive-window/)。真实 Windows 原始证据位于 `/mnt/c/Users/31970/AppData/Local/Temp/hhu-desktop-smoke-a2DOFy`；隔离后端位于 `/tmp/hhu-windows-smoke-dUdJuX`，验证脚本已正常关闭该测试 Daemon。

## 推送前独立复核

用户要求 push 后，仅暂存归档功能对应代码、测试及验收资料。以当时 HEAD `d3065e2` 为基准，在 `/tmp/hhu-archive-push-2u_dnmy2` 应用暂存补丁，未加入其他进行中的 Desktop 设置、布局和共享分支修改。该独立版本的 typecheck、lint、后端及 Desktop 构建、61 个单元测试、16 个集成测试均通过；真实 Windows 归档交互再次通过，证据 `/mnt/c/Users/31970/AppData/Local/Temp/hhu-desktop-smoke-94KBbY`，隔离 WSL 数据 `/tmp/hhu-windows-smoke-H39XC7`。最终日志及机器结果使用 `hhu-archive-push-*-final.log`、`push-evidence.json` 保存于同一证据目录。

第一次隔离检查的依赖软链仍指向原工作区，混入了并行 Core 共享分支行为，导致 1 个旧接口拒绝测试失败；将工作区包链接改为隔离目录内的包后，重新构建并完成上述通过验证。失败日志保留于 `/tmp/hhu-archive-push-desktop-test.log`，不将第一次结果当作独立版本验收。

## 用户待验收

1. 在新版桌面端归档一个项目对话，确认项目树中立即消失，项目数量同步减少。
2. 点击“查看归档”，搜索并查看对话历史，确认不会自动恢复；再从窗口中恢复，确认回到原项目。
3. 对独立会话执行同样操作，检查窗口关闭、键盘焦点及日常屏幕缩放体验。
