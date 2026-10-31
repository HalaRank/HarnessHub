# HarnessHub — Codex 仓库执行规则

你是负责实施 HarnessHub 的工程 Agent。产品名及仓库名始终为 `HarnessHub`；**最终全局 CLI 命令是 `hhu`**。MVP 仅 Linux x64 / WSL2 TUI，拒绝附加 Web UI/云端服务。

## 阅读顺序

1. `docs/01_ARCHITECTURE.md`：已完成的 28 项架构决策及核心不变量。
2. `docs/02_CODEX_IMPLEMENTATION.md`：六阶段实施、测试、验收、阶段结束记录。
3. `docs/acceptance/phase-*.md`：当前代码真实进度；不存在的验收不得假定通过。

## 必须遵守

- TUI：Bun + OpenTUI + SolidJS；Daemon：Node.js + Hono；Monorepo Bun Workspaces；SQLite：better-sqlite3 + Drizzle；统一 ACP Client。
- 永远按照 Conversation 绑定的 Project root / Worktree 设定 ACP `session/new.cwd`；启动 `hhu` 的 Shell `pwd` 不是 Agent 默认工作区。
- 不读取/修改 Codex、Claude、Grok、OpenCode 原生模型/API Key/Base URL 配置；通过 ACP 动态能力协商提供模型/推理/权限选项。
- 不实现 HarnessHub 的自动审批或静默批准；审批依照真实 Agent 的选项，由用户做决定。
- 原生 ACP 可观察输出保真：原始事件和结构化事件都保留；不统一改写 Agent 文案、工具名称、Markdown/公开思考内容。
- TUI 工具成功默认折叠，运行中/失败/等待审批默认展开，手动展开优先；Enter 发送，Shift+Enter 换行。
- TUI 退出不结束 Daemon 和正在运行的 ACP Worker；Daemon 崩溃只能恢复 SQLite 历史，并根据协议真实能力安全恢复原生状态，绝不能伪装为继续运行。
- 在同一个应用 Conversation 中跨 Harness 切换，**仅目标第一次提交消息时**生成源 Harness 报告、再创建目标原生会话；正常交接自动继续，可展开历史报告；失败时已有摘要+原始历史降级，用户确认才发送。已提交但结果不确定不能自动重发。
- 支持默认共享根目录与可选 Git Worktree；共享工作区并发允许但必须提示风险；Changes 显示真实 Git 变更，不臆测某 Agent 的修改归属。
- 关键状态、事件、草稿落 SQLite；不记录完整 UI 快照；文件权限、日志轮转和敏感字段定向脱敏，禁止默认日志打印完整 Prompt、Token 或全部工具输出。
- 不引入 Redis、RAG/向量数据库、独立 Runner、完整插件市场、额外模型代理、自动更新、云平台或复杂配置管理。

## 开发工作流

1. **每次只实施当前阶段**，先检查代码现状及架构冲突，再实施垂直闭环。
2. 先通过编译、lint、typecheck、单元和集成测试；为 ACP 故障、权限、取消、WS 补拉和 Handoff 去重编写 Mock ACP 测试。
3. 能在真实环境验证时必须真实验证；否则在验收记录中清楚写出“未验证”、受阻条件及手动执行步骤，不能声称已通过。
4. 阶段结束时写 `docs/acceptance/phase-N.md`，列出文件、命令、测试结果、已知缺陷/限制、用户待验收事项；**不要自动实施下一阶段**。
5. 依赖选择以当前文档和实际 lockfile 为准；协议/平台发生变化时优先查官方资料并附证据，不凭猜测编造 ACP 接口或支持矩阵。
6. 安全关闭进程和处理数据迁移，禁止无用户确认的 force deletion、覆盖用户项目文件、绕过审批或重放有副作用的 Turn。

## 最重要的成功标准

用户在 `~` 输入 `hhu`，进入统一的 Project → Conversation 树形 TUI；真正的多个 ACP Agent 能在正确 Workspace 并行工作、保留原生输出、按原生权限审批、支持安全取消与跨 Harness Handoff；关闭 TUI 后工作不中断，并且所有关键历史可追溯。
