# Phase 6：最终独立审计修复（0.6.1）

日期：2026-11-02（Asia/Shanghai）。范围：用户明确要求修复最终审计 F01–F08；未进入 Phase 7。源码版本 0.6.1、SQLite schema 保持 6，第三方依赖版本不变。原 `official-final-audit.md` 保留为 0.6.0 的历史审计证据，不将原 FAIL 改写为通过。

## 修复及行为变化

| 审计项 | 修复 | 验证 |
| --- | --- | --- |
| F01 / P0：Worktree 文件丢失 | 拒绝 assume-unchanged/skip-worktree；cleanup 改为 Git move 到 `worktrees/retained/<UUID>`，状态 RETAINED。保留目录、Git 登记和分支，不自动物理删除。Git 移动后落库前中断只记 ERROR，用户明确重试时核对登记与目录再完成记录 | 真实临时 Git：两种隐藏修改均拒绝；预检后新增 ignored 文件仍保留；模拟移动/SQLite 边界中断后安全重试；TUI 等待 ACK 后核对保留文件 |
| F02 / P1：后代进程失管 | 分离直接子进程 close 与受管 Linux session 的进程组退出；核对 `/proc` 的 SID、PGID、leader starttime，防止对已观察到身份变化的进程组发信号。stdio 关闭但仍有活动后代时保留句柄；合作关闭失败仍需明确 force，只有该路径允许 SIGKILL | 真实 Node fixture：不持 ACP 管道的后代持续写入，普通 stop 必须拒绝；明确测试 force 后停止；合作后代正常退出；另一进程不受影响；原“后代持管道”测试继续保留 |
| F03 / P2：交接投递旧 fallback | 每次明确重试报告时清除旧 degraded/confirmedAt/fallback/generatedAt；生成的新报告绑定本次投递 | 源报告失败→确认降级→目标准备失败→报告重试成功，目标仅收到一次带 FRESH_REPORT 的 Prompt，旧 fallback 不发送 |
| F04 / P2：正常重启上下文丢失无提示 | 显式关闭活动原生 Session 时落 `runtime.context_ended` 并标 INTERRUPTED；正常 stop/start 同样持久可见。兼容恢复旧版已 CLOSED 但 Conversation 仍 IDLE 的记录 | 显式关闭、正常重启、模拟旧版本 IDLE/CLOSED 记录；历史保留，后续新原生会话没有假装恢复旧上下文，不重放 Prompt |
| F05 / P2：设置超时迟到生效 | HTTP/等待超时不释放配置锁。底层 ACP 请求真正结束后才更新能力、广播 settings_settled 并恢复 READY；明确确认 force 可关闭永不返回的配置请求，失效回调不能覆盖关闭状态 | 22 秒真实延迟：20 秒超时后新 Turn/设置均拒绝；迟到后显示/执行均为 new；永不返回时普通 stop 拒绝、未确认 force 拒绝、确认后安全关闭 |
| F06 / P2：失败安装混用产物 | 安装先在唯一 `dist/releases/.staging-<UUID>` 构建全部产物，完成后切换到独立发布目录，再原子替换 launcher。旧发布与失败 staging 保留，默认开发构建不覆盖已安装发布 | 在临时完整副本成功安装，修改共享版本并向 CLI 注入语法错误；失败后旧 launcher、CLI、Daemon hash 均不变，旧版本仍可从临时 Home 启停 |
| F07 / P3：外键断言假通过 | INSERT 明确列名，要求 `SQLITE_CONSTRAINT_FOREIGNKEY`，另有合法 parent 的成功插入/删除对照 | 现有 Phase 1 测试现在确实验证外键约束，列数错误不能冒充通过 |
| F08 / P3：跨 Turn 工具计数 | 新纯函数按 smoke Turn 合并工具及输出，要求 completed/成功 exit、工具原始输出中的哨兵和真实 pwd；不从 rawInput/用户文本/取消 Turn 取证 | 反例覆盖后来 Turn、失败工具、仅输入含 cwd；历史 Codex/Claude/Grok 已保存真实事件只读重放仍满足加强后的谓词 |

Worktree 的保留式清理**不释放文件占用的磁盘空间**，保留目录仍登记为 Git Worktree，分支仍在此处检出。自动删除无法排除外部写入者，用户应先检查保留目录和外部编辑器/构建进程，再自行决定物理移除。原始目录移动完成后，保留路径在 UI 通知和管理记录中可查。

0.6.1 的严格版本检查阻止新客户端将仍运行的 0.6.0 Daemon 当成当前契约。没有自动停止用户旧 Daemon、安装全局 launcher 或修改用户数据库；升级仍由用户在安全停止后执行 `bun run install:local`。

## 文件清单

- `packages/acp/src/process-group.ts`、`index.ts`：Linux 进程生命周期核对、超时错误类型。
- `packages/core/src/worktrees.ts`：保留式清理、隐藏 index 标志、双路径预留及中断恢复。
- `packages/core/src/handoff.ts`：重试时重置旧交接材料与确认。
- `packages/core/src/runtime.ts`、`packages/storage/src/runtime.ts`：未决设置所有权、迟到响应、确认关闭、原生上下文结束和旧记录恢复。
- `apps/tui/src/agent-pane.tsx`、`index.tsx`：设置完成后重新读取能力；保留目录说明、完成提示与路径。
- `scripts/build.ts`、`install-local.ts`：独立发布构建输出及原子安装；`smoke-evidence.mjs`、`verify-phase6.mjs`：同 Turn 的真实工具证据；`verify-opencode.mjs` 同步当前客户端版本；`test.ts` 纳入审计回归。
- `tests/integration/audit-fixes.test.mjs`、`tests/fixtures/mock-acp/audit.mjs`：9 项新增定向回归及确定性故障组合。
- `tests/fixtures/mock-acp/descendant.mjs`、`tests/fixtures/git-fail/git`：不持管道/合作后代，Git 移动后新文件注入。
- `tests/integration/phase1.test.mjs`、`phase4.test.mjs`、`phase5.test.mjs`、`phase6.test.mjs`、`tests/e2e/phase5.test.tsx`：修复外键断言、版本断言和保留语义，并新增文件内容/登记检查。
- 根和七个 workspace manifest、`packages/shared/src/index.ts`、`bun.lock`：仅统一版本为 0.6.1，无第三方依赖升级。
- `README.md`、`docs/OPERATIONS.md`、本记录：明确安装、上下文与保留式清理行为。

## 自动化验证

环境为 WSL2 Linux x64、Node 24.18.0、Bun 1.4.4、Git 2.53.0、SQLite 3.53.4。执行命令时仅在审计进程补入已安装的 Node PATH；未改 Shell 配置。

```bash
export PATH=/home/clj/.nvm/versions/node/v24.18.0/bin:$PATH
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run build
bun run test
git diff --check
```

- 冻结安装通过，259 installs / 354 packages，no changes；只更改 workspace 版本，没有更新第三方依赖。
- typecheck、Biome 和构建通过。
- 定向验证最初 **9/9 通过**，日志 `/tmp/hhu-audit-fixes-targeted.log`；证据 `/tmp/hhu-audit-fixes-5TY8Ji`。
- 首次完整回归：79 项 Node 通过；UI 31 通过、1 失败。失败原因是新断言在 Git 目录已移动而 SQLite 仍为 PRESERVING 时抢先检查 RETAINED；改为等待 UI 的操作成功确认，再核对最终记录和保留文件。没有放宽文件存在/内容要求。该次日志 `/tmp/hhu-audit-fixes-full.log` 保留。
- 修正等待边界后的 TUI Worktree 文件 **4/4 通过**，日志 `/tmp/hhu-audit-fixes-ui.log`。
- 修正后的完整回归 **79/79 Node + 32/32 Bun/Solid，共 111 项通过，0 失败/跳过**；日志 `/tmp/hhu-audit-fixes-final.log`。收尾继续核对可变 UID 的后代仍应按 SID 计入退出检查，去掉 UID 过滤；同步 OpenCode 探针版本后，再次执行 typecheck、lint、build 和完整回归，最终仍 **111/111 通过**，日志 `/tmp/hhu-audit-fixes-release.log`（Node 约 184 秒，UI 17.65 秒、171 个 expect）。`git diff --check` 通过。

测试只对临时库/仓库/进程注入故障。新增 force 仅针对测试自行创建的顽固 Node fixture，不对用户或真实 Harness 发 force，不重发不确定任务。

## 真实 Harness 验证

本轮显式运行临时握手探针 `/tmp/hhu-audit-remediation-handshakes.mjs`：四种 Harness 各使用新的临时 Conversation，Project 及 HarnessHub/XDG config/data/state/cache 均隔离。**每个 Prompt 数为 0**，没有模型调用、工具任务、原生配置修改或审批应答。验证范围是本补丁的真实握手、cwd、会话关闭/结束边界与进程回收。

首次证据：`/tmp/hhu-audit-real-DR12c4/evidence.json`，日志 `/tmp/hhu-audit-real-handshakes.log`。收尾对最终构建重新执行同一类新建环境探针，证据为 **`/tmp/hhu-audit-real-ZlnsM3/evidence.json`**，日志 `/tmp/hhu-audit-real-final.log`；两次均没有 Prompt，下表的首次关闭延迟也在最终构建中如实复现。

| Harness | initialize/session/new 与 cwd | 关闭结果 |
| --- | --- | --- |
| Codex | READY；cwd 正确；0 Prompt | 首次普通 Session stop 在宽限期内未确认全部退出，正确返回 409 并保留句柄；稍后普通 Daemon shutdown 确认 CLOSED。不能将首次关闭写成即时通过 |
| Claude Code | READY；cwd 正确；0 Prompt | 普通 stop → CLOSED，Conversation INTERRUPTED，Worker 退出 |
| Grok Build | READY；cwd 正确；0 Prompt | 普通 stop → CLOSED，Conversation INTERRUPTED，Worker 退出 |
| OpenCode | READY；cwd 正确；0 Prompt | 普通 stop → CLOSED，Conversation INTERRUPTED，Worker 退出 |

最后普通 Daemon stop 成功。只读核对临时 SQLite：四者均 CLOSED、endedAt 非空，四个直接 Worker PID 均已退出，实例文件移除。未使用 SIGKILL 或 force 清理真实 Harness。Codex 首次关闭延迟是实际限制，当前采取保留控制权而不假报成功。

这不替代真实 Prompt/工具/取消/审批/Handoff 的逐 Harness 验收；OpenCode 的全隔离纯文本卡顿根因仍见原审计，不因本轮握手成功就改写为消息通过。历史 Codex/Claude/Grok Phase 6 原始工具事件经过新 smoke 谓词只读重放，分别仍满足同 Turn 成功 read/pwd；没有为此重新投递模型任务。

## 限制及用户待验收

- Windows Terminal / VS Code WSL 物理 Shift+Enter、鼠标、系统剪贴板：**未验证**，沿用双终端人工清单。
- Worker 退出核对依赖 Linux `/proc` 的可见性；无法确认时保守拒绝。HarnessHub 不是进程沙箱，原生工具主动 setsid 脱离受管 session 的独立服务不在这份退出证明内，须按原生工具生命周期核查。
- 新 cleanup 保留文件；旧发布/失败 staging 也保留。没有自动垃圾回收，不自动删除任何用户数据。
- 真实 Codex 首次关闭可能超出当前宽限期，需等待其退出后再作普通关闭；保留句柄可供再次正常检查，不保证所有适配器都即时退出。
- 本轮没有重新执行四种 Harness 的全部真实消息/工具/取消/审批/Handoff；设置时不自动审批，不确定 Turn 不重放。
- 原审计列出的长期 RSS/FD、百万事件导出、自由文本秘密与提示注入残余风险，未通过本次窄范围修复消除。schema 仍为 6，没有默认库迁移或原生恢复承诺。

F01–F08 的已确认缺陷及对应复现路径均完成修复与回归。交付范围是审计缺陷修复及回归记录，最终 MVP 的用户人工验收仍未完成。不开始新阶段，不自动提交或全局安装。
