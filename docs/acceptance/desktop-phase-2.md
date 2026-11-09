# Desktop Phase 2 验收记录

日期：2026-11-09 UTC（Windows 测试环境）；仅 Desktop Phase 2。实现 Windows Electron 正式聊天与现有 WSL ACP 后端交互，没有进入 Phase 3 Changes/Handoff 完整工作面板或 Phase 4 安装发布。

## 交付与边界

正式输入、流式 Markdown、工具卡、原生审批/取消、ACP settings/commands、草稿 CAS/请求查询、Conversation 管理和增量事件传输已实现。源码完成不等于全部真实 Harness 验收通过：**Codex 本轮收到原生网关 502 / invalid_prompt，零工具调用；Grok 的流式回复与两个工具调用通过。** Claude/OpenCode 本轮没有真实调用，不声称其认证/模型链路已验证。

前置审查覆盖 AGENTS、架构 01/02/03、DESKTOP、Phase 1 验收、Desktop Main/Renderer/contracts、TUI draft-session/transcript/slash-commands、core runtime 与 Daemon routes。所有业务沿用既有后端；未新增 Daemon API、schema 迁移、Agent Runtime 或 Windows 执行器。原生模型/API Key/Base URL 配置未读取或修改。

## 代码与交互

- `apps/desktop/src/contracts.ts`：strict discriminated union，明确写入/查询 Action 与响应；仍无任意请求能力。
- `main/actions.ts`：固定映射已有 Daemon API，校验请求/Turn/Approval 会话归属；Main 对提交并发加锁。`connection.ts` 负责版本/身份、seq 连续分页、epoch、选择隔离、快照过期防护、增量 IPC、原生交互状态。
- `main/window.ts`：保留 Main 持 Token、精确 IPC 来源、sandbox/contextIsolation/CSP、禁导航/新窗口；加入原生 Edit 菜单与文本复制。正常关闭先由 Renderer 保存草稿，再固定关闭 Action 结束窗口，不调用 cancel/stop。
- `renderer/drafts.ts`：不依赖 React/TUI 生命周期的每会话队列；每次编辑串行 CAS 自动保存，切换/关闭 flush；冲突不覆盖服务器，保留本地文字供复制/显式重载。失败不会被自动提升成新请求。
- `Composer.tsx`：Enter/Shift+Enter，isComposing/229/compositionEnd 防误发，自动高度与内部滚动；Windows Ctrl+C/V/A/Z/Y 原生编辑。仅当前 READY Session 的实际 ACP modes/config/commands；Harness 切换后旧命令失效，未发布命令准确说明。Slash 搜索、↑↓/鼠标、Tab/Enter 只补全，再次明确发送才执行。
- `history.ts`、`Message.tsx`：复用 shared/event-projection；诊断不进聊天，公开 Thinking/Plan/警告原文保留；原生工具按 NativeSession + Turn + toolCallId 合并，防重复 ID 跨 Harness/Turn 混淆；成功折叠，运行/失败/审批展开，手动选择优先。完整工具内容及原生 Diff 来源可查看、复制。交接记录按 Handoff ID 合并，历史报告可展开/复制，不引入完整工作面板。
- `Markdown.tsx`：锁定 react-markdown 10.1.0、remark-gfm 4.0.1、lowlight 3.3.0；标题/列表/表格/引用/代码高亮，复制原代码。无 rehype-raw、无 dangerouslySetInnerHTML；HTML 跳过，链接仅显示可复制文本，图片不发网络请求。lowlight 仅转 React span/text。
- `ConversationDialog.tsx`、App：项目新建、显式 Linux workspace 独立会话、重命名、归档/恢复、搜索、删除确认。删除沿用后端关闭所属任务/Worker 的安全规则，保留项目源码、Git 分支与 Worktree。
- `apps/desktop/tests/*`、`tests/integration/desktop.test.mjs`、Windows 脚本和 `tests/e2e/desktop-companion.py`：单元、真实 SQLite/WS/Mock ACP、Windows 实际窗口与并行 TUI PTY。

## IPC 与提交链路

| Action | 固定后端能力 / 限制 |
| --- | --- |
| `draft.load/save` | GET/PUT Conversation draft，revision CAS，schema 限制文本长度 |
| `turn.submit` | Main 先 PUT draft 保留 pendingSubmission，然后 POST turns；相同会话 Main 并发锁 + 后端 requestId/hash 去重 |
| `request.lookup` | GET `/v1/requests/:requestId`，校验 conversationId，仅查询，无重发 |
| `turn.cancel` | 查询 Turn 归属与状态后调用 ACP cancel；拒绝 UNCERTAIN，无 kill/force 入口 |
| `approval.decide` | 验证当前待决审批归属，再交后端一次性原子决策与原生 optionId 校验 |
| `harness.select`, `session.prepare/settings` | 选择不启动模型；显式准备 session；仅后端实际支持的选项可写 |
| `handoff.action` | 原有 retry/confirm/cancel，失败与降级不自动批准；UNCERTAIN 没有伪安全重试 |
| `conversation.create/standalone/patch/delete` | 明确项目 ID/现有 Linux 工作目录/标题/归档/confirmed=true；无任意文件操作 |
| `history` | 只读固定 Conversation events，每页 200，非负整数 after |
| `clipboard.copy`, `window.close` | 只写指定文本到剪贴板；保存草稿后关闭当前窗口；不访问 shell/Agent |

真实链路：Windows React → sandbox preload → Main exact schema + sender/mainFrame/URL → WSL Daemon draft CAS → turns requestId/hash → 既有 ACP Worker（cwd=Conversation.workspacePath）→ SQLite 原始/结构化事件 → WS 提醒 + HTTP 连续补拉 → Main 增量 IPC → Renderer 投影。审批完全由用户选实际原生选项。

Runtime 在接受 Turn 时消费匹配草稿。HTTP/IPC ACK 丢失保留本地 requestId，SQLite 若未消费则保留 pendingSubmission；关闭重开不会自动发送。明确 400/409 拒绝可释放匹配保留草稿，其他未知结果必须查询。404 不作为安全重发许可。请求存在但执行 UNCERTAIN 仍显示真实状态，不能伪装取消或继续。

## 流式性能

WS 失效通知按 40ms 合并；首次与补拉按 200 条/页验证连续 seq；Main 保存 eventCursor 与最多 200 条尾部，新 IPC 只带新批次，不带全部历史。Renderer 初始附着或缺口用 typed history 分页补齐。Main metadataRevision 防止较早的快照覆盖已完成的 Harness 选择。

聊天投影 O(新增事件)，工具 Map 查找、稳定 row ID、memo 消息组件，流式消息按约 16k 文本分段。每次挂载至多 100 条消息；较早/较新页和“回到最新”可访问全部历史。手动滚动暂停跟随，当前阅读页固定，工具展开状态保留。

**限制**：Renderer 仍在内存保留所选会话的完整已读 raw events 和投影；超大单条工具输出也不截断语义。并非无限历史恒定内存方案。Main 有界、IPC 无全历史重传、DOM 有界；SQLite 原始事件未删减。分页不是连续虚拟滚动，后续若改为连续虚拟列表需单独验证变高工具卡与滚动锚点。

## 自动化与实机结果

最终命令结果及日志见本目录 `evidence/desktop-phase-2`。本轮也记录过开发中失败并修复：关闭 beforeunload 二次循环、测试输入缺少 Chromium char 事件、选 Harness 后快照延迟、历史按钮必须先滚入视口。

| 命令 | 结果 |
| --- | --- |
| `bun run typecheck` | 通过根工程、Daemon、Desktop 独立检查 |
| `bun run lint` | 通过（131 个文件） |
| `bun run build` | 通过 CLI/Daemon 构建 |
| `bun run desktop:build` | 通过 Main/Preload/Renderer 构建 |
| `bun run desktop:test` | 27 项单元/安全/渲染 + 12 项真实集成通过 |
| `bun run test` | 101 项 Node 集成 + 116 项 TUI/UI 全部通过；开发中失败历史见下文 |
| `git diff --check` | 通过 |
| Windows Electron + WSL | 实际 Windows x64 Electron 45.2.3、Ubuntu-26.04 WSL2；见 Windows evidence |

覆盖：正常/重复发送，CAS 与跨会话恢复，HTTP ACK 丢失只查询，IME/Enter/Shift+Enter，实时流与手动滚动，10k 事件投影和 2500+ SQLite 事件，600 工具/1200 更新有界 DOM，工具合并/手动展开，双客户端仅一次审批，受控取消，真实 ACP config/Slash 命令，Harness 仅选不调用/Handoff 失败，Conversation CRUD，Daemon 重启/seq 补拉，关闭 Desktop 后 Worker 存活，Token/任意 REST/来源校验。

真实 Windows 验证使用实际窗口、Chromium、鼠标/键盘事件、wsl.exe、HTTP/WS/SQLite。另启动真实 `hhu` PTY，与 Desktop 同时连接同一 Daemon；TUI 看见 `native-34` 流式输出，退出只关闭该 TUI。Mock 审批明确点击原生 Reject，未自动批准真实 Agent。

## 真实 Harness

真实调用从 Windows 文本框输入并点击发送，不由测试 HTTP 绕过 Composer。临时独立 Conversation，临时现有 Linux workspace，原生 HOME/PATH 仅继承；不读取原生配置，不改模型或权限。

| Harness | 本轮证据 | 结论 |
| --- | --- | --- |
| Codex | requestId `41d9c9c0-734e-46ed-840b-eb8512a2b178`；17 个回复 chunks；原生 `COMPLETED/end_turn`；0 工具 | **工具验证受阻**。原生回复含 `unexpected status 502 Bad Gateway`、`invalid_prompt` 和上游安全限制说明；Runtime COMPLETED 不能证明任务成功。没有绕过网关、换配置或自动重发 |
| Grok Build | requestId `f7585632-f152-4862-a721-0d0aab0de8d5`；71 回复 chunks；2 工具完成 | 通过消息/流式/工具；原生 pwd 输出为绑定临时目录，read_file 输出 `HARNESSHUB_DESKTOP_PHASE2_世界` |
| Claude Code / OpenCode / 其他自定义 Profile | 通用 Desktop/Mock ACP 路径覆盖；本轮未执行真实模型 | **未验证**，不推断认证/网关可用性 |

原始 Codex 失败文字与 Grok 工具参数/输出保存于 `real-*-observable-events.json`；摘要 `real-harness-evidence.json`。真实截图捕获曾有 Windows compositor 旧帧（Grok 截图显示旧 Codex 页），因此没有将该旧图作为 Grok UI 成功证据；Grok 结论依据 requestId 对应 SQLite ACP 输出。Windows Mock UI 另有有效截图。

## 用户待验收与限制

1. 日常 Windows 环境启动 Desktop，选择 WSL；确认 Project/Conversation、Harness、Workspace；创建测试会话，中文输入法候选 Enter 不发送、Shift+Enter 换行、Ctrl+C/V/A/Z/Y 实际物理键盘行为。自动化 IME 是 Chromium composition/isComposing 事件，真实中文输入法候选窗口仍**待人工验证**。
2. 与 WSL TUI 同时编辑草稿，观察 CAS 冲突、本地复制和显式重载；断网时保留内容，重连只查询 requestId；正常关闭重开草稿。断电/强杀 Windows 无法保证未 ACK 的最后几个字已落 SQLite。
3. 原生工具展开/完整复制、Thinking、Plan、Markdown 表格/代码，长历史较早/较新页，阅读中不被新流强制拉走。极大工具输出的 GPU/内存上限、百万事件规模**未验证**。
4. 用户亲自选择真实审批选项；取消只用 ACP；确认 UNCERTAIN 提示。Handoff 正常路径已有后端回归，Desktop 只交付状态/失败/降级操作，跨真实 Harness 的 Windows Handoff 本轮**未验证**。
5. 在可用网关恢复后，重新明确提交独立 Codex 测试任务补齐工具验收；Claude/OpenCode 的真实 Windows 交互、各种自定义 Harness 能力仍待验收。
6. 100%/110% 自动化窗口缩放与窄屏已测；125%/150%、多屏、物理鼠标、VPN/企业网络策略仍**未验证**。正常关闭只保活 WSL 内后台，不承诺 Windows 重启/WSL shutdown 后 Worker 存活。

全量回归曾暴露 `phase4.test.tsx` 的 conversation header 布局断言（可用高度 19，预期 >=20）及 `paste-blocks.test.tsx` 的 selected paste marker 行删除断言，属于同时变化的 TUI 输入布局/粘贴工作区。没有覆盖该并行实现或放宽断言。并行实现更新后，两项定向复测通过，再次执行完整 `bun run test`，最终 **101 项 Node 集成 + 116 项 TUI/UI 全部通过，0 失败**。最终完整日志已保存。


最终 Windows Mock+真实 TUI 证据目录 `hhu-desktop-smoke-GDk87W`（隔离 WSL `/tmp/hhu-windows-smoke-R2BSEU`），`passed=true`，包括实际会话管理弹窗和 600 工具历史。真实 Harness 为 `hhu-desktop-smoke-0MZ6AH`（`/tmp/hhu-windows-smoke-c9SuZX`）。这些测试的隔离 Daemon 已正常停止，默认用户 Daemon/数据库未操作。

工作区存在同时进行的 TUI 输入/Slash/粘贴修改。未覆盖或提交这些修改；全局检查仅报告实际执行时结果。安装包、全局安装、用户默认库均未替换，没有发布、merge 或自动进入下一阶段。

等待 Desktop Phase 2 验收。
