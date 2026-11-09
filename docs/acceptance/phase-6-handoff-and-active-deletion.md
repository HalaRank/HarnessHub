# Phase 6 交接失败展示与活动会话删除

日期 2026-11-09。当前 MVP 阶段内修复，版本 0.6.1，SQLite schema 6。

## 事故与修复

只读检查用户实际数据库，确认源 Codex 会话 `811e8deb-1e7c-413c-ab55-d897f5a8aa7d` 已为 CLOSED，历史存在 `runtime.context_ended`。失败 Handoff 尚无内部报告 Turn 和目标 Session。源原生上下文已结束，保留的 SQLite 历史需要走用户确认的降级交接。

- 源不可用、报告不完整及目标准备错误分别保存具体原因。未确认结果的已发请求继续保持 UNCERTAIN。
- 检查源会话后才清空旧报告，源已结束时重试保留已生成报告、生成时间和降级材料。已有笼统错误与明确 context-ended 事件同时存在时，旧历史的聊天投影也解释源上下文已结束，原始事件保留原值。
- 聊天交接记录显示状态、错误和上下文完整性提示，报告默认折叠并支持 Enter 展开。降级 JSON、事件序号、Session ID 通过 Source / Raw 查阅，完整材料仍可复制。失败菜单显示具体错误及源会话状态。

## 用户修正的删除语义

确认删除 Conversation 授权取消活动任务及待审批请求，关闭其所属 Worker，并在需要时升级终止不响应的受控进程，再删除应用历史和草稿。FAILED Handoff、UNCERTAIN、准备中或配置中的会话均可使用该入口。

服务端预留会话、暂停队列并阻止新 Turn、重复删除及 Daemon 停机。先等待原生取消，再关闭当前及交接相关 Worker，等待初始化、配置、运行、交接和输入投递的异步写入收尾，最后事务删除应用数据。过程失败时保留记录供显式重试。Project 删除继续预检全部子会话。项目文件、Worktree 和分支的生命周期依照既有规则处理。

## 文件

- `packages/core/src/handoff.ts` 处理具体失败原因与重试材料保留。
- `packages/core/src/runtime.ts`、`pending-inputs.ts` 跟踪异步操作、预留删除、取消、受控进程关闭和队列收尾。
- `packages/storage/src/index.ts` 为 Runtime 已停止受控执行后的显式删除提供级联入口，其他调用保留检查。
- `apps/tui/src/transcript.ts`、`native-events.tsx`、`agent-pane.tsx`、`index.tsx` 修改交接投影和删除确认说明。
- `tests/integration/phase4.test.mjs`、`phase5.test.mjs`、`phase6.test.mjs`、`deletion.test.mjs`、`tests/fixtures/mock-acp/server.mjs` 覆盖故障、去重、初始化、原生设置、排队、审批、交接各阶段、保留的源 Worker 及删除竞态。
- `tests/e2e/phase4.test.tsx`、`phase5.test.tsx` 覆盖真实 API 的删除确认、取消、旧交接回放、宽窄终端和完整来源。
- README、架构、OPERATIONS、本记录与 Phase 6 索引同步当前语义。

## 验证命令

Shell 为测试补齐现有 Node 24.18.0 的 PATH，完整测试使用 umask 022。

```bash
export PATH=/home/clj/.nvm/versions/node/v24.18.0/bin:$PATH
bun run typecheck
bun run lint
bun run build
umask 022
bun run test
HARNESSHUB_BUN=/home/clj/.local/bin/bun node --test tests/integration/phase5.test.mjs
bun test tests/e2e/phase5.test.tsx
bun test tests/e2e/phase4.test.tsx -t 'confirmed deletion cancels'
git diff --check
```

## 自动化结果

最终完整 `bun run test` 退出 0，Node 集成 **101/101**，Bun/OpenTUI **94/94**，共 **195 项**，零失败、零跳过。日志 `/tmp/hhu-handoff-delete-final.log`。最后一次 typecheck、lint、build 和 `git diff --check` 均通过。

定向 Handoff 集成 **17/17**，日志 `/tmp/hhu-handoff-integration.log`。最终旧历史/宽窄显示回归 **5/5**，日志 `/tmp/hhu-handoff-legacy-ui-final.log`。单独的运行中删除 UI 回归 **1/1**，日志 `/tmp/hhu-delete-ui-target.log`。最终完整入口也包含原生设置挂起、待发送队列和保留源 Worker 的删除测试。

保留修复过程记录。首轮完整入口为 Node **99/100**，旧 Phase 6 用例仍要求确认删除保留源 Worker 时被拒绝，新的终止流程使其旧短请求超时。按本次用户语义改为断言确认删除成功、源进程已退出、另一 Conversation 仍存活，并保留 Project 级联预检断言。定向补测还修正了队列测试误用 turns 端点，以及新增旧 context-ended 行之后的测试选中行。对应早期日志 `/tmp/hhu-handoff-delete-full.log`、`/tmp/hhu-delete-latest.log`、`/tmp/hhu-handoff-legacy-ui.log` 均保留，最终结果以上述完整入口为准。

## 实际环境证据

- 真实 Grok 的 RUNNING 会话通过确认删除，API 返回 deleted=true，快照中对应会话已移除，隔离 Daemon 最后正常停止。证据 `/tmp/hhu-real-delete-jLuzxS/evidence.json`，执行脚本 `/tmp/hhu-verify-real-delete.mjs`，日志 `/tmp/hhu-real-delete.log`。原生会话未返回 workerPid，本轮没有通过该字段额外断言 PID。
- 真实 Codex → Grok 交接尝试受阻。Codex 在 ACP 准备阶段超时，用户 Turn 为 ERROR，尚无模型 Prompt，隔离 Daemon 已正常停止。证据 `/tmp/hhu-real-handoff-fix-YIPum7/evidence.json` 及对应私有 SQLite，日志 `/tmp/hhu-real-handoff-fix.log`。本轮真实跨 Harness 交接为未验证，先前验收记录的成功不能覆盖本轮结果。
- 用户原事故的 1062 条持久化事件在临时私有目录只读重放，保留原始降级材料。140 / 40 列、折叠与展开四份终端帧及证据保存于 `/tmp/hhu-incident-replay-vM0FyO`。默认数据库只读检查和回放，不代用户确认降级投递或删除实际会话。

## 限制和待验收

- Windows Terminal / VS Code WSL 物理键鼠未验证。安全升级后打开原失败历史，检查具体原因及 Source，再通过 `/handoff` 查看材料并显式确认降级或取消。另建测试会话执行长任务，确认删除应取消执行并删除会话，取消确认框应保留运行任务。
- Daemon 崩溃后缺少受控句柄的历史进程无法依据旧 PID 可靠终止。显式删除可以删除 UNCERTAIN 历史，历史任务结果仍可能不确定。受控进程退出或异步操作无法收尾时会保留数据并报告失败。
- 本轮构建交付源码及 dist，已安装的独立全局发布仍需按 OPERATIONS 安全停机和重新安装。默认会话未代删，物理终端验收与 MVP 最终验收仍待完成。
