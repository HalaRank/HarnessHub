# Desktop Phase 4 补充验收：共享目录选择分支

2026-11-10。用户要求 Windows App 未勾选“创建工作树”也能选择分支。本次仅扩展当前 Desktop 阶段。

## 行为和文件

- `apps/desktop/src/renderer/NewConversation.tsx`：Shared / Worktree 均可选择真实本地分支，切换工作树开关保留选择。只选择分支不调用 Git；首次发送传递所选分支。Shared 模式说明实际切换将影响其他使用该目录的会话。非 Git、无提交和加载中仍不开放分支操作。
- `packages/core/src/index.ts`：复用 `conversation.create.baseBranch`。Shared 模式验证本地 branch ref，必要时使用 `git switch --no-guess --no-overwrite-ignore` 切换，再同步绑定共享根目录。预留项目与整个仓库路径，阻止重叠 Workspace 的新操作；实际切换前检查相关会话运行、审批、Handoff 和 UNCERTAIN 状态。相同分支允许并行建会话。拒绝隐藏改动的 index flags，不强制切换、stash、重置或创建用户分支。已有 Worktree 路径与未传分支的调用保持既有语义。
- `apps/desktop/tests/new-conversation.test.tsx`、`tests/integration/desktop.test.mjs`：验证 Shared / Worktree 参数、实际分支文件内容、无效引用、tracked / untracked / ignored 冲突保留、隐藏 index flags、活动 Turn 拒绝切换、同分支并行、其他 Worktree 占用、游离 HEAD 和失败后预留释放。
- `scripts/verify-desktop-windows.ts`、`apps/desktop/tests/windows-new-conversation.ts`：隔离 Git fixture 新增不同内容的分支；真实 Windows UI 验证未勾选工作树可选择、开关保留选择、发送前分支保持、发送后实际切换、Shared Workspace / NativeSession.cwd 和单次消息投递。

Git 参数核对了 [git-switch](https://git-scm.com/docs/git-switch)、[git-checkout](https://git-scm.com/docs/git-checkout) 和本机 `git switch -h`。`--no-overwrite-ignore` 用于防止 Git 默认覆盖 ignored 文件。

## 验证

- `bun run typecheck` 通过，最终日志 `/tmp/hhu-shared-branch-typecheck-complete.log`。
- `bun run lint` 与 `git diff --check` 通过，日志 `/tmp/hhu-shared-branch-lint-complete.log`。
- `bun run desktop:test` 通过：后端 / Desktop 构建、61 个 Desktop 单元测试和 16 个 Node 集成测试。日志 `/tmp/hhu-shared-branch-desktop-test-final.log`，隔离后端 `/tmp/hhu-desktop-integration-XyNVHg`。本次共享分支专项测试包含上文列出的真实 Git 与活动 Mock ACP Turn 检查。
- `HHU_DESKTOP_NEW_ONLY=1 bun scripts/verify-desktop-windows.ts` 通过真实 Windows x64 / Electron 45.2.3 / WSL2 定向交互，`passed=true`。日志 `/tmp/hhu-shared-branch-windows-final.log`，Windows 现场 `/mnt/c/Users/31970/AppData/Local/Temp/hhu-desktop-smoke-BgHyDW`，隔离 WSL 数据 `/tmp/hhu-windows-smoke-Pz2N5W`。结果与截图保存在 [`evidence/desktop-shared-branch/`](evidence/desktop-shared-branch/)。
- `bun test tests/e2e` 通过，122 个 TUI 测试，日志 `/tmp/hhu-shared-branch-tui-test.log`。
- `bun run test` 的后端构建通过，Node 回归 119 项中 118 通过、1 失败，因此命令整体失败。失败为既有 `built hhu cold-starts from home in two real PTYs; closing clients keeps the Daemon alive`：`tests/e2e/terminal.py:82` 等待 `Add existing project` 超时；日志显示增量终端重绘将标题分块输出为 `Add existi` / `g project`，探针仅移除 ANSI，不能还原光标覆盖后的屏幕。该路径不传分支或创建 Worktree，本次不改动该探针与 TUI。完整日志 `/tmp/hhu-shared-branch-test.log`；由于总脚本在 Node 失败后不启动 TUI 检查，已另行运行上面的 122 项 TUI 测试，不能将本轮全仓回归宣称全部通过。

初次 Windows 探针在重复 `executeJavaScript` 中使用全局 `const s` 导致探针抛错；为新增脚本加函数作用域后重跑通过，保留失败日志 `/tmp/hhu-shared-branch-windows.log`。过程中工作区其他 Desktop 文件正在修改，短暂出现 `Environment` 缺少导入及格式检查失败；最终 typecheck / lint 已通过。此次不修改其他进行中的 TUI / Desktop 功能。

## 人工验收与边界

1. 在有多个本地分支的 Git 项目进入新建页，不勾选工作树，选择另一分支；确认出现共享目录影响说明，Git 尚未变化。
2. 开关“创建工作树”，确认已选分支保留。关闭后发送，核对实际 Git 分支与文件内容，Workspace 仍是项目根目录，未创建托管 Worktree。
3. 制造会覆盖本地修改的切换，确认显示失败、原文件保留、未发送首条消息。处理冲突后可手动重新发送；存在活动任务时先完成任务或改用 Worktree。

Shared Conversation 绑定目录，其他空闲会话后续会看到该目录的新分支；不保证每个 Shared 会话有独立分支。仓库外部的 Git / 编辑器操作不受 HHU 内部预留控制。真实 Harness、中文 IME、DPI 本轮未验证；Windows 使用受控 Mock ACP，不替代真实 Harness 验收。仅更新源码和构建产物，没有替换用户的安装目录或日常 Daemon。

## 推送前独立检出复核

从 `origin/main` 的 `d3065e2` 建立独立检出，仅带入本次共享分支选择相关实现、测试与证据，排除工作区其他 Desktop / 归档窗口改动。混合修改的 Windows 探针和架构文档仅提取本次新增内容。

独立目录 `/home/clj/HarnessHub/hhu-shared-branch-push-2t14jp/checkout`：`bun install --frozen-lockfile --ignore-scripts`、`bun run typecheck`、`bun run lint`、`bun run desktop:test` 和 `git diff --check` 均通过，Desktop 单元测试 61/61、Node 集成测试 16/16。日志位于该目录上层的 `install-final.log`、`typecheck-final.log`、`lint-final.log`、`desktop-test-final.log`，隔离后端 `/tmp/hhu-desktop-integration-ncRtsg`。本轮没有重复全仓与真实 Windows 探针，沿用上文注明的通过和失败边界。

首次在 `/tmp` 安装依赖因该 tmpfs 已满而失败；独立检出随后移至磁盘目录，并重新完成安装和检查。未删除其他会话的临时文件或更改日常安装。
