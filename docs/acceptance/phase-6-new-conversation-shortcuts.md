# Phase 6：新会话快捷键

日期：2026-11-05。仅补充当前阶段交互，不实施下一阶段。

## 行为与边界

- 选中 Project 或该 Project 下的 Conversation，且不在聊天输入、聊天历史、Changes 或弹窗内时，`n` / `N` 在该 Project 的共享根目录创建新会话，不继承被选会话的独立 Worktree。
- `Ctrl+N` 在本次 CLI 启动时捕获的 cwd 创建独立 Conversation；`projectId=null`，绝不注册隐藏项目。TUI、聊天输入及聊天历史可用，顶层弹窗保留键盘所有权。
- 独立会话显示在侧栏顶层，支持最近选择恢复、历史、草稿、重命名、归档、删除和正常 ACP 生命周期。Workspace 经服务端绝对路径及 realpath 校验后落 SQLite；Worker 和 `session/new.cwd` 仍从会话读取，不取 Daemon cwd。
- 新建前持久化现有草稿，创建操作有 busy 防重复。成功后选择新会话并进入输入。旧 AgentPane 的销毁回调不得清除新选中会话的输入状态；WS 导致所选项消失时由 App 重置状态。
- 不发送 Prompt、不改原生 Agent 配置、不改变审批、取消、Handoff 或自动重放边界。不更新已安装的全局 `hhu`、不操作默认用户数据库。

## 文件与数据迁移

- `apps/cli/src/index.ts`、`apps/tui/src/index.tsx`：启动 cwd、快捷键上下文路由、创建流程、独立会话列表、命令面板和键位提示、焦点所有权。
- `apps/tui/src/project-tree.tsx`：允许没有 Project 的会话行，保留原有项目折叠及会话操作。
- `packages/shared/src/index.ts`、`packages/shared/src/session-state.ts`：nullable Project DTO/Activity、新建路径校验输入，以及保留 `Ctrl+N` 避免配置冲突。
- `apps/daemon/src/index.ts`、`packages/core/src/index.ts`：新增 `POST /v1/conversations`，只接受显式 `workspacePath` 和可选 `title`，无项目时不支持托管 Worktree。
- `packages/storage/src/index.ts`、`packages/storage/src/schema.ts`、`packages/storage/migrations/0006_absurd_richard_fisk.sql` 及迁移元数据：schema 6 → 7，允许 `project_id=null`。迁移仍先私密备份，在 Drizzle 事务中重建 Conversation；事务开始前临时关闭 FK，避免 DROP 级联删除历史，事务末尾用 `pragma_foreign_key_check` 和 CHECK 约束拒绝不完整迁移，finally 恢复 FK。已有依赖历史、草稿及偏好保留。
- `tests/integration/standalone-conversations.test.mjs`：迁移、外键/备份、路径校验、Mock ACP 两种 cwd、重启持久化、归档及删除；`phase1`–`phase6` 的迁移断言跟随真实 journal 长度，不再固定旧 schema 6。
- `tests/e2e/new-conversation.test.tsx`、`tests/e2e/shortcuts.test.ts`、`scripts/test.ts`：焦点路由、输入保留、项目/子会话创建、启动目录隔离、快速重复按键及快捷键冲突检查。
- `tests/e2e/new-conversation-terminal.py`：可重复执行的真实 Linux PTY；`README.md`、`docs/01_ARCHITECTURE.md` 及 Phase 6 索引记录新入口和架构例外。

## 自动化与实际终端

已执行：

```bash
bun run db:generate
bun run typecheck
bun run lint
bun run build
bun test tests/e2e/shortcuts.test.ts tests/e2e/new-conversation.test.tsx --timeout 15000
HARNESSHUB_BUN=/home/clj/.local/bin/bun node --test --test-concurrency=1 tests/integration/standalone-conversations.test.mjs
umask 022; bun run test
python3 tests/e2e/new-conversation-terminal.py /home/clj/.local/bin/bun /home/clj/HarnessHub/HarnessHub/dist/cli/hhu.js
git diff --check
```

- 类型检查、Biome、构建和 diff 检查通过。定向 UI 5/5、336 断言通过，证据 `/tmp/hhu-new-conversation-mmG2dC`；定向集成 2/2 通过，证据 `/tmp/hhu-standalone-eSxSPm`。随后新增的同一 Daemon 不同启动目录、快速重复创建及历史中 Ctrl+N 断言纳入完整回归。
- 完整集成 **96/96 通过**，日志 `/tmp/hhu-new-shortcuts-full-test-final.log`。该轮 UI 暴露两项焦点/时序失败，修复后按 `scripts/test.ts` 的同一 12 文件列表单独重跑全部 UI：**89/89 通过、1146 断言**，日志 `/tmp/hhu-new-shortcuts-ui-final.log`；新增 UI 证据 `/tmp/hhu-new-conversation-0G0Aj1`。合计 185 项通过，但不将较早非零退出的聚合命令说成一次通过。最终再次 typecheck、lint、build、diff 检查通过。
- 最终构建的真实 Linux PTY 通过，证据 `/tmp/hhu-new-conversation-pty-n77kr3mn/evidence.json` 及同目录 `terminal-*.bin`（前一轮 `/tmp/hhu-new-conversation-pty-5uslwpg8` 亦通过）：小写 n / 大写 N 创建项目会话、聊天字母不触发创建且草稿保留、Ctrl+N 在两个不同的 CLI cwd 分别创建独立会话、零隐式项目、零 Agent 调用、两次 TUI 退出后 Daemon 仍存活。
- 故障记录：沙箱内首次测试无法启动监听端口的 Daemon，经批准在隔离临时数据目录重跑；UI 回归发现旧 Pane cleanup 清除新会话焦点，已修复。完整 UI 又发现归档/恢复同步不能关闭用户新打开的全局命令面板，现仅清理旧会话拥有的表单状态；新增测试也等待真实 Esc 解析完成再操作下一控件，两项定向复跑及完整 UI 均通过。首轮完整回归暴露旧迁移测试的 schema 6 硬编码并导致依赖初始化失败，修正为实际迁移日志长度后重跑。PTY 脚本首轮匹配了不存在的输入标题，修正为实际 `Enter send` 提示后通过。没有以删测或放松数据保留、外键及权限断言规避失败；原先“所有普通字母无动作”的断言只移除新增的 n/N 例外，其创建及聊天输入语义由新用例覆盖。

## 未验证与用户验收

- Windows Terminal / VS Code WSL 物理键盘 **未验证**。手动步骤：选中项目按 n；选中该项目会话按 Shift+N；确认各创建一个同项目根目录会话。进入聊天输入键入 `nN`，确认只输入；按 Ctrl+N，确认切到独立会话且原草稿仍在。顶层搜索/设置弹窗中两种按键不应创建会话。
- 已安装的全局命令 **未更新、未验证**。使用安全升级流程安装后，从目录 A 和目录 B 各启动一次 `hhu`，在同一个 Daemon 下按 Ctrl+N，确认新会话分别绑定 A/B，退出再开仍可恢复。升级不得强制结束正在运行的任务。
- 本轮未调用真实 ACP Agent。工作目录协议验证使用本地 Mock ACP；本功能不涉及新的 Agent 协议方法，不扩大已有真实 Harness 能力矩阵的结论。
