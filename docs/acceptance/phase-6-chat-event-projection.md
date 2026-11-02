# Phase 6 补充：正常聊天与 ACP 内部诊断分离

2026-11-01。本次仅修复展示投影及相关测试，沿用当前 MVP / SQLite schema 6，无数据库迁移或历史清洗。没有改动 ACP 请求、Runtime 状态机、原生事件内容、Agent 配置或审批语义；工作区原有的会话命名等改动保留。

## 根因与实现

原 `chatVisible()` 只排除有限的控制事件，所有未命中事件最终生成 `kind: "raw"` 聊天行。`runtime.worker_started` 和 Runtime 规范化后的 ACP `custom` 因而把进程及认证元数据直接带入正常聊天。

`Transcript` 现在先做语义投影，再生成明确的 text / tool / plan / notice / handoff 行，取消通用 raw 聊天兜底。实时增量和历史加载使用同一个投影；全部事件仍进入原始事件集合，SQLite 写入及 Raw Events / Debug 路径不变。

| 分类 | 实际事件或判据 | 默认呈现 |
| --- | --- | --- |
| CHAT_CONTENT | `user.message`、`user_message_chunk`、`agent_message_chunk` | 保留原文、Markdown、流式消息及来源 |
| AGENT_ACTIVITY | `agent_thought_chunk`、`plan`、`tool_call`、`tool_call_update` | 公开 Thinking、结构化 Plan、原生工具及结果；沿用工具展开规则 |
| USER_ACTION_REQUIRED | `approval.requested`、FAILED `handoff.record` | 原生权限选项/工具及既有 Handoff 降级确认入口；不自动决策 |
| USER_NOTICE | ACP error 信封、错误事件/扩展方法、error/fatal 等级、warning 等级/事件；`runtime.session_error`、`runtime.context_ended`、`runtime.interrupted`、`runtime.worker_lost`、`runtime.workspace_warning`；ERROR/UNCERTAIN/CANCELLED 的 `runtime.turn_finished`；普通 Handoff 记录 | 简明真实信息，长文本可展开，`r` 查看完整原始/规范化来源；保留实际 reason、错误码及错误详情来源 |
| INTERNAL_DIAGNOSTIC | Worker 启动、READY、正常结束、设置及取消等普通 Runtime 生命周期；initialize/authenticate、`acp.response` 成功响应、session/fs/terminal 控制消息、能力/模型/配置/用量更新；`custom.authStatus` 和认证/配置/网关扩展元数据；内部 Handoff 事件 | 仅 Raw Events / Debug，无聊天卡片 |
| UNKNOWN_EXTENSION | 未识别的事件，包括规范化为 `custom` 的新扩展 | 只有明确的 `content.text` / `text` / `message` 才形成简洁通知，默认最多 180 字符，`e` 展开，`r` 看完整来源；label/detail、任意嵌套字符串及纯元数据不形成卡片 |

错误信封及真实故障/警告优先于普通控制元数据过滤；未知扩展的错误方法与 `sessionUpdate` 也参与判断，避免 Runtime 将方法归为 `custom` 后隐藏真实错误。已识别的消息/工具不按其文字内容做关键字过滤。

隐藏成功结束事件后，仍结束对应消息的 streaming 状态；隐藏审批完成事件后，仍解除工具的 waiting 状态并保留其来源。没有把视图过滤变成状态机操作。

## 文件与 UI

- `apps/tui/src/transcript.ts`：六类语义投影、明确行类型、原始来源及隐藏事件的展示状态收尾。
- `apps/tui/src/native-events.tsx`：独立 Plan 和紧凑通知，不再渲染通用 JSON；空状态、简洁执行指示及 Chat 标识。原始来源仍可完整查看/复制。
- `apps/tui/src/agent-pane.tsx`：使用真实 Conversation Runtime 状态显示执行指示，保留原有审批、草稿、Handoff 和 Debug 入口。
- `apps/tui/src/index.tsx`：删除、重命名、复制等操作反馈在 5 秒后消失，卸载时清理计时器。
- `tests/e2e/phase4.test.tsx`：修正要求普通聊天展示任意 custom JSON 的旧断言，新增七项测试覆盖下表。长历史改用不同 Turn 的真实用户消息，明确断言 10,000 行及首尾内容；跨页测试明确断言 120 行，保留挂载上限、滚动锁定、底部跟随和恢复断言。
- `tests/e2e/tui.test.tsx`：同步简洁空状态文案。
- `tests/fixtures/mock-acp/server.mjs`：仅显式开启的测试 Profile 在握手中发出 `_auth/status_update`，复现真实 Codex authStatus，再回答 hello；默认 fixture 行为不变。

## 自动化验收

| 请求场景 | 验证 |
| --- | --- |
| 1 / 新 Conversation 的 worker_started | 真实 Node Daemon + Mock ACP 启动后 Chat 为 0 items，显示空状态 |
| 2 / Codex authStatus custom | 与实际 Codex 相同的 authStatus 形状及扩展方法；Chat 不含 authStatus、网关、进程 JSON |
| 3 / Debug 完整来源 | RawEvents renderer 分别显示 Worker 和认证事件；OSC52 复制后逐对象核对完整事件；SQLite/HTTP 重读不变 |
| 4 / Agent 回复 | 从 TUI 输入 hello，用户和 Agent 两行正常显示 |
| 5 / Thinking、Plan、工具、审批 | 实际 OpenTUI 帧断言内容及原生选项，审批完成后 waiting 正确解除；既有折叠、失败工具和手动展开测试保留 |
| 6 / 错误与上下文警告 | 协议错误、Runtime reason、未知扩展错误、opaque error、warning、context_ended 保留；`r` 可查看完整错误 data 和 code |
| 7 / 有可见文本的未知扩展 | 默认紧凑、`e` 展开全文、`r` 显示额外来源字段，复制文本不改写 |
| 8 / 纯元数据未知事件 | 分类矩阵要求无可见文本的 label/detail、嵌套元数据不进入 Chat |
| 9 / 旧历史 | JSON 历史重放与实时分批投影一致；TUI 卸载重开读取持久化事件仍为两行；另只读重放既有真实 Codex SQLite 历史 |
| 10 / 诊断洪泛 | 10,000 条 Worker/auth 诊断产生 0 行；加入 hello/回复/成功结束后精确为 2 行，全部原始事件保留 |

执行命令：

```bash
bun run typecheck
bun run lint
bun run build
bun run test
git diff --check
```

最终 `bun run typecheck`、`bun run lint`、`bun run build`、`git diff --check` 均通过。最终 `bun run test` 完整 runner：**84/84 Node 集成 + 49/49 Bun/Solid TUI = 133/133 通过，0 失败/跳过**；Node 约 200 秒，TUI 27.02 秒、352 个 expect。TUI 证据目录 `/tmp/hhu-phase4-ui-aSetK4` 与 `/tmp/hhu-mouse-sidebar-xOhYKK`。最终检查日志：`/tmp/hhu-chat-projection-typecheck-final.log`、`/tmp/hhu-chat-projection-lint-final.log`、`/tmp/hhu-chat-projection-build-final.log`；完整回归日志 `/tmp/hhu-chat-projection-full-final.log`。初轮定向/全量失败日志仍保留在 `/tmp/hhu-chat-projection-ui.log`、`/tmp/hhu-chat-projection-full.log`，不计为通过。定向最终语义矩阵通过，日志 `/tmp/hhu-chat-projection-semantic-final.log`。

## 真实 Codex 验证

隔离的临时 XDG、项目及 HarnessHub Daemon，仅向新 Codex 会话发送一次 `hello`，没有读取/修改原生模型配置，没有审批应答或重复发送。证据目录 **`/tmp/hhu-chat-real-AGjKcj`**，摘要日志 `/tmp/hhu-chat-projection-real.log`；探针源码归档为目录内 `probe-source.mjs`。

- 真实启动事件：`runtime.worker_started` → initialize → acp.response → session/new → `custom`（`_auth/status_update`）→ acp.response → runtime.session_ready。7 条事件生成 **0 聊天行**，`startup-frame.txt` 显示空状态。
- 真实 cwd 等于临时 Project root。hello Turn 为 **COMPLETED**；27 条事件生成 **2 聊天行**。`hello-frame.txt` 显示 hello 和实际回复，无 workerPid/processGroupId/authStatus JSON。原生消息中的模型 metadata 警告文字仍原样保留，它属于 Agent 实际输出；没有按消息内容重写或隐藏。最终源码对该真实事件导出再渲染，精确确认实际回复文本可见、仍为两行，见 `final-hello-frame.txt`。
- 全部事件存于私有 `events.json`；新建 Transcript 重放与实时投影一致。关闭后只读核对 SQLite，27 条原始/规范化事件逐对象相等，关闭流程追加事件后共 30 条，见 `sqlite-check.json`。
- 只读提取此前真实 Codex 验证库 `/tmp/hhu-audit-real-ZlnsM3/data/harnesshub/harnesshub.db` 中的 10 条旧事件，以当前代码重放：仅 **1 条 context_ended 警告**可见，其他控制/认证/Worker 元数据保留在来源集合，见 `legacy-replay-check.json`。没有修改旧库。
- 普通 Daemon stop 成功，实例文件已移除，没有 force 终止真实 Harness。

## 用户待验收与限制

Windows Terminal / VS Code WSL 的物理鼠标、系统剪贴板及键盘本轮**未验证**。自动化 renderer 回归包含侧栏鼠标、选择自动复制、Ctrl+C、草稿、历史滚动、审批、取消和 Handoff，但不代替真实终端验收。

手动步骤：启动此构建的 TUI → 新建 Codex Conversation，确认只有空状态；发送 hello，确认无启动/认证 JSON；Ctrl+P → Raw Events / Debug，确认完整启动及认证事件仍在；重开旧会话，确认使用相同规则。原生工具、公开 Thinking、Plan、审批、错误及 context_ended 应正常可见。删除会话的操作反馈应在约 5 秒后消失。

本轮未重新调用 Claude/Grok/OpenCode 的模型，不扩大既有兼容性结论；没有操作默认用户数据库或全局安装。源码构建不会替换已有独立安装发布，需按 OPERATIONS 安全更新安装后再从全局 `hhu` 验收。没有开展新阶段或其他大型功能。
