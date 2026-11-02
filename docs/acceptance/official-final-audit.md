# HarnessHub v0.6.0 — 最终独立代码审计

审计日期：2026-11-02（Asia/Shanghai）。审计基线：`452d64820a29ec72952e74e3e7f2bef49705b538`，版本 `0.6.0`，SQLite schema 6。开始审计时 Git 工作区干净。

本轮为只读产品审计。唯一新增仓库文件为本报告；没有修复产品源码、测试、依赖或已有验收文档，没有提交 Git，没有操作用户默认 HarnessHub 数据库、Conversation、全局启动器或原生 Agent 配置。构建产物和依赖检查遵照用户要求执行；故障注入、源码副本、Mock、SQLite 和 Git 写入验证均在临时目录。未调用外部代码扫描服务或上传代码。

## A. Executive Summary

**Release Readiness：FAIL。当前版本不建议直接作为日常使用的 MVP Release Candidate。**

整体结构符合既定技术路线，核心闭环不是演示占位：Bun/OpenTUI/Solid 客户端、Node/Hono Daemon、真实 SQLite、Generic ACP 子进程、原生权限选择、请求去重、事件补拉、Handoff 和 Git Worktree 均有实际实现。补齐本次 Shell 的 Node PATH 后，现有 **70 项 Node 集成测试 + 32 项 Bun/Solid 测试全部通过**。

但独立故障验证发现了现有测试没有覆盖的用户文件丢失和 Worker 管理失效。测试全绿不足以支持发布。

| 等级 | 数量 | 内容 |
| --- | ---: | --- |
| P0 — Critical | 1 | Worktree 清理可永久删除被 index 标志隐藏的未提交文件内容；另复现 ignored 文件检查/删除竞态 |
| P1 — High | 1 | Adapter 退出且 stdio 关闭后，仍存活、持续写文件的后代被当成已清理 |
| P2 — Medium | 4 | Handoff 重试投递旧 fallback；正常重启静默丢原生上下文；ACP 设置超时后迟到生效且状态失真；失败安装混用新旧产物 |
| P3 — Low | 2 | 外键测试因列数错误假通过；真实兼容性探针跨 Turn 误计工具 |
| 合计 | **8** | 六项产品缺陷、两项测试缺陷 |

P0 按本次审计要求中的“数据破坏/用户文件丢失”分级；影响范围是用户确认清理的受控 Worktree，具体前提见 F01。未提交内容没有进入 Git 对象库，保留分支不能恢复它。

F01–F06 均使用当前实际实现和隔离进程/文件复现；F07–F08 提供实际断言反例，不把测试漏洞推断成产品必然发生故障。没有确认网络未授权访问、自动批准或 Prompt 自动重放漏洞。

OpenCode 的结论需分开：本轮全隔离 CLI/直连 ACP 复现 120 秒无文本；Runtime 在 `session/new` 收到原生 `directory` 服务错误，没有投递 Prompt。已有原生登录成功记录的原始事件确实存在，不能用本轮隔离失败推翻。当前证据不足以确定 OpenCode/上游卡顿根因，也不足以声称所有 OpenCode 能力已通过。

Windows Terminal / VS Code WSL 物理键盘、鼠标及系统剪贴板仍未验收。本轮工程审查 FAIL 与用户终端验收未完成，是两项独立结论。

## B. Findings

### F01 — P0：Worktree“干净”检查不足，可删除未提交用户文件

**位置：** [packages/core/src/worktrees.ts:186](/home/clj/HarnessHub/HarnessHub/packages/core/src/worktrees.ts:186)，尤其 188–203 行；删除前的应用内预留在同文件 130–143 行。

**证据类型：已复现。** 两种触发均使用真实 Git 2.53.0 和临时仓库，没有使用 force，没有修改真实项目。

**调用链：** `POST /v1/worktrees/:id/cleanup` → `Worktrees.cleanup()` → `cleanupReserved()` → `git status --porcelain=v1 -z --untracked-files=all --ignored=matching` → `REMOVING` → `git worktree remove -- <path>` → `REMOVED`。

**触发 A（无需竞态）：**

1. 创建并绑定受控 Worktree；删除其空闲 Conversation，保留工作目录。
2. 对其中一个 tracked 文件运行 `git update-index --assume-unchanged tracked.txt`。
3. 修改该文件，写入未提交的新内容。
4. 明确确认 Worktree cleanup。

**预期：** 检出或保守拒绝这种无法由普通 status 证明干净的目录，保留未提交内容。

**实际：** 预检输出为空；普通 `git worktree remove` 同样接受该状态，HarnessHub 返回 `REMOVED`，文件和整个 Worktree 被删除。新内容没有提交，分支仍在也不能恢复。

本轮输出：

```json
{"cleanupStatus":"REMOVED","preflightStatusEmpty":true,"dirtyTrackedFileSurvives":false,"worktreeSurvives":false}
```

**触发 B（检查/执行竞态）：** 在 status 已完成后、真正调用 remove 前，一个外部写入者创建 `.gitignore` 匹配的文件。使用临时 PATH Git wrapper 在该边界写入 `precious.ignored`，随后原样 exec `/usr/bin/git`。普通 remove 不把这个 ignored 文件作为阻止条件，仍返回成功并删除它。

```json
{"cleanupStatus":"REMOVED","fileCreatedAfterStatus":true,"ignoredFileSurvives":false,"worktreeSurvives":false}
```

**现有保护为何不足：** `workspaceOperations` 只能阻止本 Daemon 的绑定/操作，不能锁住外部编辑器或构建进程。Git status 尊重 index 标志；普通 Git remove 的安全检查不能替代产品承诺的“所有 dirty/ignored 数据均保留”。现有测试只在检查开始前写入普通 dirty/untracked/ignored 文件，没有覆盖隐藏修改或最后一次检查后的新文件。

**最小验证：** 运行 `/tmp/hhu-official-audit/probe-worktree-flags.mjs` 和 `probe-worktree.mjs`。可不依赖 wrapper 重现触发 A：在临时受控 Worktree 中执行上述两条 Git/写文件操作，再调用 cleanup API。核心反例是“index 标记隐藏修改 → status 为空 → 普通 remove 成功”。

**影响：** 清理目标中的未提交源码、用户生成文件、ignored 数据。删除 Conversation 本身不删文件；真正风险位于随后显式 cleanup。

**修复方向：** 首先拒绝带 assume-unchanged/skip-worktree 等无法保证完整检查的目录，不能静默更改用户 index 标志。对外部写入竞态，重复 status 只能缩小窗口；在无法证明写入者停止时，应采用保留目录的隔离/待清理流程，或暂时取消自动物理删除能力。保留分支不能替代未提交文件保护。补充两个真实 Git 反例作为发布阻断回归。

**本机证据：** [隐藏修改结果](/tmp/hhu-official-audit/worktree-PWOHNM/result.json)、[ignored 竞态结果](/tmp/hhu-official-audit/worktree-wSKxTH/result.json)。

### F02 — P1：Adapter 的 close 被误用为整个 Worker 后代退出证明

**位置：** [packages/acp/src/index.ts:89](/home/clj/HarnessHub/HarnessHub/packages/acp/src/index.ts:89)，90–97、170–209 行；上层删除句柄的 [packages/core/src/runtime.ts:677](/home/clj/HarnessHub/HarnessHub/packages/core/src/runtime.ts:677)；Handoff 源释放 [packages/core/src/handoff.ts:308](/home/clj/HarnessHub/HarnessHub/packages/core/src/handoff.ts:308)。

**证据类型：已复现。**

**调用链：** `Runtime.disposeLive()` → `Worker.stop()` → 关闭 ACP/stdin → 等 `child.close` → `exitedConfirmed=true` → 跳过 SIGTERM → Session CLOSED/删除 live 或 Handoff source 句柄。

**触发条件：** Adapter 派生同进程组的后代，但后代将 stdio 设为 ignore/关闭继承管道；Adapter 接到 EOF 后正常退出，后代仍在运行。无需 setsid、无需逃离 Worker 进程组。

**预期：** 仍有能写工作区的受管后代时，保留句柄并报告退出未确认；不得允许源清理成功、删除会话或停 Daemon 的结论掩盖它。

**实际：** `child.close` 只证明直接子进程及其 stdio 生命周期已结束。`stop()` 的 `drained` 为 true 后不再检查/处理进程组；后代持续修改文件，上层却认为已安全释放。

隔离 fixture 的关键结构：

```js
// Adapter：后代仍在同一进程组，但没有继承 ACP 管道。
const child = spawn(process.execPath, [fixture, "--child"], { stdio: "ignore" });
child.unref();
// 后代定期写 marker；Adapter 在 ACP stdin EOF 后正常 process.exit(0)。
```

实际输出：

```json
{"stopResolved":true,"adapterExitConfirmed":true,"descendantStillAlive":true,"descendantStillWriting":true}
```

**现有测试为何不足：** [tests/fixtures/mock-acp/descendant.mjs:13](/home/clj/HarnessHub/HarnessHub/tests/fixtures/mock-acp/descendant.mjs:13) 故意让后代继承 stdout/stderr；Phase 6 的测试证明了“后代持管道时不能成功”，不能证明“所有后代已经退出”。

**最小验证：** `node /tmp/hhu-official-audit/probe-worker.mjs`。它直接使用当前构建的 Worker，等后代 marker 已出现再调用普通 stop；stop 返回后核对后代 PID 和两次不同写入时间。该测试后代已用 SIGINT 清理，未向用户进程发信号。

**影响：** Handoff 后旧源任务与新目标并行写同一工作区；Session/Conversation 删除或 Daemon 停止后仍有失管进程。源句柄被移除后，既有受控关闭入口也无法找到它。

**修复方向：** 将 ACP 断连、直接子进程/stdio 结束、进程组清理分别记录；在确认进程身份和所属组的前提下检查仍存活的组成员。保留未确认句柄及 `endedAt=null`，协作退出失败继续要求明确 force 确认；不能借修复增加默认 SIGKILL，也不能对陈旧 PID/复用的进程组盲发信号。无需引入独立 Runner。

**证据：** [worker-result.json](/tmp/hhu-official-audit/worker-result.json)、[fixture](/tmp/hhu-official-audit/descendant-no-pipes.mjs)。

### F03 — P2：降级交接失败后重试，新报告已保存却仍投递旧 fallback

**位置：** [packages/core/src/handoff.ts:147](/home/clj/HarnessHub/HarnessHub/packages/core/src/handoff.ts:147)，147、217–221、287、373–384 行。

**证据类型：已复现。**

**调用链：** 报告不完整 → FAILED → 用户 confirm → `degraded=true` / 保存 fallback → 目标 `session/new` 失败 → FAILED → 用户 retry → GENERATING → 新报告成功 → READY → DELIVERING → COMMITTED。

**触发条件：** 用户已确认过一次降级，但目标准备失败且从未发送目标 Prompt；随后显式选择重试报告/目标准备。这是 UI 提供的合法恢复路径。

**预期：** 新报告通过校验时，目标收到该报告；界面和历史能准确说明实际投递的上下文材料。

**实际：** 重试只清除 `error/reportText`，没有复位 `degraded/confirmedAt/fallbackText`；READY 也不更新交接材料选择。投递在 287 行继续根据旧 `degraded=true` 选择旧 fallback，而不是刚生成的 reportText。

本轮通过一个首次报告不完整、第二次报告包含 `NEW_REPORT_2` 的源 Agent，加上首次建会话失败/后续成功的目标 Agent，得到：

```json
{"status":"COMMITTED","degraded":true,"freshReportSaved":true,"freshReportDelivered":false,"oldFallbackDelivered":true,"promptCount":4}
```

四次 Prompt 分别为源用户 Turn、第一次内部报告、第二次内部报告、唯一目标用户 Prompt；没有重发目标任务。

**现有测试为何不足：** 覆盖了报告失败→确认、目标准备失败→取消、UNCERTAIN 拒重试；没有覆盖“确认降级→目标准备失败→重新生成成功”的组合。状态枚举合法不能保证材料版本一致。

**最小验证：** `node /tmp/hhu-official-audit/probe-handoff.mjs`；将最终数据库 `reportText` 与目标 raw `session/prompt.params.prompt[0].text` 比较。

**影响：** 目标 Agent 使用过时/缺失上下文执行任务；历史保存的新报告与真正发送的材料不同，削弱可追溯性。

**修复方向：** 重试新报告时显式重置材料选择及旧降级确认；READY 到投递应绑定确定的材料版本。生成成功后选用新报告；仍需 fallback 时对当前材料进行明确确认。保留原 requestId/用户 Turn 和不确定任务禁止重放规则。

**证据：** [result.json](/tmp/hhu-official-audit/handoff-zVB356/result.json)、[state-agent.mjs](/tmp/hhu-official-audit/state-agent.mjs)。

### F04 — P2：正常 Daemon 重启静默丢失原生上下文，Conversation 仍显示 IDLE

**位置：** [packages/core/src/runtime.ts:677](/home/clj/HarnessHub/HarnessHub/packages/core/src/runtime.ts:677)，677–679、227–235、419–438 行；[packages/storage/src/runtime.ts:430](/home/clj/HarnessHub/HarnessHub/packages/storage/src/runtime.ts:430)，430–456 行；[apps/tui/src/agent-pane.tsx:380](/home/clj/HarnessHub/HarnessHub/apps/tui/src/agent-pane.tsx:380)。

**证据类型：已复现。**

**调用链：** 完成用户 Turn → IDLE → 正常 `shutdown()` / `disposeLive()` 将 Session CLOSED、endedAt 非空 → 重启 `recover()` 仅检查 endedAt 为空的 Session → Conversation 仍 IDLE → 同 Harness submit → `ensure()` 新建 session/new → 只发送新消息。

**触发条件：** 已有成功多轮历史的会话，经正常 daemon stop/start，或显式关闭其空闲原生 Session 后继续同会话。

**预期：** 如实持久化并展示“原生上下文已结束；后续会创建新会话”的边界。若没有验证过安全 resume，就明确提示上下文不可自动延续。

**实际：** 新 Worker 没有旧原生上下文，也没有收到旧历史；TUI 的中断警示仅针对 INTERRUPTED/UNCERTAIN，而正常关闭留下 IDLE，用户看着原聊天历史继续发送会误以为仍是原会话。

```json
{"statusBeforeSend":"IDLE","nativeSessions":2,"secondSessionReceivesHistory":false,"interruptionEvents":0}
```

**现有测试为何不足：** SIGKILL 路径验证了 INTERRUPTED；正常重启用例主要检查 SQLite 历史、requestId 和项目仍存在，没有验证下一条 Prompt 的上下文及用户警示。数据库历史持久化不等于 Agent 上下文延续。

**最小验证：** `node /tmp/hhu-official-audit/probe-restart.mjs`。首 Turn 发送 `Remember UNIQUE_OLD_CONTEXT`，正常关闭/重新打开 Store 和 Runtime，发送第二条消息；检查第二个原生 Session 的 raw Prompt 及会话状态。

**影响：** 正常升级/重启后的任务遗漏旧约束、目标或决策。SQLite 历史本身没有被删除。

**修复方向：** 显式记录当前原生上下文已结束的持久边界，避免旧 activeNativeSessionId 被 UI 当作仍可连续交互的会话。正常重启与显式关闭也应展示新会话警示；任何上下文恢复只能依据真实能力，不自动重放旧 Prompt。

**证据：** [result.json](/tmp/hhu-official-audit/restart-Lz5PhC/result.json)。

### F05 — P2：ACP 设置超时后解除操作锁，迟到设置仍生效且显示保留旧值

**位置：** [packages/acp/src/index.ts:151](/home/clj/HarnessHub/HarnessHub/packages/acp/src/index.ts:151)，151–165 行；[packages/core/src/runtime.ts:585](/home/clj/HarnessHub/HarnessHub/packages/core/src/runtime.ts:585)，597–603、625–635 行。

**证据类型：已复现。**

**调用链：** `/settings` → 标记 configuring → `Worker.bounded(agent.request(...))` → 20 秒超时 → finally 解除 configuring → 新 Prompt 获准 → 原 set_mode 请求第 21 秒才完成。

**触发条件：** Agent 设置处理超过 20 秒，并且没有在迟到响应之外另发 current_mode/config_option update。

**预期：** 超时表示设置结果未知，应继续阻止依赖该状态的操作，或完成可靠的状态重查/会话重建后再继续；不能把 Promise.race 超时视为原请求已取消。

**实际：** bounded 只停止等待，不取消底层请求。异步设置继续运行；超时后的赋值代码永远不会执行，所以 capabilities/UI 仍记录旧模式。新 Prompt 可以与该设置请求重叠。

21 秒延迟 Mock 的实际结果：

```json
{"settingsError":"ACP operation timed out; it was not retried","configuring":false,"displayedMode":"old","promptResult":"executing in old; executing in new","lateSettingsResponse":true}
```

两次新 Prompt 分别位于超时后、迟到响应后；显示模式始终 old，实际 Agent 第二次已是 new。

**现有测试为何不足：** 当前设置用例只有即时成功、非法值拒绝；初始化失败会 stop Worker，但 settings timeout 没有同等未知结果处理。

**最小验证：** `node /tmp/hhu-official-audit/probe-settings.mjs`，默认即保留 20 秒真实超时，不改产品时间常量；fixture 为 `/tmp/hhu-official-audit/slow-settings.mjs`。

**影响：** 模型、推理、会话模式与权限模式的实际值可能与界面不同；用户收到失败后继续操作时依据错误状态。此处没有证明 HarnessHub 自动批准权限。

**修复方向：** 设置超时采用显式“不确定配置”状态，保留排他操作保护；对底层请求完成、协议支持的取消/重查、或受控关闭分别处理。不要超时后静默放行，也不要自动重复设置请求。

**证据：** [result.json](/tmp/hhu-official-audit/settings-orVRbG/result.json)。

### F06 — P2：安装器只原子替换 launcher，构建失败已经覆盖其引用的运行产物

**位置：** [scripts/install-local.ts:70](/home/clj/HarnessHub/HarnessHub/scripts/install-local.ts:70)，70–80 行；[scripts/build.ts:6](/home/clj/HarnessHub/HarnessHub/scripts/build.ts:6)，6–25 行。

**证据类型：已复现。** 在完整临时源码副本、临时 HOME/XDG 中运行真实安装器和构建脚本。

**调用链：** 已安装 launcher 指向 checkout/dist → install 持 flock → `bun run build` 先写 `dist/daemon` → CLI 构建失败 → installer 报“launcher was not changed” → 旧 launcher 继续指向已部分更新的 dist。

**触发条件：** 升级构建中途失败/中断，或后半部分入口存在编译错误。单实例锁不解决磁盘产物回滚。

**预期：** 安装未完成时，之前的完整可运行版本仍可使用；CLI、Daemon、migrations 作为一致发布集合切换。

**实际：** launcher 字节未变，但其引用的代码已经变。临时副本把共享版本改为 0.6.1，并仅在 CLI 入口注入语法错误；安装退出 1 后旧 CLI 仍为 0.6.0，新 Daemon 已是 0.6.1。当前严格版本握手因此无法把二者当成同一发布使用。

```json
{"installExit":1,"launcherUnchanged":true,"daemonChangedDespiteFailedInstall":true,"cliUnchanged":true,"daemonHasNewVersion":true}
```

**现有测试为何不足：** 安装保护测试断言活 Daemon/持锁时不启动 build；成功安装测试断言 launcher 和版本。没有在 build 已写出一个入口后注入失败，也没有核对旧发布文件集合未变。

**最小验证：** `python3 /tmp/hhu-official-audit/probe-install.py`。脚本复制源码和旧 dist、保留 workspace 相对 symlink，使用临时 launcher；只修改副本，产品原文件不变。核对失败前后 launcher/CLI/Daemon hash 及版本字符串。

**影响：** 升级失败后全局 hhu 核心入口不可用或版本混用；通常可重新构建恢复，不等同数据库已损坏。

**修复方向：** 完整产物先构建到新的临时发布目录，全部成功后再原子切换 launcher/发布引用；保留上一份可运行集合，切换仍持现有同一 flock。无需新增自动更新服务。

**证据：** [result.json](/tmp/hhu-official-audit/install-djuzl1me/result.json)、[失败构建日志](/tmp/hhu-official-audit/install-djuzl1me/log.txt)。早期复制探针曾解引用 workspace symlink，未用于最终版本混用结论；最终以本目录为准。

### F07 — P3：外键验收断言实际命中列数错误，关闭外键也会通过

**位置：** [tests/integration/phase1.test.mjs:199](/home/clj/HarnessHub/HarnessHub/tests/integration/phase1.test.mjs:199)，199–204 行。

**证据类型：已复现（测试反例）。**

**调用链：** 设置 `foreign_keys=ON` → 不指定列名的 8 参数 insert → `assert.throws()` 接受任意异常。

**触发条件：** 当前 schema 的 conversations 已有 12 列，测试仍使用最初的 8 值 INSERT。

**预期：** 证明 SQL 结构合法、仅因不存在的 project 外键而失败；关闭外键应使该检查失败。

**实际：** prepare 阶段即产生 `SQLITE_ERROR: table conversations has 12 columns but 8 values were supplied`，尚未触及外键验证。本轮在隔离库中设 `foreign_keys=OFF`，该断言仍会通过。

**为何不能证明产品外键失效：** `openStore()` 确实设置 foreign_keys；其他迁移/关系检查也提供正面证据。缺陷是这条测试无法防止将来移除外键配置的回归。

**最小验证：** `node /tmp/hhu-official-audit/probe-assertions.mjs`；输出 `foreignKeysDisabled=true`、`foreignKeyTestStillThrows=true` 和上述具体错误。

**影响：** 持久化约束回归可能被测试全绿掩盖；未确认当前产品已产生孤儿记录。

**修复方向：** 明确列名并提供当前合法结构，验证错误码为 `SQLITE_CONSTRAINT_FOREIGNKEY`；另用合法 parent 证明 SQL 可以成功，避免把语法/结构错误当外键保护。

**证据：** [result.json](/tmp/hhu-official-audit/assertions-5qmaOV/result.json)。

### F08 — P3：真实兼容性探针跨 Turn 计数工具，可能误判 smoke 工具能力

**位置：** [scripts/verify-phase6.mjs:89](/home/clj/HarnessHub/HarnessHub/scripts/verify-phase6.mjs:89)，89–105 行。

**证据类型：静态代码确认 + 已复现断言反例。** 不声称历史真实运行已经因此假通过。

**调用链：** smoke Turn 完成 → 额外 cancellation Turn → 导出整个 Conversation → `toolCalls` 对全 Conversation 计数 → `smokeVerified` 使用该计数。

**触发条件：** smoke Turn 返回预期文本但没有实际调用工具；只有后续取消测试产生 tool_call。即使 smoke 的工具失败，当前判定也不要求该 Turn 中存在 completed 工具及正确 pwd 结果。

**预期：** smoke 的工具、输出及工作目录必须属于该 smoke Turn，取消测试应独立验收。

**实际：** 文本按 smoke turn.id 过滤，工具却没有，后续 Turn 的一个 tool_call 就能使 smoke 工具条件通过；`cwdMatched` 仅核对 Session/请求参数，未核对实际工具 pwd。

**测试不能保证之处：** 探针把握手 cwd、文本与另一个 Turn 的工具活动拼成成功证据，不能单凭 `smokeVerified=true` 证明所声明的读取/pwd 工具均成功。

**最小验证：** 在 `/tmp/hhu-official-audit/probe-assertions.mjs` 中构造两个事件：smoke 的预期文本、cancel 的 tool_call。当前原样计数谓词为 true，而 smoke 的工具数为零。反例输出 `smokeHasNoTools=true`、`phase6ToolCheckPasses=true`。

**影响：** 真实兼容性矩阵可能出现误判；这不直接使产品重复执行或修改文件。已检查的历史 OpenCode native-login raw 中确有同 Turn 的 completed read/bash，未据此撤销其历史成功。

**修复方向：** 工具计数、成功终态、原始工具结果和 cwd 都按原 smoke Turn 关联；分别验证读取哨兵、真实 pwd、取消终态。不能把 ACP 入口存在、session/new.cwd 或一次 tool_call 当成工具执行成功。

**证据：** 同 F07 的断言反例结果及当前脚本源码。

## C. Architecture Assessment

### 应保留的设计

- CLI/TUI 与 Daemon 的运行时边界清楚。构建分别使用 Bun/Node target，Daemon 独立 Node types 检查通过；core/storage 不依赖 TUI。
- SQLite 是事件、请求和审批的权威。`Runtime.submit()` 在首次 await 前同步校验/预留，requestId 唯一约束及 hash 防止多客户端重复投递；one_active_turn 的部分唯一索引限制用户 Turn。
- `RuntimeStore.append()` 在事务内分配 Conversation seq 并入库，调用方提交后才广播。客户端先订阅，再分页读 SQLite，检查连续 seq 和 Conversation ID。WS 被用作 invalidation 提示，重连没有发 Prompt 的路径。
- 审批由原生 options 驱动，DB CAS 与内存 live 请求共同保证一次决定；取消/失联/重启使旧审批失效。没有发现 HarnessHub 自动批准实现。
- Worker 进程 cwd 与 session/new.cwd 均取 Conversation workspace 的 realpath。无参数 hhu 的 Shell pwd 不参与默认 Agent 工作区选择。
- Handoff 的选择与发送分离；A→B→A 新建第三段 Session；内部报告有独立 Turn/purpose，真实用户消息单独保存。DELIVERING 先落盘，收到目标最终 ACP 响应后才在事务中 COMMITTED/绑定活动 Session。这个提交点比“写出请求”保守，符合不确定结果不得重放原则。
- Worktree 创建与 cleanup 的 Git 使用 argv、禁用 hooks、普通 remove，不调用 shell/force/branch delete；创建失败保留 ERROR 记录。应用内 Project/Workspace 预留避免了许多跨 await 绑定竞态。
- 默认日志只含固定生命周期/失败标签，不输出 Prompt、Worker stderr、工具全文或 Token。权限、备份和原始事件定向脱敏具有实际实现及测试。

### 状态链复核

| 边界 | 源码/执行观察 | 评价 |
| --- | --- | --- |
| 初始化/建会话失败 | 记录 session_error；尝试关闭 Worker；未确认时保留引用 | 结构合理；不能把 stdio close 当全部后代结束，见 F02 |
| 同会话并发提交/ACK 丢失 | 同 requestId 返回同一 Turn，不同内容 409；预留草稿可查 requestId | 本轮现有并发集成回归通过；未发现自动重发 |
| 取消与审批 | CANCELLING 后等真实结束；待审批被取消；尾事件在 finish 前落盘 | 本轮回归通过，未把 cancel 通知当完成 |
| Handoff 报告失败 | 未发目标 Prompt，保留预留，需明确 confirm/retry/cancel | 普通路径正确；组合重试材料不一致，见 F03 |
| Handoff GENERATING/DELIVERING 崩溃 | 恢复 UNCERTAIN，拒绝确认/重试重放 | 现有真实 Mock Daemon 崩溃用例本轮通过 |
| Handoff PENDING/READY 崩溃 | 保留未投递预留，转 FAILED，需明确动作 | 保守恢复；不把它当自动继续任务 |
| 目标最终响应/源释放 | 先提交目标，再释放旧源；清理失败留 source handle | 设计应保留；F02 可绕过“清理失败”判断 |
| 正常 stop/start | 历史保留，原生上下文结束，但没有持久警示 | F04 |
| Worktree 删除前检查 | 普通 dirty/ignored/locked/bound 会拒绝 | Git 状态本身及检查边界仍不安全，F01 |
| 设置超时 | 配置锁解除，原 RPC 仍可能继续 | F05 |
| 安装失败 | launcher 原子替换，运行文件集合原地更新 | F06 |

### 维护性与扩展性

职责分包合理，当前规模不需要引入新的 Runner、队列服务、云状态机或完整插件市场。实质问题集中在跨进程事实与内存/SQLite 状态之间的边界：`exitedConfirmed` 命名承诺过强；settings 超时没有独立未知结果处理；Handoff 材料版本由多个可独立残留字段共同决定。应优先修复这些窄边界，而不是推翻 Generic Runtime。

TUI 主要负责交互/投影，没有掌握提交、审批和 Handoff 的权威状态机。它仍依赖服务端准确提供原生上下文是否存在，F04 表明仅有 runtimeStatus 不够表达这个边界。

## D. Test Coverage Assessment

### 实际运行命令

| 命令 | 本轮结果 |
| --- | --- |
| `bun install --frozen-lockfile` | 通过，259 installs / 354 packages，no changes |
| `bun run typecheck` | 通过，包括独立 Daemon tsconfig |
| `bun run lint` | 通过，71 files，无修改 |
| `bun run build` | 通过，CLI/Daemon/辅助库构建完成 |
| `bun run test`（初始 Shell） | 失败：PATH 没有 node，Bun 以自身处理 node:test，报 `Cannot use afterAll() outside of the test runner`；未执行成完整测试 |
| `PATH=/home/clj/.nvm/versions/node/v24.18.0/bin:$PATH bun run test` | **70/70 Node 集成 + 32/32 Bun/Solid，全通过，0 fail/skip** |
| `git diff --check` | 通过；初始串行基线因 test 失败未走到这一命令，后续已单独执行 |
| 8 类定向反例探针 | F01 两种、F02、F03、F04、F05、F06、F07/F08 共用断言探针均按报告所述复现 |
| 额外深嵌套 ACP 样本 | 约 10,000 层、约 60 KB 合法 JSON；连接失效、Turn 为 UNCERTAIN、无自动重试；普通 shutdown 拒绝未确认 Worker，未将此拒绝当产品崩溃 |
| OpenCode 三入口 isolated | 均未通过；具体停点见 E 的兼容性表 |

测试日志：[完整基线日志](/tmp/hhu-official-audit-baseline.log)。Node 集成约 132 秒，Bun UI 17.40 秒、169 个 expect。性能样本为 20,000 chunks 增量投影 24ms、20 展示段、10,000 历史项每页最多 60 个挂载项。

Node 初始 PATH 问题属于本次执行环境；仓库安装文档已经要求 Node 24.18+ 在 PATH，没有把它列为产品缺陷。只对审计进程临时补 PATH，没有修改用户 Shell 配置或安装运行时。

### 有效覆盖

现有测试确实启动 Node Daemon、SQLite 和 Mock ACP 子进程，覆盖并发 requestId、非法 optionId、竞态审批、cancel 尾事件、断流/退出、真实 TCP/WS 断线补拉、Daemon 崩溃、Handoff 重放保护、Git Worktree 脏文件/锁、安装锁、迁移失败和备份读取。UI 测试通过实际 renderer 与 HTTP/SQLite 操作验证多行输入、草稿 CAS、Ctrl+C 顺序、成功工具折叠及手动展开、历史分页/滚动、归档/确认删除和原文复制。这些应保留。

### 盲区和假阳性

- F07 外键测试和 F08 真实验证脚本存在具体断言缺陷，已单独分级；不能只引用测试名或 passed 字段。
- 后代测试只覆盖“持有 stdio”，没有“不持有 stdio 但仍写文件”。
- Worktree 只覆盖检查前的普通脏文件，缺少 index 隐藏修改、检查后新写入。
- 正常重启验证历史存在，没有验证下一条消息的原生上下文边界。
- Handoff 组合故障路径缺少报告材料与实际 Prompt 一致性断言。
- 模型/模式设置缺少迟到响应/超时后新 Turn；安装缺少部分构建失败后的旧版本完整性。
- 20,000 chunks 投影和 2,505 事件补拉不是长时间 RSS/FD/SQLite 增长测试。未验证数日后台运行、慢消费者积压、百万事件或大型 Conversation 导出时的峰值内存/响应时间。
- 真实 Harness 的审批、取消、Handoff、恢复不能由 Generic Mock 全部代替；Windows 物理终端不能由 Linux PTY/Kitty 注入代替。

没有为了复现修改已有测试断言，也没有把审计用失败注入加入标准测试计数。

## E. Security Assessment

### 已确认的风险

F01 是用户文件安全阻断；F02 是后台进程失管及并发写入风险；F05 使原生模式/模型显示与真实状态分离。F03 的旧上下文可能影响后续改动正确性。其余确认缺陷及影响已在 B 节分级。

本轮未确认 Bearer 绕过、跨 Conversation 审批、自动允许、shell 参数注入或网络重试重复投递。这个结论限于已审代码/测试，不是对任意恶意同 UID 进程的安全保证。

### 正面证据

- Hono 只监听 `127.0.0.1`；HTTP 和 WS 共用随机 Bearer/时序安全比较；带非空 Browser Origin 的请求在升级前拒绝。错误 Token/Origin 的实际 wire 回归通过。
- 私有文件使用 0700/0600。SQLite、WAL/SHM、备份和日志有 owner/regular-file/link 检查；openStore 在 SQLite 打开之前校验目标，避免先触碰 symlink 指向文件。实例读取检查权限、身份、版本；未根据未认证的旧 PID 直接 kill。
- CLI 导出只新建 0600 文件，拒绝覆盖；日志轮转实测通过。结构化凭据字段在 raw/normalized/debug 中脱敏，普通 Markdown/源码文本保持原样。
- Profile 不执行 Shell 展开；已知凭据名 env override 被拒绝。命令/args 作为用户显式定义的 ACP 启动描述执行。未读取或改变四种原生 Agent 的 Key/模型/Base URL。
- `clientCapabilities` 如实声明 fs/terminal=false，未实现回调返回 method-not-found。原生工具与原生权限仍由 Agent 自己处理。

### 接受的设计边界与未验证风险

1. 自定义 ACP 命令具有当前用户权限，HarnessHub 不是工具沙箱。内部 Handoff 报告通过 Prompt 要求不使用工具；一旦观察到 tool_call，会保留证据并要求降级确认。该机制不能撤销 Agent 已做的副作用，不能把“READ ONLY”文案当系统级约束。
2. Handoff 背景和新消息在一个 text content block 中使用文本标记区分，真实用户消息另有 DB 字段。报告/历史本身仍是不可信模型/仓库内容，标记可被文本伪造；没有独立的角色级安全隔离。当前没有复现绕过原生审批，因此列为提示注入残余风险，不另列确认漏洞。
3. 自由文本可能含凭据；保真要求下不会扫描/改写全部输出。私有数据库/导出仍须视为敏感数据，Profile args 或非标准名称也不构成凭据库。
4. 锁定 ACP SDK 2.2.0 的本地源码具有默认 **32 MiB 单消息限制**，并非完全无限行；不能仅因 Worker 没传 maxMessageBytes 就报告“没有任何帧上限”。但 aggregate 事件量、WS 慢消费者、全量导出和 TUI 全历史常驻仍缺实测资源预算。
5. `RuntimeStore.exportConversation()` 一次读取全部事件，并构造 messages/markdown；`Transcript.events` 保留补拉的全部 raw/normalized 事件。挂载 60 行只限制渲染节点，不限制整个 Conversation 的内存。未进行 OOM/磁盘耗尽破坏性测试，也未测出具体泄漏率，作为长期使用风险，不伪报已确认泄漏。
6. 备份没有自动删除策略，这是保留用户数据的取舍；日志有轮转不代表数据库和备份永久有界。已有备份可读/迁移失败可回滚已验证；完整人工恢复流程、断电耐久性及长期容量仍未逐项实测。
7. 同 UID 任意代码可以访问用户工作区和原生登录环境，local-first 的 Bearer 不提供针对该主体的隔离。没有把这一明确产品边界写成远程安全漏洞。

### OpenCode 独立复核

检查了 `scripts/verify-opencode.mjs`、`verify-phase6.mjs`、当前 Generic Runtime、Phase 6 的真实原始导出，以及最终跟进原始证据。没有读取原生配置或凭据文件。

本轮执行以下三个独立新环境，未对相同请求重试，未切换模型/权限，未自动回答审批：

```bash
export PATH=/home/clj/.nvm/versions/node/v24.18.0/bin:$PATH
node scripts/verify-opencode.mjs cli isolated
node scripts/verify-opencode.mjs acp isolated
node scripts/verify-opencode.mjs runtime isolated
```

实际安装版本为 OpenCode 1.18.32。脚本每次新建临时项目和 XDG；纯文本未通过即停止，不进入读文件/pwd 阶梯。

| 入口 | 本轮证据目录 | 实际结果 |
| --- | --- | --- |
| 原生 CLI | `/tmp/hhu-opencode-followup-kzseLi` | 纯文本约 120,003ms 无成功响应；SIGINT 后约 126ms 退出；passed=false |
| 不经 SDK 的 ACP | `/tmp/hhu-opencode-followup-p3iG8d` | initialize/session/new 成功，协商 `opencode/big-pickle`；约 120,081ms 无文本/工具；cancel 后约 159ms 返回 end_turn、零 usage；session/close 成功，进程 code=0；passed=false |
| HarnessHub Runtime | `/tmp/hhu-opencode-followup-jCgixb` | initialize 成功；session/new 收到 `-32603 / Internal error: OpenCode service failure`，data.service=`directory`；无 Prompt；Session ERROR，普通 Daemon stop 成功；passed=false |

三条路径使用不同临时目录，不能把 Runtime 建会话错误与另外两条的 Prompt 超时合成相同故障。原生 directory 服务为何失败，没有足够证据。本轮退出/取消结果也不能证明模型任务成功。

历史证据复查：

- `/tmp/hhu-real-phase6-mwxQPP/opencode-debug.json`：13 个事件、一次 Prompt、零 Agent 文本/工具，取消后 Turn `COMPLETED/end_turn`。报告的原始失败描述有依据。
- `/tmp/hhu-opencode-followup-PgLqNU/evidence.json`：以前全隔离直连 ACP 同样无文本，cancel 后 end_turn。
- `/tmp/hhu-opencode-followup-Tdp3z1`、`n6kovx`、`zEVv7w`：历史原生登录对照的成功证据可读取。Runtime 的三 Turn 均 COMPLETED/end_turn；同 Turn 原始 read/bash 有 completed 更新，协商 CodeForce 模型，与 Big Pickle 的隔离测试条件不同。

本轮没有重新使用原生登录环境，没有复制认证、改配置或补 Key；历史原生登录成功仅作为已检查的历史证据，不写成本轮真实重测。Big Pickle 上游卡顿、OpenCode 真实 cancelled、Handoff、恢复和各类权限仍未验证。结论是**隔离环境下当前兼容性未通过，根因未定；不能据此确认 Runtime 吞输出，也不能宣称 OpenCode 全面不可用。**

## F. Release Readiness

**工程审查：FAIL。** F01 的未提交文件删除和 F02 的进程失管必须先修复并通过反例回归；F03–F06 也应在宣布“日常可用”前解决。仅通过现有 102 项不能解除阻断。

**最终用户验收：未完成。** Windows Terminal / VS Code WSL 的物理 Shift+Enter、Enter、Ctrl+C 三层优先级、实际鼠标拖选和剪贴板接受情况，没有本轮人工证据；Linux PTY/renderer 的结果不替代它们。修复工程阻断之后，仍需分别填写现有 [Windows 双终端清单](/home/clj/HarnessHub/HarnessHub/docs/acceptance/windows-terminal-checklist.md)。

**真实 Harness 验收：部分历史证据可核验，本轮不宣布全面通过。** OpenCode 当前隔离对照未通过；其他 Harness 没有在本轮重新发真实任务，沿用历史证据的范围须明确。原生恢复没有被实现为自动 resume，这一保守边界应保留。

本审计不建议进入 Phase 7，不建议以新增功能替代上述修复。可以继续在隔离数据和临时项目中作开发验证。

## G. Remediation Plan

按风险和依赖关系建议最小顺序：

1. **F01：先停止不安全物理清理。** 拒绝 index 隐藏状态，并解决外部写入期间的保留策略；用真实临时 Git 仓库证明未提交 tracked/ignored 数据不会被清理删除。
2. **F02：修正 Worker 退出事实。** 覆盖后代继承/不继承管道、Adapter 先退出、合作/拒绝退出，核对目标接管、删除和 Daemon stop 不丢句柄。保持无默认 force、避免误伤其他 Conversation。
3. **F03/F04：修正上下文材料与原生会话边界。** 验证降级确认/准备失败/重试组合，以及正常 stop/start/显式 Session stop 后的明确新会话提示。继续禁止不确定 Prompt 重放。
4. **F05：让设置超时进入可追踪的未知结果处理。** 在迟到响应前后测试真实显示/运行模式，阻止未决设置与新 Turn 交叠。
5. **F06：发布产物集合先构建后切换。** 失败、中断和成功升级均核对旧 launcher 所引用集合；保留现有 flock 与严格版本保护。
6. **F07/F08：修正验收谓词。** 外键反例必须命中正确错误码；真实工具验证必须关联同 Turn/成功终态和实际输出。不要为使结果变绿降低标准。
7. 运行冻结安装、typecheck、lint、build、完整现有回归及上述针对性回归；再做真实多 Harness 消息/工具/取消/用户原生审批/Handoff，以及目标 Windows 双终端人工验收。真实任务使用新的隔离请求，不自动重放旧 UNCERTAIN。

不需要 Redis、云服务、独立 Runner、统一模型代理、大型状态机框架或与 MVP 无关的重构。

## H. 审计证据、范围和交付核对

### 本轮覆盖

已阅读 AGENTS、架构/实施计划、COMPATIBILITY、OPERATIONS、Phase 1–6、Phase 4 Refinement 及最终 OpenCode 跟进记录；审查全部生产模块（CLI/lifecycle/agent、Daemon/routes、ACP、core/runtime/handoff/worktrees/changes、storage/schema/migrations、shared/client/paths/DTO、TUI 及其内容/草稿/输入/复制模块）、安装构建测试入口和核心集成/UI 断言。文档用于定位设计承诺，确认发现均以源码和实际反例为依据。

实际环境：WSL2 Linux x64，kernel `6.18.33.2-microsoft-standard-WSL2`，Node 24.18.0，Bun 1.4.4，Git 2.53.0，SQLite 3.53.4。没有更新任何依赖。

### 本机复核入口

定向探针源代码与结果保留在 `/tmp/hhu-official-audit/`，完整基线日志为 `/tmp/hhu-official-audit-baseline.log`。临时文件可能被系统清理，报告 B 节同时记录了关键前提、边界和结果，不应把 `/tmp` 当永久归档。

```bash
export PATH=/home/clj/.nvm/versions/node/v24.18.0/bin:$PATH
node /tmp/hhu-official-audit/probe-worktree-flags.mjs
node /tmp/hhu-official-audit/probe-worktree.mjs
node /tmp/hhu-official-audit/probe-worker.mjs
node /tmp/hhu-official-audit/probe-handoff.mjs
node /tmp/hhu-official-audit/probe-restart.mjs
node /tmp/hhu-official-audit/probe-settings.mjs
python3 /tmp/hhu-official-audit/probe-install.py
node /tmp/hhu-official-audit/probe-assertions.mjs
```

core 探针使用当前源码在临时目录构建的 Node bundle；Worker 探针直接使用本轮构建的 `dist/acp/index.js`；安装探针使用副本中的真实 build/install 脚本。所有探针中的写入、index 标志和删除只针对其新建临时仓库/副本，不应将这些故障注入操作用于用户项目。

各本轮 OpenCode CLI/ACP 子进程已退出；Runtime 隔离 Daemon 正常停止、实例文件移除。Worker 写文件反例后代使用 SIGINT 清理；其余正常完成的 Mock 已合作关闭。本轮没有对用户默认 Daemon/Worker 发停止或强制信号。深嵌套样本的普通 shutdown 拒绝保留在日志中；其探针退出后子进程也已退出，末尾进程检查未发现本轮故障 fixture 遗留。

最终交付为本报告，审计结论 **FAIL**；计数 **P0=1 / P1=1 / P2=4 / P3=2**。下一步先修复用户文件清理与 Worker 退出确认，再按 G 节完成回归和人工验收。
