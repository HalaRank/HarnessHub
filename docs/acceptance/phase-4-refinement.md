# Phase 4 UI Refinement 验收报告

日期：2026-10-31。版本：0.4.1；SQLite schema：5。

## 交付结论

本次完成复制 / Ctrl+C、正常聊天事件过滤、Conversation 归档与确认删除、紧凑布局四项反馈。继续使用 Bun + OpenTUI 0.8.0 + SolidJS、Node Hono、统一 ACP Runtime、SQLite 和现有 WebSocket 补拉。没有实施 Phase 5 Handoff / Worktree 管理或 Phase 6 正式发布系统。

本机 typecheck、lint、build、自动化测试通过：**40 项 Node 集成测试 + 28 项 Bun/Solid 界面测试，合计 68 项，0 失败**。真实 Codex 与 Grok 均完成聊天 / 工具 / Markdown / 并发切换 / 关闭 TUI 后保活验证。**Windows Terminal、VS Code WSL 的物理键盘、鼠标和系统剪贴板体验未直接验证，待人工验收。** Linux PTY、renderer 和 OSC52 捕获不替代目标终端人工验收。

## 实现与文件

| 文件 | 结果 |
| --- | --- |
| `apps/tui/src/clipboard.ts` | OpenTUI Clipboard Service、原生 host provider 与 renderer clipboard adapter；按顺序提交复制，host 超时后尝试终端备用；共用 Ctrl+C 决策函数 |
| `apps/tui/src/index.tsx` | 鼠标选区完成自动复制；Ctrl+C / SIGINT 共用入口；归档、查看归档、恢复、删除确认命令；紧凑顶部、侧栏和底部提示 |
| `apps/tui/src/agent-pane.tsx` | 清空输入同步更新原 CAS 草稿；输入内容 1–8 行自适应（另有两行边框）；原生 Harness / 状态 / ACP 模型一行显示；恢复未确认原文操作 |
| `apps/tui/src/source-viewer.tsx` | 保留 y → Enter 复制 Markdown / 代码块 / 原生结果全文，改用同一 Clipboard Service；来源切换与分页不截断复制 |
| `apps/tui/src/transcript.ts`、`raw-events.tsx`、`native-events.tsx` | 控制事件与聊天分类；原始来源全部保留；完整 Raw Events / Debug 入口，每页最多 100 个事件；聊天仍最多挂载 60 项；压缩历史提示 |
| `packages/shared/src/index.ts`、`session-state.ts` | 归档字段、PATCH / DELETE 校验；清空未确认草稿时允许空输入，但保留原始提交预留 |
| `packages/storage/src/schema.ts`、`index.ts` | `archived_at`；归档 / 恢复只改元数据；删除检查与既有外键级联；项目删除也不能绕过不确定任务保护 |
| `packages/storage/migrations/0004_neat_sage.sql`、`meta/*` | Drizzle 生成增量 migration / snapshot / journal；旧 SQL 未改；旧库按既有流程备份后升级 |
| `packages/core/src/runtime.ts`、`apps/daemon/src/index.ts` | 删除前检查活动任务、待审批、UNCERTAIN 与初始化 / 设置操作；正常关闭空闲 Worker；删除期间阻止新 Session / Prompt / 设置；提交后广播元数据 |
| `apps/cli/src/lifecycle.ts`、workspace manifests、`bun.lock` | 补丁版本 0.4.1 防止新客户端连接旧 0.4.0 Daemon；同协议旧实例可经认证和 instanceId 检查后正常请求停止，不向 PID 强发信号 |
| `tests/integration/phase4.test.mjs`、`tests/e2e/phase4.test.tsx`、`refinement-terminal.py` | 新增数据、双客户端、选区、Ctrl+C、SIGINT、布局与预留恢复测试；前三阶段继续回归 |
| `scripts/verify-phase4-render.tsx`、`tests/e2e/phase4-terminal.py`、README | 真实事件原文复制验证适配异步服务；真实 PTY 退出使用空输入 Ctrl+C；操作说明更新 |

## 复制与中断契约

1. 鼠标拖选后松开，通过 OpenTUI 的 `selection` 完成事件自动复制；保留选区以继续复制和支持连续点击。双击选词、三击选行、跨行拖选使用 OpenTUI 原生 selection behavior，没有另造选区模型。
2. Ctrl+C 有有效选区：捕获选中的文本、清除选区、提交复制，不退出，也不修改输入。之后 Ctrl+C 对当前输入重新判断。
3. 无有效选区且输入非空：同步清空输入和本地草稿，继续使用既有 CAS 保存；不退出。空选区不会阻止清空或退出。
4. 无有效选区且输入为空：等待草稿及偏好保存后销毁 TUI。不会调用 ACP cancel、Session stop 或 Daemon stop。取消 Turn 仍是独立的 `c` / 命令面板操作。
5. renderer 保持 `exitOnCtrlC: false`，并将 SIGINT 从默认退出信号中移除；App 注册并清理 SIGINT listener，因此真正的 OS SIGINT 也经过上述判断。SIGTERM / SIGHUP 继续由 renderer 清理终端。
6. Enter / Shift+Enter / Ctrl+J、可配置备用换行、Ctrl+Y 选区复制与 y 原文复制均保留。已格式化 Markdown 的屏幕选区复制所选可见文本；y 可复制完整原始 Markdown 和代码。
7. 未确认提交的草稿被 Ctrl+C 清空时，原 `pendingSubmission`（含 requestId、原文、Harness）继续持久化，不清掉去重预留。`Restore Unconfirmed Message` 只恢复原文供检查；发送仍需用户明确操作，并复用原 requestId。恢复 / 重连不会发送 Prompt。

Clipboard Service 优先使用可用的本机 provider；远程终端按 OpenTUI 的边界走终端剪贴板，OSC52 仍受终端政策控制。host 返回成功时才显示已写系统剪贴板；OSC52 只显示“已发送请求”，不能声称操作系统已接收。不支持时明确提示通过 y 查看原文。host 单次超时设为 1 秒；连续复制排队，防止后一次选区被较早的慢操作覆盖。

## 聊天与 Raw Events

正常聊天保留用户消息、Agent 回复、公开 thinking、Plan、工具更新、审批、错误以及完成 / 取消 / 工作区风险等有意义的状态。initialize、session/new、正常 acp.response、设置 / 用量元数据及文件 / 终端控制 RPC 默认只在 Debug 中查看。

分类只影响展示投影，不删除 SQLite 事件、不修改 raw 或 normalized payload、不改序号。错误优先于过滤：JSON-RPC raw.error、payload.error、错误级别及 runtime 错误 / 中断 / Worker 丢失事件继续显示。未知扩展默认保留可展开展示与 r 原始详情。

Ctrl+P → `Raw Events / Debug (complete ACP protocol)` 可查看已经补拉的全部原始事件及其 normalized payload、ID、seq、NativeSession / Turn 对应；Ctrl+PgUp/PgDn 翻事件页。新增 eventCount 信号使控制事件的补拉也能刷新 Debug，不能以“没有聊天行新增”丢掉协议更新。

## 归档、删除与同步

归档只写 `archivedAt`，正常列表默认隐藏；`View Archived Conversations` 显示归档，`Restore Archived Conversation` 恢复。归档不会取消后台任务，活动和审批仍计入全局汇总。

删除先通过命令面板选择，再在确认框输入 **DELETE**；Esc 可取消。HTTP DELETE 也必须提交 `{ "confirmed": true }`。服务端拒绝活动 Turn、待审批及 UNCERTAIN 会话 / Turn，初始化或配置操作也必须先结束。允许安全关闭空闲原生会话后再删除；没有 force stop 或自动审批。

删除期间 Runtime 持有会话操作标记，阻止竞态新 Prompt / Session / 设置；完成关闭后再次检查数据库约束。SQLite 外键级联删除 NativeSession、Turn、Event、Approval、Draft；最近会话引用置空，元数据变更记录保留。全过程不调用工作区删除、Git 分支删除或 Worktree 清理。

归档 / 恢复 / 删除沿用 SQLite 提交后广播的元数据 invalidation、watchSnapshot 重查和断线重连机制，其他 TUI 会重新读取真实状态。快照保留归档记录，客户端负责当前视图的可见性；并未改写后台执行状态。双客户端界面测试验证隐藏、恢复、确认取消和实际删除后的同步。

## 自动化验证

执行命令：

```bash
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run build
bun run test
```

最终完整测试日志：`/tmp/hhu-refinement-final2.log`。`bun run test` 会先重新构建 Bun CLI 和 Node Daemon；40 项 Node + 28 项 Bun/Solid 全部通过。`git diff --check` 通过。旧迁移测试用旧 schema 的真实 SQL 写入历史 fixture，再升级到 schema 5；没有用当前新增字段向旧表写入。

| 验收状态转换 / 范围 | 本机结果 |
| --- | --- |
| 输入有文本 → Ctrl+C 清空、不退出 | Solid renderer + 真实 Linux PTY 通过，SQLite 草稿为空 |
| 输入为空 → Ctrl+C 退出 | renderer + built CLI 真实 PTY 通过 |
| 连续两次 Ctrl+C：先清空、再退出 | renderer + 真实 PTY 通过 |
| 有选区 → Ctrl+C 复制原文、清除选区、不退出 | 实际 renderer selection / Clipboard Service 的终端适配器捕获通过，输入不变 |
| 拖选松开自动复制 | 实际 mockMouse 手势通过，包含跨行聊天、缩进代码、工具结果 |
| 双击选词 / 三击选行 | OpenTUI native word / line selection 与复制捕获通过 |
| Agent 运行中空输入 Ctrl+C 退出 | Mock ACP 真实进程 + built CLI PTY，以及真实 Codex / Grok PTY 通过；后台继续、同一 Worker、无额外 Prompt |
| OS SIGINT 不绕过清空逻辑 | 对实际 TUI PID 发送 SIGINT，第一次清空且进程存活；再测试原始 0x03 清空 / 退出，通过 |
| 协议分类 / 错误保留 / 原文保真 | 握手和正常响应隐藏、真实错误仍可见、未知内容可展开、raw / normalized 来源及 Markdown / 代码 / 结果逐字比较通过 |
| 归档 / 恢复 / 确认删除 | 事件、草稿保留；重启持久化；双客户端同步；删除取消；外键完整性；文件 / .git 保留，通过 |
| 活动 / 审批 / UNCERTAIN / 删除竞态 | 拒绝删除且不能经项目删除绕过；删除期间 Prompt 返回 409，通过 |
| 布局 / Resize / 长历史 | 120×30 时聊天至少占 20 行；默认单行输入、三行输入扩展；70 列隐藏侧栏、放宽恢复；滚动锁 / 跟随 / 工具状态 / 并发切换 / 草稿回归通过 |

性能样本：最终 20,000 个文本分块增量投影 **24ms**，20 个展示段；10,000 项历史每页最多挂载 60 项；包含长历史 renderer 与恢复的单项测试约 **131ms**。这只是本机样本，不是所有终端的帧率承诺。原始事件内存仍与已补拉历史量相关；Debug 每次只投影当前 100 项。

开发中出现过失败并已修正：旧测试只拦截 OSC52，但新服务可直接使用 native host provider，现自动化测试显式选择终端适配器路径；双 renderer 的即时截图遇到 OutputBusy，去掉等待前的无保护截图；PTY helper 丢弃启动输出且同步子进程阻塞 Node socket 处理，现保留输出并异步等待；旧真实标题断言未处理多行文本。失败日志没有改写为通过。

## 真实 Harness 验证

使用隔离 XDG 和临时项目，不修改用户项目或 Harness 配置，不自动选择原生审批：

```bash
node scripts/verify-phase4.mjs
```

首次完整通过证据：`/tmp/hhu-real-phase4-uDmM3o/evidence.json`（passed / renderPassed 均 true）。两个真实 Harness 并发执行读取 smoke.txt、pwd、sleep 12 和 node --test，再返回 Markdown；三次 Linux PTY 从 Home 启动，退出改用空输入 Ctrl+C，重开仍使用同一 Worker。Codex 139 个事件，Grok 225 个事件，各一次 Prompt，均 COMPLETED；原生 Markdown / 代码 / 工具结果复制逐字一致。

0.4.1 复验的真实执行证据：`/tmp/hhu-real-phase4-2EOyK0/evidence.json`。真实 PTY 链路通过；其初次 renderer 校验因 Codex 多行标题的屏幕空白比较失败，所以原文件仍保留 renderPassed=false，不能作为整套通过记录。修正断言后，**只读重放已有真实事件**，未再提交 Prompt，输出见 `refinement-render.jsonl`；合并结果见 **`/tmp/hhu-real-phase4-2EOyK0/refinement-evidence.json`**（passed=true，明确标记 renderReplayOnly）。

| Harness | Conversation / Turn | 真实结果 |
| --- | --- | --- |
| Codex | `4bb734ad-ee69-46c4-8ca0-8cdc349e0bc5` / `303ee395-7341-451f-bfb8-abe262c60d6c` | COMPLETED；执行采集 140 事件、一次 Prompt；原生多行命令标题保留；终端输出复制 129 字符，Markdown 286 字符及代码块逐字相等 |
| Grok | `eafa0cc1-f2bd-4c28-a113-e7590ec2988a` / `d8b1e24f-4832-4293-9935-da7ac79d25a0` | COMPLETED；执行采集 257 事件、一次 Prompt；原生 Read 标题保留；工具原文复制 320 字符，Markdown 320 字符及代码块逐字相等 |

关闭原生会话后持久化事件数增至 142 / 260；重放核对 raw session/update 与 normalized payload 完全对应，展示项 source ID / seq 仍一致。原始 SQLite 与工具 / source / chat frame 保存在同一私有证据目录。真实执行时全关 TUI 后仍有任务运行，结果由后台继续落盘。测试 Daemon 都通过合作式 API 停止，没有强杀、不重放有副作用的 Turn。真实测试未遇待审批，审批竞态由 Mock ACP 覆盖，不能声称真实原生审批均已人工通过。

## 限制、升级与人工验收

- 当前可访问 WSL2 / Linux PTY，但没有直接操纵 Windows Terminal、VS Code GUI 或核对 Windows 剪贴板。系统剪贴板接受情况及物理鼠标 / Ctrl+C / Shift+Enter **未验证**。
- 0.4.1 拒绝连接旧版本 Daemon，避免将缺少 archivedAt 的旧快照当成新契约。升级前安全停止旧 Daemon，再构建 / 启动；新 `hhu daemon stop` 可正常请求停止同协议旧实例，活动任务仍会阻止停止，不默认取消。此次没有自动停止用户默认 Daemon 或关闭用户正在使用的 TUI。
- 当前归档可见性仅是运行期视图选择；不持久化完整 UI 快照。UNCERTAIN 必须先检查历史及真实工作区，本阶段不提供强制删除或伪造完成状态。
- 其他客户端删除会话时，尚未保存的本地编辑可能收到 404 / 草稿保存错误；错误明确显示，必要时由用户使用已有 Ctrl+Q 放弃本地编辑。不会把这些文字发送到另一个会话，也不会借保存操作重建已删会话。
- 超长原生消息的展示分段、工具预览及原始事件内存限制沿用 Phase 4。完整原文仍通过 y / Debug 可达；格式化屏幕选区不能代替原始 Markdown 导出。

分别在 Windows Terminal 与 VS Code WSL 完成以下操作并记录版本、结果：

1. 安全重启到 0.4.1，从 `~` 输入 hhu，检查顶部状态 / 模型、聊天占比、Ctrl+B 侧栏、70 列窄屏与 Resize；打开多行草稿，确认输入随内容扩展且不挤掉全部聊天。
2. 非空输入按 Ctrl+C：文本清空、不退出；空输入再按一次：只关闭 TUI。分别验证导航模式仍有草稿时清空、中文 / 粘贴 / 多行、真实 SIGINT；重开草稿应为空。
3. 鼠标拖选聊天、代码块、工具输出并松开，粘贴到编辑器核对；双击词、三击行、跨行 / 缩进 / 中文也验证。有选区 Ctrl+C 应复制并清除选区，输入不变，不退出；随后按 Ctrl+C 重新按输入状态判断。检查 VS Code / Windows Terminal 是否拦截组合键。
4. y → Enter 复制原始 Markdown、单个代码块、工具结果；核对缩进与空行。分别测试 native provider / OSC52 政策；终端拒收时记录限制，不写成通过。
5. Enter 只发送一次；物理 Shift+Enter 只换行。若终端发送普通 Enter，记录不兼容并验证 Ctrl+J / 配置备用键。不能用 PTY 注入 Kitty 字节代替本项。
6. 真实 Codex 与另一个 Harness 并发，核对正常聊天不出现 initialize / 正常 acp.response；Ctrl+P → Raw Events 可看到完整协议，真实错误仍显示。运行时 Ctrl+C 退出并重开，Daemon / Worker / Turn 不变、无额外 Prompt；取消单独使用 c。
7. 两台 TUI 打开同会话：归档在正常列表隐藏，查看归档可检索，恢复两端更新。删除先 Esc 取消、再输入 DELETE 确认；核对另一端移除、用户源码 / Git 分支 / 工作目录不动。运行、待审批、UNCERTAIN 会话必须拒绝删除，归档运行会话不能停任务。
8. 长历史 PgUp 暂停跟随、End 跟随；切换两个并发 Conversation、Chat / Changes 和 Resize 后，滚动与手动工具展开状态保留。未确认提交被清空后重开，仅 Restore Unconfirmed Message 恢复原文，不能自动新建 Prompt。

交付范围止于 Phase 4 UI Refinement，目标终端人工验收完成前不声明全部终端体验通过。
