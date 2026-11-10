# HarnessHub v0.6.2 RC 审计修复

修复基线：`7cd2638fff0713748f1f0bb5913af849e3827b4d`。开始时 HEAD 与审计基线一致，Git 工作区干净。版本保持 **0.6.2**，未发布、打包安装、覆盖 WSL 安装或重启用户默认 Daemon。

本次范围仅为 RC-01～RC-05。已读取 AGENTS、架构/实施计划、Desktop 架构及既有验收；仓库中的 `official-final-audit.md` 是较早的 F01～F08 审计，不冒充本次 RC 报告。本次 RC 问题以用户提供的完整报告为准，并核对仍存在的 `/tmp/hhu-rc-audit-q2jh7v65/` 探针、`repro-results.json`、`idle-confirm-result.json` 和 fsmonitor HTTP 证据。所有反例在新建隔离目录重建，没有运行原审计目录中的生命周期脚本。

## 根因、实际改动和回归证据

### RC-01 — Git 查询可执行配置中的程序

根因：Changes 的 `execFile` 只避免 Shell 拼接，没有阻止 Git 执行 `core.fsmonitor`；Worktree 的 `core.hooksPath=/dev/null` 不覆盖 fsmonitor。继承整个进程环境也允许 Git 配置、索引、目录和外部 Diff 环境注入。进一步实测确认，status 可以调用 clean filter，且会进入子模块读取其独立 filter 配置。

改动：新增 `packages/core/src/git.ts`，Changes（含非 Git 探测）和 Worktree 全部使用它。子进程只保留 PATH/HOME/XDG_CONFIG_HOME/TMPDIR，设置固定 locale、禁交互、禁 optional locks、禁 lazy fetch；不继承 GIT_CONFIG_*、GIT_DIR、GIT_INDEX_FILE、外部 Diff、Shell startup 和 loader 等变量。CLI 配置禁用 fsmonitor、hooks、外部 Diff、alternate refs command 和传输，Diff 继续明确 `--no-ext-diff --no-textconv`。只读枚举实际配置（含 include/includeIf）及已初始化子模块，按配置键禁用 clean/smudge/process/textconv/command 驱动；没有危险路径字符串黑名单。保留 Gitignore、普通属性和所有权检查。

Worktree 创建改为 `worktree add --no-checkout` → 在新目录重新检查条件配置 → `read-tree HEAD` → 不带 force 的 `checkout-index --all`。这样新分支/目录条件 include 的过滤器也被约束，且检出不会覆盖并发创建的文件。原清理安全检查和 RETAINED 保留策略继续存在。已有 Git 故障 fixture 改为在临时 wrapper 中携带注入设置；“部分成功”故障移到实际检出完成处，原文件保留断言不变。

修复前四个独立哨兵测试均失败；修复后函数、Daemon HTTP、Desktop `changes.list/diff` 业务操作、Worktree 创建及清理预检均通过。额外覆盖 include、Git 环境注入、外部 Diff/textconv/filter、rename/untracked/ignored、子模块 clean filter、新分支条件 smudge filter。哨兵始终不存在，文件内容及真实 Git 结果有明确断言。

证据：[修复前](evidence/rc-remediation/rc01-before.log)、[首轮修复后](evidence/rc-remediation/rc01-after.log)、[完整定向回归](evidence/rc-remediation/rc-all-after.log)。生产 Git 调用已全量检索；其他 Git 调用只存在于隔离人工验证脚本，未由 Desktop/Daemon 路由触发。

### RC-05 — 草稿重载迟到覆盖新编辑

根因：`DesktopDraft.reload()` 等待队列后直接将 HTTP 响应写回 `value/text`，缺少编辑版本和加载请求所有权判断。重载期间编辑仍可发生，多个重载也可逆序返回。

改动：`apps/desktop/src/renderer/drafts.ts` 增加编辑代次、加载序号，并核对 CAS revision 和 pending requestId。请求期间产生新编辑或保存结果变化时拒绝应用旧响应并提示保留本地文字；只有最新请求可应用。提交/lookup 开始使旧重载失效。`Composer.tsx` 清理订阅时使旧加载失效，避免卸载/会话切换迟到回写。不同会话仍保留独立 editor，未改动 requestId 去重和 ACK 丢失查询规则。

回归使用可控延迟接口：A/B 并发、CAS 冲突、A 重载期间继续输入，分别与保存成功/失败交错；逆序重载、卸载失效和切换会话。修复前 3 项失败，修复后全部通过；原 pendingSubmission/丢 ACK/双击发送测试继续通过。没有自动提交 Prompt。

证据：[修复前](evidence/rc-remediation/rc05-before.log)、[首轮修复后](evidence/rc-remediation/rc05-after.log)、Desktop 完整测试。新增测试位于 `apps/desktop/tests/chat.test.tsx`。

### RC-02 — 空闲 Worker 退出后保留失效 Live

根因：Worker 的 `failed()` 在 ACP 连接关闭时设置 closed 并仅调用一次 lost；child close 后因 closed 已为 true，不再更新 Runtime。第一次 lost 时进程组可能未结束，故 NativeSession 的 endedAt 留空，失效 Live 又阻断 prepare/submit。

改动：`packages/acp/src/index.ts` 分离连接 lost、child close、进程组退出确认，child close 后只观察剩余组成员，不发送信号。确认结束后 Runtime 持久化 INTERRUPTED/endedAt 和 `runtime.worker_exited` 证据。保留旧 Live，要求用户显式恢复。新增 `POST .../session/recover`（旧 NativeSession ID + confirmed=true），原子检查活动 Turn、审批、配置、Handoff、SENDING/UNCERTAIN 及真实退出证据后创建新的 NativeSession；不发 Prompt、不执行 Handoff、不复用旧 ID。

Desktop 契约、Main action 和 Composer 提供“使用新原生上下文继续”及确认说明；sessions 查询提供 exitConfirmed，区分重启造成的历史 endedAt 与真实进程结束。TUI ACP settings 提供同一显式恢复操作，使用相同后端约束。用户消息和工具历史原样保留。

回归：首次 Turn 完成→空闲退出→持久退出确认→Desktop 操作创建新 ID→第二 Turn 完成；历史前缀完全一致、Handoff 数量为 0。仅 stdio 关闭、仍在执行时返回 409；另以真实无管道后代验证 child close 不等于进程组退出，最后一个后代结束后才触发确认。UNCERTAIN 输入、审批和 Handoff 仍由相同预检阻断。额外覆盖 Prompt RPC 先报未知、Worker 随后退出：lost 不覆盖 UNCERTAIN，恢复还检查旧 Session 的不确定 Turn，不能借退出清除未知结果。

证据：[修复前](evidence/rc-remediation/rc02-before.log)、[首轮修复后](evidence/rc-remediation/rc02-after.log)、[未知 Turn 随后退出](evidence/rc-remediation/rc02-uncertain-exit.log)、完整定向回归和 Desktop/TUI 渲染操作断言。修复前主反例明确失败于 endedAt 缺失；新增恢复 API 在基线不存在，因此基线的 API 反例失败不能单独当作根因证据。

### RC-03 — Steering UNCERTAIN 被正常 Turn 状态遮蔽

根因：投递 journal 独立保存 UNCERTAIN，但没有发布相应 Conversation metadata；`finish(COMPLETED)` 又写 IDLE。后端按投递 journal 拒绝新请求，客户端只看 Conversation 状态，产生不一致。

改动：`pending-inputs.ts` 每次投递更新发布 metadata；UNCERTAIN 置为 Conversation 的阻断状态，`Runtime.status()` 不允许后续正常 Turn 结束覆盖它。原 Turn 仍为 COMPLETED。启动时从既有 input journal 恢复 UNCERTAIN（也修复旧构建留下的 IDLE）。Snapshot 增加 SENDING/UNCERTAIN pendingInputs，Activity 显示问题状态。Desktop Composer 显示独立投递提示和原 requestId，禁止提交；TUI 显示同样原因，并在草稿预留前阻止提交。prepare 也不能绕过未决投递，队列自身正常提交仍获准。

回归：原 Turn 先结束后超时、先超时后结束均保持 COMPLETED + 输入 UNCERTAIN；ACK 成功为 SENT，明确失败为 ERROR。只记录一次 `_session/steering`，不重发。真实 DesktopConnection 与 TUI watchSnapshot/watchConversation 同时连接，隔离 Daemon 崩溃重启后事件补拉完全一致，requestId/Turn 关联保留，升级预检继续拒绝。正常 stop 对未确认 Worker 的拒绝是预期安全行为，测试未放宽它。OpenTUI 实际渲染测试还验证提示可见、按 Enter 后编辑文字保留且没有新增 user.message；新上下文恢复入口也完成真实 TUI 操作回归。

证据：[修复前](evidence/rc-remediation/rc03-before.log)、完整定向回归。修复前两个顺序均显示 IDLE，ACK/明确失败对照正常。

### RC-04 — 审批过期与历史投影分离

根因：`RuntimeStore.recover()` 只把 PENDING 审批 SQL 更新成 EXPIRED，没有在同一事务追加终结事件。Desktop/TUI 历史投影只读到 approval.requested，无法终结 waiting。

改动：恢复事务中逐条 CAS 过期并追加 `approval.expired`，保留原 NativeSession/Turn/approvalId、EXPIRED 和恢复原因。事件 seq 由既有 append 分配；已有终结事件时不重复。也为旧构建已经 EXPIRED 但缺少终结事件的记录补齐历史，不需要数据库迁移。共享投影将过期显示为通知，Desktop 工具卡显示“审批已过期”，不改写原生 pending 状态、不制造 Reject 或成功。TUI 原终结处理兼容新增通知。

回归：Mock 请求权限→只对测试 Daemon SIGKILL→SQLite 恢复→数据库 EXPIRED→一个终结事件→旧审批操作 409。首屏完整重放、增量补拉和两事件分页得到相同工具卡 waiting=false；原历史前缀不变，seq 连续，第二次重启无重复事件；Turn 保持 UNCERTAIN。Desktop/TUI 渲染测试保持原生工具 pending，并不再显示等待审批。

证据：[修复前](evidence/rc-remediation/rc04-before.log)、完整定向回归、Desktop chat 和 TUI agent-output 测试。

## 安全与兼容边界

- 无数据库 schema migration，无依赖/lockfile/版本变更。审批历史补齐是幂等恢复事务。
- HTTP 新增显式 session/recover；NativeSession DTO 增加可选 exitConfirmed；Snapshot 增加可选 pendingInputs；新增 worker_exited/context_restarted 事件。均为追加字段/事件，协议版本维持原值，旧客户端未知事件仍可回放。新旧客户端混用时旧客户端不会获得新恢复按钮，不能宣称展示一致。
- 原 Prompt 幂等、权限审批、Handoff 及升级安全预检不放宽；恢复不关闭或强杀 Worker，不重发未知输入。新上下文没有原 Agent 内部上下文，历史只留作可观察记录。
- Git CLI 仍是受信任的本地可执行文件，PATH 来自启动环境。自定义 filter/textconv 不执行，展示的是原始 Git/文件内容；依赖这些驱动的仓库不会得到驱动转换后的 Diff。子模块检查最多 128 个，命令输出上限 2 MiB、整体检查有超时，超限明确失败。
- Git 配置读取与实际查询不是原子文件系统快照；同 UID 程序并发修改 Git 元数据不属于进程沙箱保证。已有查询/清理也不承诺原子工作区状态。Worktree 继续只保留目录/分支，不自动删除用户数据。

## 验证环境与完整命令

所有新增进程/Git/SQLite/HTTP 测试使用临时 HOME/XDG、临时仓库和 Mock ACP。最后完整命令也由隔离 HOME/XDG 父环境执行，具体版本和路径见 [check-environment.txt](evidence/rc-remediation/check-environment.txt)。故障注入只向测试拥有的 Daemon/后代发信号；没有读取原生凭据或发真实模型请求，没有自动同意权限。

| 命令 | 最终结果 |
| --- | --- |
| `bun run typecheck` | 通过（见 typecheck.log） |
| `bun run lint` | 通过（见 lint.log） |
| `bun run build` | 通过（见 build.log） |
| `bun run desktop:build` | 通过（见 desktop-build.log） |
| `bun run desktop:test` | 通过：45 项 Desktop 测试 + 15 项真实 HTTP/WS 集成（见 desktop-test.log） |
| `bun run test` | 通过：118 项 Node 集成 + 119 项 TUI/E2E，0 失败（见 test.log） |
| `git diff --check` | 通过（无输出，见 diff-check.log） |

Worker/草稿的最后交叉检查另跑 Phase 2/3 共 23 项，全部通过（见 worker-lifecycle-final.log）；`bun run version:check` 确认统一版本 0.6.2。空 Snapshot 的严格结构断言新增 `pendingInputs: []`，保留原认证/Origin/单实例断言。

完整回归曾在既有 `chat-scroll.test.tsx` 的轮询条件触发 OpenTUI `OutputBusy`（原生渲染中同步取帧），单独运行也复现。只修正该测试的帧同步：使用锁定 OpenTUI 0.8.0 提供的 `waitForFrame`，循环判断使用已取得的帧；没有删除 180 条历史覆盖、63 个挂载节点、双向滚动或原始事件断言，没有捕获/吞掉异常，也未改动生产滚动逻辑。失败记录保留于 [test-outputbusy-attempt.log](evidence/rc-remediation/test-outputbusy-attempt.log)，修正后 4 项滚动测试通过，见 [scroll-recheck.log](evidence/rc-remediation/scroll-recheck.log)。

持久证据目录：[evidence/rc-remediation](evidence/rc-remediation/)。本轮新增后端 RC 专项共 17 项，最终完整测试全部通过；`rc-all-after.log` 为此前 16 项专项通过记录，新增未知 Turn 随后退出反例见独立日志及最终 test.log。测试入口 `scripts/test.ts` 已包含新增 `tests/integration/rc-remediation.test.mjs`，Desktop chat 与 TUI agent-output 回归由既有完整测试入口执行。无需依赖原审计 `/tmp` 证据即可重建反例。

## 未验证项与交付建议

本轮没有物理 Windows Electron/WSL2 窗口人工操作，没有真实模型/权限/Handoff 重测；Linux 的 DesktopConnection、React 渲染、OpenTUI 和 HTTP/SQLite/Mock ACP 结果不能替代它们。没有安装 Windows 客户端、生成新安装包、上传 GitHub Release 或部署到用户环境。

用户检查后，在测试安装/测试发行版手动确认：空闲 Mock Worker 退出时出现新上下文提示，点击确认只建新 Session；输入投递未知时发送按钮禁用并显示 requestId；审批崩溃恢复后旧卡过期且无审批按钮；冲突草稿重载期间继续输入不丢字；Changes 展示 rename/untracked/Worktree 内容。Windows 测试应继续使用隔离数据和 Mock ACP。

建议在合入/发布前进行**第二次独立 RC 审计**，重点复核 Git 配置/子模块边界、进程退出证据和跨状态组合。此次交付为源码、可重复回归和验收报告，等待用户检查，不直接发布版本。
