# HarnessHub — Codex 六阶段实施与验收计划

> 产品名称 HarnessHub；CLI `hhu`。按照 `01_ARCHITECTURE.md` 作为架构真源，阶段制实现完整 MVP，不将尚未实现功能伪装为完成。每阶段产生代码、自动化测试、真实运行演示、验收记录。必须以 `AGENTS.md` 为执行约束。

## 0. 全局开发约定

- 使用 TypeScript、Bun Workspaces，TUI Bun + OpenTUI/Solid，Daemon Node + Hono，数据库 better-sqlite3 + Drizzle，ACP SDK。
- 验证并锁定能够协同工作的 Node LTS、Bun、OpenTUI/Solid、ACP SDK、better-sqlite3 版本；保留一份兼容性矩阵。
- 所有特性先实现端到端最小垂直切片，再补边界与故障测试；不要堆砌暂时无人使用的框架/泛型。
- 使用 Mock ACP Server 进行单元/集成测试，至少一个真实 ACP Harness 作为每阶段关键链路验证。真实验证未运行时应写明“未验证”，不能伪报通过。
- 关键行为不得使用模拟数据替代真实 Agent/Workspace/SQLite。不得自行接管 Harness API Key、Base URL、模型配置或审批策略。
- 阶段结束生成 `docs/acceptance/phase-N.md`：实现清单、测试命令/结果、手动验收步骤、发现问题、未完成项、风险、变更文件。必须经过用户确认/验收才进入下一阶段；阶段内无需每次细节询问。
- 遇到设计冲突：优先遵守不变量（真实工作区、不会重复执行、权限不自动批准、原始 ACP 保真、Daemon 生存期正确）；在验收记录中列出偏差。

## 阶段 1：工程骨架、CLI 与持久化基础

**目标**：从任意目录运行 `hhu` 打开可连接的 TUI，Daemon 自动启动且 TUI 退出后保活。

**实施任务**：
1. Monorepo、严格 TS、分包边界、锁文件、build/test/typecheck/lint 脚本。
2. Hono Daemon，回环监听、单实例实例锁、健康检查、本机客户端授权、生命周期管理；WS 订阅与最简事件。
3. `hhu` Bun CLI 与子命令 `daemon start|stop|status|logs`、`doctor`、`--version`；用户级 `install:local` 脚本，命令名绝不能写成 `harnesshub`。
4. SQLite schema、WAL、Drizzle migrations、数据目录权限、基本 Project/Conversation CRUD、数据备份和 schema 版本检查。
5. 最小 OpenTUI/Solid 真实终端视图（项目列表/空会话）；无参数从 `~` 启动是全局模式，Project root 独立于 shell cwd。

**自动化测试**：重复 `hhu` 只有一份 Daemon；CLI/WS 断线重连；SQLite 迁移/权限；无项目时启动；Project 路径不存在时拒绝静默创建。

**人工验收**：两个 WSL 终端依次执行 `hhu`，共享 Daemon；退出一个 TUI，另一个仍可连接；在 `~` 创建 Project 指向其他路径；`hhu doctor` 报告准确。

**完成判定**：可靠的 `hhu` 入口、TUI↔Daemon↔SQLite 最小闭环；没有实际 Agent 功能时清晰标注尚未实现。

## 阶段 2：Generic ACP Runtime 和真实 Agent

**目标**：至少一个真实内置 Harness 的创建会话、流式事件、工具调用、审批、取消贯通，随后覆盖所有内置及自定义 ACP 入口。

**实施任务**：
1. Generic stdio ACP Client、Worker spawn/exit/cleanup、initialize/capability negotiation、`session/new` 绝对 cwd、prompt/update/cancel/permission 回调。
2. 内置 Profile：Codex/Claude/Grok/OpenCode；自定义 command/args/env overrides；可用性诊断及版本/能力报告。
3. NativeSession/Turn/Event/Approval 表与状态机；原始 ACP+normalized 双轨事件存储，按序提交和 WS 广播；未知事件降级展示。
4. 审批 API 原子提交，审批选项取自 Agent；强制取消需确认；进程失效/不确定状态不可继续写任务。
5. 模型、推理及其他会话选项**仅 ACP 能力提供时**显示和操作；不解析原生配置。
6. 对文件、终端及扩展能力实现实际必要 Client Handler；仅声明已实现能力。

**自动化测试**：模拟并发事件/分块工具输出/权限阻塞/重复审批/取消后末尾事件/丢失连接/进程崩溃/未识别 event type；确保无授权自动批准和无重复 Prompt。

**人工验收**：至少一个真实 Agent 执行无害读取及测试命令；审批在 UI 里实际确认；可正常取消；证实 `cwd=Project root`。分别对四个内置 Agent 做启动/握手/模型可见性/工具/审批能力检查，缺失项记录能力差异而不是判全部实现。

## 阶段 3：Project、Conversation、并行与恢复

**目标**：全局多项目、多会话、后台并行、WebSocket 断线补拉和基本草稿持久化。

**实施任务**：
1. Project root 规范化、重复路径去重、根目录失效时重新绑定；Conversation 继承 Project workspace。
2. 每个 Conversation 独立原生会话、独立历史、单一 active Turn；不同 Conversation 可并行运行，允许共享 root 并给冲突提示。
3. 后台活动/审批/错误/Handoff 状态聚合；WS 全局通知与每会话 `seq` 补拉去重。
4. 退出 TUI 保活、重新连接到存活 Daemon/Worker；Daemon 重启恢复 SQLite 历史并准确标记中断/UNCERTAIN，不伪恢复原生进程。
5. 每会话草稿持久化、最近会话和基础偏好。

**自动化测试**：并发两 Conversation、事件交错隔离、重复 WS 订阅、跨终端 TUI 重连、进程异常重启、草稿恢复、同一会话不能同时提交两个开发 Turn。

**人工验收**：从 `~` 启动，两个不同项目的 Agent 都在各自路径运行；关闭 TUI 后其中一个仍执行；再开 TUI 继续看到真实后续事件。

## 阶段 4：完整 OpenTUI 交互与 Git Changes

**目标**：极简内容优先的可日用 TUI，保留原生 ACP 输出。

**实施任务**：
1. Project→Conversation 树形可隐藏侧边栏、窄屏收起、全局命令面板、快速会话切换和状态徽标。
2. Markdown/代码块/流式片段/原生工具名/计划/公开 thinking/错误/未知事件原文详情；保证原文复制。
3. 工具成功默认折叠，运行中/失败/审批中默认展开；用户手动展开保持优先级。
4. 输入编辑器多行/长粘贴/草稿保存；**Enter 发送、Shift+Enter 换行**；实测 Windows Terminal 与 VS Code WSL，无法辨识时提供备用方式。
5. Tool 内联 Diff + 独立 Changes：真实 `git status`/diff；Git 非仓库和共享工作目录场景正确提示；不得虚构 Agent 变更归属。
6. 终端 resize、滚动锁定、ESC 弹窗、审批快捷操作、键盘可达性和关闭 TUI 不影响执行。

**自动化测试**：组件交互和 reducer 单元测试、终端尺寸/键位事件测试、未知 ACP 事件渲染、Git Changes 解析与用户路径转义。

**人工验收**：两种终端中输入 Shift+Enter 并确认只插换行；Enter 实际提交且不会重复；边栏折叠、滚动与 Markdown 原文复制；真实 Changes 与 `git diff` 对照。

## 阶段 5：Handoff、Git Worktree 与复杂状态

**目标**：在一个 Conversation 中跨 Harness 自然接力，不重复执行用户任务。

**实施任务**：
1. `PENDING_SWITCH` 时零模型调用；源会话原生 Context Handoff，固定报告结构；来源事件边界与内部 Turn 标记持久化。
2. 首条目标 Prompt 携交接背景+真实用户消息，新会话同 workspace；成功接管后安全关闭旧 Worker；切回原 Harness 新建原生 Session。
3. Handoff 失败时降级：已有报告+必要原始历史、显式“不完整”提示、用户确认才继续；取消/重试和 `UNCERTAIN` 处理。
4. 交接报告在聊天历史以独立可展开记录呈现，保留完整原文、来源、覆盖边界。
5. 为 Conversation 可选创建独立 Git Worktree，跟踪归属与分支；删除须安全检查；共享工作区并发只警示不强锁。

**自动化测试**：A→B→A、只切换未发消息不产生调用、切回源保留 Session、生成失败降级、提示未确认不执行、提交超时不重复、Worktree 脏文件删除拒绝、共享路径并发提示。

**人工验收**：至少两个真实 Harness 完成一轮交接并由目标继续工作；换回源验证不是错误复用历史原生 Session；查看交接报告详情；模拟源不可用并确认降级行为。

## 阶段 6：数据安全、故障恢复、安装与最终验收

**目标**：确保长期 WSL 日常可用、数据安全和故障边界清晰。

**实施任务**：
1. SQLite/配置/日志权限、日志大小轮转、敏感字段定向脱敏，日志中不默认保存完整 Prompt/工具输出或 Key；数据导出与会话删除。
2. `hhu doctor` 对 Node/Bun/OpenTUI、SQLite native binding、PATH ACP Agents、端口/实例、Git 能力准确诊断；实际握手测试允许显式执行。
3. 单实例冲突处理、守护进程停机保护、SIGTERM/SIGKILL 升级、UNCERTAIN 状态、旧审批失效，禁止自动重放。
4. 安装脚本 `install:local` 和升级流程：用户 PATH、构建产物、Node Daemon 版本匹配、数据库备份与迁移前检查活跃任务。
5. 补充端到端/回归测试、四 Agent 兼容性矩阵、操作文档、故障恢复指南。

**最终人工验收（硬性）**：
- `cd ~ && hhu` 正常进入全局项目列表；已注册项目路径无需重输；可安装重启使用。
- 两个 Agent 不同 Project 同时工作，TUI 退出不影响活动 Agent，重新连接能补齐事件。
- 每个内置 Harness 都能进行真实握手，兼容性差异透明；可配置自定义 ACP Agent。
- 审批不会自动通过；重复点击只决策一次；取消末尾事件入库；强杀和 Daemon 失联标记正确。
- Handoff 正常路径和降级路径都能实际操作；没有重复写文件的请求重放。
- Enter/Shift+Enter 在目标两种终端中可用或有清晰 fallback；工具折叠/原文查看、真实 Git Changes 可用。
- 原始可观察 ACP 输出未被总结改写；日志和文件权限符合方案 A；导出与删除不触碰用户源码。

## Codex 每阶段执行 Prompt 模板

```text
你正在开发 HarnessHub。请先阅读仓库 AGENTS.md、docs/01_ARCHITECTURE.md 和 docs/02_CODEX_IMPLEMENTATION.md。
当前只实现阶段 <N>，但遵守所有已确定的全局架构和不变量。

请先：
1. 检查仓库现状和已完成阶段的验收记录，识别缺口与依赖。
2. 写一份简短的阶段实现计划（模块、契约、测试策略）。
3. 直接实现、补足单元/集成测试，运行 typecheck/build/test。
4. 需要真实 Agent/终端验证但环境不具备时，明确标记未验证，给出精确手动步骤，不允许编造结果。
5. 结束时更新 docs/acceptance/phase-<N>.md：代码变更、执行过的命令、测试结果、已知问题和下一阶段入口。

不得自动进入下一阶段；不得自行改变产品命名 HarnessHub 或 CLI 命令 hhu；不得管理各 Harness 的 API Key、Base URL 或绕过权限审批；不得将 Mock 测试当作真实 ACP 连接验证。
```

## 交付流程和最终 Done 定义

每阶段完成代码、测试和 `phase-N.md`；用户认可后进入下一阶段。六阶段全部通过后，完整 MVP 的验收包括：真实 Agent 接入、正确 workspace、后台存活、无重复任务、原生审批、交接可追溯、TUI 行为、数据保护、安装运行。发现架构级问题可以记录并调整实现方案，但不得悄悄重启第二轮无限决策。
