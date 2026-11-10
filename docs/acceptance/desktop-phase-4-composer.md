# Desktop 输入栏精简与自动连接

日期为 2026-11-10，Asia/Shanghai。本次属于现有 Desktop 阶段的交互修订。用户明确选择单独推送输入栏、自动连接与默认 Harness 的相关改动。本记录对应从提交 `5cfc9df` 提取并在隔离副本中验证的范围。

## 文件与交互

| 文件 | 内容 |
| --- | --- |
| `apps/desktop/src/renderer/Composer.tsx` | Harness、单个模型入口、单个审批模式入口，中文界面标签及原生候选名。选择 Harness 后自动准备 ACP 会话，失败提供手动重试 |
| `apps/desktop/src/renderer/style.css` | 精简下拉边框，统一间距及字号，补充聚焦边框、占位文案对比度及发送按钮层级 |
| `packages/storage/src/index.ts` | 从 SQLite 最近打开的会话继承 selectedHarnessId，缺失时取最近更新的已选 Harness。共享项目、Worktree 和独立会话共用该创建路径 |
| `apps/desktop/tests/chat.test.tsx` | 重复选项去重、旧协议字段回退及跨 Harness 选项隔离 |
| `tests/integration/phase1.test.mjs` | 跨项目、独立会话及重新打开数据库后的 Harness 继承回归 |
| `docs/acceptance/evidence/desktop-composer/*` | 隔离 Windows Electron 渲染截图与交互请求记录 |

已有创建入口生成新 Conversation 后，默认 Harness 来自已持久化的最近会话记录，Composer 随后自动连接。默认值复用已有数据库结构。

自动连接适用于已经创建、尚无原生上下文的 Conversation。Renderer 等待会话数据及草稿加载，再调用已有 `session.prepare`。同一会话和 Harness 自动尝试一次。失败保留错误和“重试连接”按钮，重连 Daemon 后可以重新尝试。

已有上下文跨 Harness 切换时显示待交接状态，目标在首条消息的 Handoff 流程中连接。中断上下文恢复沿用显式入口。等待审批、未确认投递、UNCERTAIN 及正在执行操作时阻止自动连接。

## 模型候选来源

Daemon 在 `packages/core/src/runtime.ts` 调用真实 Worker 的 `session/new`，保存返回的会话能力。Renderer 从 NativeSession 的 `capabilities.session.configOptions` 选择 `category=model` 或 `id=model` 的候选。后续 `config_option_update` 及设置响应会刷新保存的能力。

锁定的 `@agentclientprotocol/codex-acp@2.5.0` 通过 Codex App Server 的 `model/list` 分页获取模型，构造 ACP Model 选项。适配器将 `gpt-6-astra` 等名称格式化为 `6 Astra`，也会将当前模型补进候选。候选代表 Agent 发布的会话选择，实际调用能力需结合原生认证和网关结果验证。

既有真实返回见 `evidence/desktop-phase-4/real-handoff-evidence.json`，其中同时包含 `models.currentModelId`、`configOptions.model`、`configOptions.mode` 和 `modes`，对应此前的重复展示。输入栏优先使用可操作的 configOptions，旧字段作为兼容回退。

当前先保留一个模型入口，等待用户决定是否继续保留。协作模式及其他配置项从输入栏移除。

## 限定提交验证

隔离源码位于 `/tmp/hhu-composer-push-AMs96o`，包含基线提交及上表所列代码。验证命令使用已安装的锁定依赖和 `/tmp` 隔离测试数据。

| 检查 | 结果 |
| --- | --- |
| `bun run typecheck` | 根工程、Daemon、Desktop 通过 |
| `bun run lint` | 153 个文件检查通过 |
| `bun run desktop:test` | CLI／Daemon／Desktop 构建通过，46 项 Desktop 单元、15 项真实 Daemon／SQLite／Mock ACP 集成通过 |
| `node --test --test-name-pattern='new conversations inherit' tests/integration/phase1.test.mjs` | 1 项通过 |
| Windows Electron 45.2.3 | 宽屏、窄屏均为三个选择控件，标签正确，控件边界无横向溢出 |
| Windows 设置请求 | 模型、审批模式各发出一个对应 configId 的请求 |
| Windows 自动连接 | 手动选择、继承 Harness、失败后显式重试、UNCERTAIN 拦截、跨 Harness 等待交接五项通过 |

Windows 检查使用真实 Electron 进程，载入隔离副本中的 Composer 和 CSS。数据来自已存 Codex ACP 返回，API 使用隔离替身。截图及请求记录见 `evidence/desktop-composer/wide.png`、`narrow.png`、`windows-result.json`。限定提交的测试日志为 `/tmp/hhu-composer-push-validation.log`。

此前在包含其他并行改动的共享工作区中，全仓回归得到 119 项 Node 集成及 121 项 TUI/UI 通过，Desktop 单元 59 项通过，Desktop 集成重跑 16 项通过。该轮 Desktop 集成曾出现一次 `ECONNRESET`，完整重跑通过。限定提交的隔离验证结果单列于上表。

## 待人工验收

本轮新建真实 Harness 会话、实际模型切换和权限模式变更标记为“未验证”。Windows 自动连接使用 Renderer 替身，后端由真实 Daemon／Mock ACP 集成覆盖握手、cwd、设置、取消与审批。

在 Windows App 打开已有项目中的空会话，选择 Harness，检查自动连接和模型／审批模式单项显示。创建另一会话，检查默认 Harness。输入中文，检查 Enter／Shift+Enter。已有上下文时切换 Harness，发送首条消息后检查交接。连接失败时检查显式重试。安装版更新及物理中文输入法效果由用户验收。
