# Phase 6：稳定性、安全加固与最终 MVP 验收报告

日期：2026-10-31（环境日期）。最终源码版本 **0.6.0**，SQLite **schema 6**。不新增持久化字段或修改已有 migration。**工程交付不等于最终 MVP 全部通过：OpenCode 本轮真实消息超时，Windows Terminal / VS Code WSL 物理终端尚待用户验收。**

## 1. 开发前审查与差异

阅读 AGENTS、架构、实施计划、COMPATIBILITY、Phase 1–5 与 Phase 4 Refinement，检查 Runtime、Handoff、Worktree、Storage、Daemon/CLI/TUI、安装器和真实验证脚本。复用现有 ACP Client、requestId/hash、Draft CAS、审批原子决策、事件 seq 和 WS 补拉；没有重构 ACP Runtime 或更换技术栈。

| 原有实现 / 差异 | 本阶段处理 |
| --- | --- |
| 单实例、退出保活、取消、Handoff/Worktree 主要闭环已有 | 保留并运行全部既有回归，补充关停/进程释放竞态 |
| FAILED Handoff 在 cancel-active 中调用被 closing 拒绝的用户 action，可能让 Runtime 一直 closing | 内部取消直接结束未投递预留；关停的异常路径统一恢复 closing，保留 requestId |
| Adapter 已退出但后代仍占用管道，旧 stop 可能只看 exitCode 报成功 | 等待真实 child close / stdio 排空；未确认退出保留句柄，force 仍须显式确认 |
| 准备中的目标 Worker 若取消释放失败，句柄可能丢失 | 准备期间也保留受控句柄，激活/确证释放后才移除 |
| Worktree 用有界同步 Git，最慢可阻塞事件处理 15 秒以上 | 改成异步 argv Git；跨 await 预留 Project/Workspace，防重绑、重复清理和关停竞态 |
| 文件权限已有，但读取实例/打开库前缺少完整归属/链接检查 | 检查当前用户、regular file、symlink/hardlink；私有目录/文件修正为 0700/0600 |
| 日志只轮转一份；缺少完整导出 | 1 MiB + 5 份历史；Markdown chat 和含 raw ACP 的 debug 导出，目的文件只以 0600 新建 |
| 安装器仅探测健康，检查与构建之间有竞态 | 构建至原子替换 launcher 全程持同一 Daemon flock，无响应/无元数据但持锁也拒绝 |
| doctor 对入口与握手区分不够直接 | 默认仅入口，显式 doctor --acp 指定 Conversation/Harness 才握手，零默认 Prompt |
| 迁移备份已有，缺少失败注入证据 | 验证 Drizzle 全部 pending SQL 事务回滚；旧库/备份可恢复，不自动覆盖旧库 |

不增加 Web UI、模型代理、Key 管理、自动审批、RAG、Redis、独立 Runner、市场或在线更新。

## 2. 文件清单

- `packages/acp/src/index.ts`：Worker 真实退出/stdio 确认；doctor 的 Node Adapter runtime 参数。
- `packages/core/src/runtime.ts`、`handoff.ts`：FAILED Handoff 受控取消、closing 异常恢复、准备目标句柄保留、确证退出保护、源 Worker Profile 编辑保护、Worker PID/进程组/epoch 审计事件。
- `packages/core/src/worktrees.ts`、`index.ts`、`packages/storage/src/index.ts`、`apps/daemon/src/index.ts`：异步 Git、操作预留与路由 await；关停等待 Git 操作；库/WAL/SHM/备份权限和链接检查。
- `packages/shared/src/paths.ts`、`client.ts`、`runtime.ts`：0700/0600、归属/链接检查、有限日志轮转、Token 实例文件检查、health 的 instanceId/PID 验证、结构化秘密字段脱敏。
- `packages/storage/src/runtime.ts`、`apps/daemon/src/runtime-routes.ts`、`apps/cli/src/agent.ts`：完整 chat/debug 导出、来源、Markdown 连续流合并、显式文件写入不覆盖。
- `apps/cli/src/index.ts`、`lifecycle.ts`、`scripts/install-local.ts`：环境/显式握手诊断、查看全部保留日志、安装 flock 与原子启动器。
- 根及七个 workspace `package.json`、`bun.lock`、`packages/shared/src/index.ts`：版本 0.6.0；CLI 增加内部 ACP workspace 依赖；第三方依赖版本不变。
- `scripts/build.ts`、`test.ts`、`verify-phase6.mjs`、`tests/integration/phase6.test.mjs`、`tests/fixtures/mock-acp/server.mjs`、`descendant.mjs`、`tests/fixtures/git-fail/git`：构建测试辅助库、14 项回归与隔离真实 Harness 验证。
- `tests/integration/phase1.test.mjs`、`phase4.test.mjs`：只更新当前发行版本断言，未删除旧测试或弱化安全断言。
- `README.md`、`docs/COMPATIBILITY.md`、`docs/OPERATIONS.md`、本报告及 `docs/acceptance/windows-terminal-checklist.md`：使用、兼容性、升级恢复及双终端人工验收。

未改写 Phase 1–5 验收记录；未安装或覆盖用户默认全局 launcher/数据库，没有创建 Git commit。

## 3. 自动化命令与实际结果

实际运行：

```bash
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run build
bun run test
git diff --check
```

冻结安装、双 Node/Bun 类型检查、Biome、构建和 diff 检查通过。完整测试 **70 项 Node 集成 + 32 项 Bun/Solid UI，共 102 项，0 失败、0 跳过**；Phase 1–5 的 88 项全部保留，本阶段增加 14 项。完整日志 `/tmp/hhu-phase6-full-final.log`；最终复跑日志 `/tmp/hhu-phase6-full-final2.log`（最终证据目录以日志输出为准）。

收尾再次运行冻结安装（259 installs / 354 packages，无改动）、typecheck、lint、build 和 diff 检查，全部通过。对最终 Phase 6 测试文件单独执行 `HARNESSHUB_BUN="$(command -v bun)" node --test --test-concurrency=1 tests/integration/phase6.test.mjs`，**14/14 通过、0 失败/跳过**，耗时约 42.7 秒；日志 `/tmp/hhu-phase6-checkpoint-final.log`，证据 `/tmp/hhu-phase6-j41cLw`。该复核是上述 102 项中的 14 项，不另计为新增用例。

| 新增回归 | 实际验证 |
| --- | --- |
| 导出 | chat 无 raw、debug 有完整 ACP；Markdown 原文、来源、工具；CLI 0600 新文件及 EEXIST 拒绝覆盖 |
| 长期日志 | 实际触发十次写入/多代轮转，核对保留数量、历史内容及每份 0600 |
| 迁移失败 | schema 6 私有数据 + 注入第七 migration，先建表再故意失败；全部 SQL 回滚、schema 仍为 6、integrity_check=ok、备份可读取恢复 |
| 文件安全 | 打开前拒绝数据库 symlink，外部文件内容及 0644 不变；已有权限修复至 0700/0600 |
| 敏感信息边界 | Authorization/Cookie/API key/AWS secret/password/clientSecret/accessToken 在 raw、normalized、debug 脱敏；tokenCount 和普通源码/中文原文保真 |
| 后代进程 | 真实 Adapter 退出、顽固后代继续持管道时普通 stop 必须拒绝，不能报成功；只有测试对隔离进程组显式 force 才结束 |
| 显式诊断 | doctor --acp 真正握手；默认 doctor 前后 Prompt 数不增加 |
| 本机鉴权 | 错误 Bearer、带 Browser Origin 的 WS 拒绝；instanceId 替换被客户端拒绝 |
| FAILED Handoff 停机 | cancel-active 取消未投递预留，重启保持 CANCELLED、无 Prompt 重放，Runtime 可接新任务 |
| 安装锁 | 无实例元数据但内核锁被持有仍拒绝安装，构建产物 mtime 不变 |
| 源清理失败 | 接管后源退出未确认，保留句柄/cleanup_failed；阻止删除及停机；不误杀另一 Conversation；开放测试 gate 后合作式退出 |
| 慢 Git | add/remove 各延迟 1.8 秒时 health <1 秒；项目删除/重绑、重复创建/清理、绑定删除中目录及关停被拒绝；安全完成后保留分支 |
| 用户级安装 | 临时 HOME/XDG 真实 install:local、原子 launcher 0755、从 Home 运行版本/Daemon；旧版本元数据模拟下拒绝覆盖，安全停机后可重复安装 |
| Git 边界 | 无 HEAD 仓库不绑定 Conversation；真正 Git worktree lock 阻止清理；解锁普通清理保留源码根和分支 |

故障记录不掩盖：早期 doctor 文案改变导致既有 Phase 1 正则断言失败，已恢复原诊断标识并保留更精确的信息；直接运行 Node 定向测试时漏设 HARNESSHUB_BUN 曾失败，使用与标准 runner 相同环境后通过。开发中 typecheck/格式检查失败已修复。没有删除旧测试、降低审批/UNCERTAIN/安全清理断言或自动重发失败任务。

## 4. Daemon / Worker / Handoff 异常恢复

单 Daemon 的 kernel flock、Bearer Token、实例身份、Origin/WS 鉴权保留。TUI 退出只关闭客户端，Linux PTY 与 renderer 继续覆盖 Ctrl+C 三种优先级、SIGINT、鼠标复制和后台保活。正常 stop 拒绝活动 Turn；cancel-active 发原生取消、等待最终响应和尾部事件，不升级为自动 SIGKILL。

源/目标初始化、配置、审批、取消、删除、关停与接管使用原有串行边界和原子状态/CAS。Worker 的连接关闭、Adapter exitCode 和完整管道生命周期分开处理；未确认释放保留句柄和 endedAt=null。源释放失败不撤销已提交目标，不误杀其他 Conversation。准备目标取消时也保持可追溯句柄。

旧测试实际 SIGKILL 隔离 Mock Daemon，分别覆盖普通运行、审批、GENERATING 和 DELIVERING。恢复只读取 SQLite，Turn/Handoff 为 UNCERTAIN、Session 为 INTERRUPTED、旧审批失效。READY/PENDING 保留未投递预留并要求显式操作；UNCERTAIN 不能经重试、重连、确认降级重发。requestId、Draft CAS、审批一次决策和 seq 去重机制均保留。

新增 runtime.worker_started 记录 PID、进程组和 epoch 供事故检查；它不是重连或自动杀进程凭据。Daemon 异常退出后原生进程可能仍有副作用，必须人工核查，不伪装继续运行。

## 5. 数据安全、日志与导出

默认 XDG HarnessHub 目录 0700；SQLite/WAL/SHM/备份、Token 实例、锁、应用日志 0600。拒绝不属当前用户、非 regular file、symlink/hardlink 的私有文件；在 SQLite 打开前检查，避免先操作用户外部目标。客户端不从公开权限或 symlink 实例文件读取 Token；HTTP health 对照 instanceId、PID、版本/协议，不能只因监听 127.0.0.1 就信任客户端。

日志仅固定短诊断，不复制 Prompt、工具结果、Worker stderr、Token 或环境值。应用/启动日志约 1 MiB 轮转，各保留 5 份历史；不依赖无限 stdout 输出。备份不自动删除，需用户管理。

`hhu agent export <id> chat conversation.md` 输出可读 Markdown；`debug debug.json` 输出含全部 raw/normalized、来源/用途/seq、Session、Turn、审批和 Handoff 的 JSON。chat 合并连续文本，不把内部报告/背景回显伪装成用户聊天；完整报告与 fallback 来源单独保留。未知可观察内容也可追溯。新文件权限 0600，拒绝覆盖；无目的路径则输出到终端。API 为 `/v1/conversations/:id/export?format=chat|debug`，支持 readable/raw 别名及 `/v1/export/conversations/:id` 路由。

**脱敏限于已知结构化字段，普通 Markdown、源码、工具字符串不改写，也可能含秘密。** 导出不额外加入 Daemon Token 或 Profile 环境值，不能声称导出天然不含敏感信息。归档/恢复/删除继续经 SQLite 和元数据事件同步，删除级联清理应用数据但不删除源码、分支或 Worktree。

## 6. 用户级安装、升级与迁移

安装仍为 `~/.local/bin/hhu`，无需 sudo，Bun CLI/TUI + Node Daemon。锁保护覆盖检查、构建、launcher 原子替换全程；活动/无响应/启动中的 Daemon 均不能被强制覆盖。临时 HOME/XDG 已真实测试从 Home 调用 installed launcher 和安全重复安装；没有替用户更新默认库/launcher。新 0.6.0 客户端拒绝把旧版本 Daemon 当成当前实例；可认证并验证同协议身份后正常请求停止。

schema 5 → 6 的旧 SQL 数据升级测试继续通过；0.5.0 → 0.6.0 保持 schema 6，因此无新增迁移。需要迁移时先 online backup 0600，再用锁定 Drizzle 的全 pending SQL 事务；注入 SQL 故障证明回滚后无半迁移表、旧数据仍可打开，私有备份可恢复。不执行自动覆盖式恢复，更高 schema 拒绝打开。

完整先决条件、PATH、安装/安全停止/升级、拿同一 flock 后保留失败库及 WAL/SHM 的备份恢复、故障排查，见 [操作指南](../OPERATIONS.md)。

## 7. 四个真实 Harness 本轮兼容性矩阵

实际运行 `node scripts/verify-phase6.mjs`，在私有临时 XDG/项目读取 sentinel、打印 pwd、返回原文 Markdown，并单独测试 Prompt 取消。**未读取/修改任何原生模型/Key/Base URL 配置，也未选择权限选项。** 证据 `/tmp/hhu-real-phase6-mwxQPP/evidence.json` 及各 Harness `*-debug.json`；四个 Worker 最后合作式停止。

| Harness | 真实安装版本 / ACP 入口 | initialize / session/new / cwd | 消息、工具与原始内容 | 本轮取消 | 原生配置与审批 | 恢复 / Handoff |
| --- | --- | --- | --- | --- | --- | --- |
| Codex | PATH CLI 0.166.0；Adapter 2.5.0 `codex-acp` / 固定包 dist/index.js，锁内 Codex 0.165.0 | 通过；两个 cwd 为临时项目 | COMPLETED，1 个工具调用，完整 sentinel/Markdown 与原生警告保留 | CANCELLED / cancelled | mode、collaboration_mode、model；未返回独立 effort；本轮未遇审批 | 宣告 loadSession/resume，实际恢复未验证；真实 A→B→A 通过 |
| Claude Code | CLI 2.1.311；Adapter 0.99.1 dist/index.js，SDK 0.3.312 | 通过；cwd 正确 | COMPLETED，2 个工具调用，中文/Markdown 原文保留 | CANCELLED / cancelled | mode、model、effort、ultracode；本轮未遇审批；Phase 2 历史有真实用户审批证据 | 宣告 loadSession/resume，实际恢复未验证；本轮 Handoff 未验证 |
| Grok Build | **1.0.70 (f50904eaee6c)**，`grok agent stdio`（不同于 Phase 2 的 1.0.50） | 通过；cwd 正确；本次无 agentInfo，用 CLI 版本为证 | COMPLETED，2 个工具调用，sentinel/Markdown 保留 | CANCELLED / cancelled | 仅 model；mode/effort 未返回；本轮未遇审批 | 宣告 loadSession/resume，实际恢复未验证；真实接力目标/源均通过 |
| OpenCode | **1.18.32**，`opencode acp` | 通过；cwd 正确 | **未通过：等待 120 秒仍 RUNNING，0 工具、0 Agent 文本**；保留 13 个原始事件 | 发 cancel 后返回 end_turn，记录 COMPLETED；不冒充 cancelled | model、mode 返回；effort 未返回；未遇审批 | 宣告 loadSession/resume，实际恢复/Handoff 未验证 |

取消测试在 Prompt 后约 1.5 秒发送 ACP cancel；前三者证明本轮 Prompt 取消路径，不代表所有工具运行中/审批中取消都已真实验证。原生审批 Mock 回归通过，但不能用未发生审批的真实任务宣称四者审批全部通过。Client fs/terminal 仍如实为 false，Agent 自有工具不被改写。

OpenCode 本轮无原始 ACP error 或权限请求，取消后 usage used=0，没有足够证据归因为账号、网络或某项原生设置。**保留真实超时，未自动重试/重发，未改模型或读其配置。** Phase 2 的成功不能覆盖当前失败。当前来源包含的 available_commands 描述不是对本 Agent 的操作指令，未执行其中的配置操作。

## 8. Codex → Grok → Codex 再次真实联调

本阶段实际再次执行 `node scripts/verify-phase5.mjs`。最终 **0.6.0 验证 passed=true**，证据 `/tmp/hhu-real-phase5-B5O8Ac/evidence.json`，执行日志 `/tmp/hhu-phase6-real-handoff-final.log`；较早一次通过的证据为 `/tmp/hhu-real-phase5-7ngjnb`。隔离临时 Git 项目、独立 Worktree、同一 Conversation 三段不同 NativeSession，5 次 Prompt（3 用户 + 2 内部报告），progress.txt 的 stage=1 → 2 → 3，两个 Handoff COMMITTED，零重复任务。最终证据确认 `backgroundSurvivedTuiExit=true`，脚本最后正常停止验证 Daemon，实例文件已移除。

检查每次只选目标后 Prompt 数不增加；同 Harness 连续复用和返回新 Session 由 Mock 及真实三段身份共同核对；报告九章节、原始用户消息和报告来源区分、TUI 报告展开/完整复制、后台 TUI 退出保活、真实 raw→normalized 对应均验证。未遇原生审批，不将其记为真实审批通过。目标最终响应才提交接管，源正常合作式释放，不自动回退重发。

## 9. Git Worktree 最终安全结果

全部 Git 变更实验只在临时仓库执行。shared 默认、并行冲突提醒保持，不做全局 Agent 锁或修改归属推断。独立 Worktree 的路径/分支/Git 登记与 Worker cwd、ACP cwd、Changes、Handoff 一致。创建先 CREATING 再 Git 与归属核验；崩溃/部分失败保存 ERROR，不自动回滚删除。

异步 Git 仍使用 argv、15 秒/2 MiB 边界、禁用 hooks，无 force、-B 或分支删除。新操作预留只覆盖 Git 管理期间的相关 Project/路径，不阻止不同 Conversation 的正常共享并发。慢 Git 时 health 可响应；不能删除/重绑被创建中的项目、把 Conversation 绑定到删除中路径、重复清理或在 Git 运行时停止 Daemon。

实际测试非 Git/无 HEAD、分支/路径竞争、部分创建、归属/分支变化、dirty/untracked/ignored、Git lock、关联 Conversation/子目录、未登记目录与崩溃遗留状态。删除 Conversation 不删 Worktree/分支；CLEAN 确认后只调用普通 Git remove，分支保留。外部 Git/用户文件修改与检查不构成原子快照；最终由非 force Git 再次把关。

## 10. TUI 与 Windows 人工验收

OpenTUI/Solid 极简树状 TUI 保留，未新增框架。32 项 UI + Linux PTY 验证树/命令面板、多会话/审批通知、Markdown/工具/思考/计划、普通聊天控制事件过滤、Raw Debug、工具折叠、Changes、滚动、归档/恢复/删除同步、报告复制及草稿/断线恢复。

Ctrl+C 的选区复制 → 非空清空 → 空输入退出优先级不变，退出不停止后台；拖选松开自动复制、双击词/三击行、Enter 一次发送、Shift+Enter 换行、Ctrl+J fallback 和完整原文复制的自动化全部保留。

**Windows Terminal 和 VS Code WSL 的物理键盘/鼠标/系统剪贴板均未验证。** [详细 33 项人工清单](windows-terminal-checklist.md) 为两种终端分别保留版本、操作、预期和结果栏；包含所有上述行为、中文长文/代码粘贴、Resize/窄布局、后台并发、Handoff 正常/失败/UNCERTAIN、Worktree CLEAN 和草稿/归档/Debug。用户应分别填写，空栏不是通过。

## 11. 已知问题、限制与未验证项

1. OpenCode 当前真实消息无输出超时，取消返回 end_turn；原因未明，未宣称其完整真实功能通过。
2. Windows Terminal / VS Code WSL 33 项物理验收尚待用户完成，Linux PTY 不能替代。
3. Claude/OpenCode 本轮真实 Handoff 未验证；四者原生 load/resume 仅宣告，HarnessHub 不实施自动恢复。
4. 本轮真实任务均未遇审批；仍依原始 Agent 选项由用户决定，Mock 原子审批/取消测试不能替代四者所有真实权限场景。
5. 数据库/备份/导出不做静态加密；普通原生文本可能含秘密。长历史完整导出会占用与历史量相关的内存，UI 挂载有界不等于原始事件内存有界。
6. Daemon 异常退出后 Agent 可能仍存活；UNCERTAIN 不自动解锁/重放。只能可靠托管可观察的子进程/管道生命周期，不能保证终止 Harness 自行再 detach 且关闭所有关联管道的不可观察后代；不凭猜测杀其他进程。
7. 源报告不保证无损，HarnessHub 不能可靠沙箱化 Agent 自有工具；报告期间观察到工具仍按原机制阻止自动接管并要求明确降级确认。
8. 安装测试为临时 HOME/XDG 和旧版本元数据模拟，未覆盖用户实际全局安装或默认库。已测安全流程不代表替用户升级完成。
9. WSL 关闭/重启 Windows 不保证后台存活；备份不自动删除，没有自动更新/预编译发行包。

## 12. MVP 验收结论

当前交付 0.6.0/schema 6 稳定性和安全实现、完整自动化回归、真实 Codex/Claude/Grok 消息/取消与 Codex→Grok→Codex 证据，以及安装/恢复指南和用户人工清单。**最终 MVP 验收仍未完成**：必须处理/确认 OpenCode 真实兼容性问题，并由用户完成两种 Windows 终端人工验收，才能作最终全部通过的结论。
