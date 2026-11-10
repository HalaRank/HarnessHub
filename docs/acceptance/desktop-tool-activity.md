# Desktop 工具活动区优化

日期为 2026-11-10，时区 Asia/Shanghai。范围为用户三张截图中的聊天工具活动区，归入既有 Desktop 阶段的界面优化。

## 截图判断与实现

参考 Codex 截图的活动摘要和紧凑列表，将同一原生 Turn、同一 NativeSession 内的连续工具调用合为一组。用户消息、Agent 原文、公开思考、Plan 和 Handoff 都保留各自的边界。

- 已完成的调用默认显示一行数量摘要，展开后显示原生标题、类型图标和状态。
- 每条标题以单行省略显示，悬停可读完整标题。标题字符串、原生参数、输出、Diff、位置来源及完整原文复制保留。
- 运行中、失败、等待执行、等待审批及审批过期的活动组默认展开。原有单工具详情的默认展开和手动优先规则继续生效。
- 手动展开活动组后，状态更新和新增调用保留该选择。手动收起后，摘要仍显示失败、等待审批和审批过期计数。
- 展开列表移除各工具的独立外框和大段间距，每条标题行高为 32px。窄窗口优先给标题留空间，成功状态由组摘要表达。

分组沿用现有每页最多 100 条消息的挂载范围，摘要数量表示当前窗口内的分组。跨页显示的长工具序列可能分成多组。

## 修改文件

| 文件 | 本次修改 |
| --- | --- |
| `apps/desktop/src/renderer/history.ts` | 纯展示分组，按相邻工具、Turn 和 NativeSession 保留边界 |
| `apps/desktop/src/renderer/Message.tsx` | 活动摘要、分组展开、紧凑原生标题、类型图标与状态 |
| `apps/desktop/src/renderer/App.tsx` | 通过 TranscriptView 呈现现有历史窗口 |
| `apps/desktop/src/renderer/style.css` | 工具活动区的行高、间距、截断、状态色与窄屏布局 |
| `apps/desktop/tests/tool-activity.test.tsx` | 六项分组、默认展开、流式状态、手动选择和未知原生字段回归 |
| `apps/desktop/tests/windows-workspace.ts` | 查看原生 Diff 前通过真实按钮展开工具组 |

开始时已有 Composer、style 和 chat 测试改动，实施期间工作区另有新建会话、侧栏、WSL 环境及发布相关改动。本记录仅归属上述工具活动区修改，测试覆盖的是运行时的共享工作区。

## 自动化与实际验证

| 检查 | 结果 |
| --- | --- |
| `bun run typecheck` | 通过 |
| `bun run lint` | 通过 |
| `bun run desktop:build` | 通过 |
| `bun test --cwd apps/desktop tests` | 最终 60 项通过，0 失败 |
| `bun run desktop:test` | 构建、56 项当时的 Desktop 单元测试及 16 项真实 Daemon 集成测试通过。其后补跑当前单元集 |
| `bun run test` | 最终退出 0，119 项 Node 集成与 121 项 TUI/UI 测试通过 |
| Windows Electron 45.2.3 | 通过，使用实际 App、Transcript、Composer 和 CSS，以受控事件夹具提供数据 |
| 本次相关文件的 `git diff --check` | 通过 |
| 提交前隔离验证 | 在 `7422a19` 上仅应用本次工具区修改，后端与 Desktop 构建、Desktop 类型检查和 52 项 Desktop 单元测试通过 |

最初在沙箱内运行集成测试时发生子进程 EPERM，Windows 互操作也被沙箱阻止。随后使用已批准的隔离测试路径运行，Desktop 集成通过。首次全量回归达到 240 秒时限，85 项通过、4 项因进程终止而取消，随后提高时限重新执行。失败和中断轮次均保留为过程记录。

Windows 测试使用 `/tmp/hhu-tool-activity-preview` 下的专属用户数据和 App 夹具，实际显示 Electron 窗口并等待合成帧后截图。工具摘要点击、单工具展开、完整原文复制、运行与完成更新、手动收起后的失败计数，以及 600px 窗口均通过。5 条长标题实际行高均为 32px，宽窄窗口均无聊天区横向溢出。就绪会话中的这些交互没有产生提交、审批或 Session 准备请求。

证据在 [desktop-tool-activity](evidence/desktop-tool-activity)，包括 Windows 结果、折叠与展开截图、失败与窄屏截图、类型检查、lint、构建和测试日志。Windows 夹具及运行器保留于上述临时目录。

## 用户验收与限制

1. 使用本次源码构建的 Desktop 打开已有工具历史，确认成功工具序列默认显示摘要。点击摘要后核对标题、排列和原生状态。
2. 展开一项工具，检查完整参数、输出、Diff 和复制内容。保持展开并观察后续状态更新。
3. 在临时项目中运行真实 Harness，检查运行中、失败及自然触发的原生审批。手动收起后确认摘要仍有待审批或失败标识。
4. 调整窗口宽度并隐藏侧栏，确认长命令省略、失败状态和详情区可读。

本轮真实模型交互、自然产生的原生审批、完整 Windows Bridge smoke、物理鼠标及各显示器 DPI 体验均未重新验证。Windows 界面证据来自受控事件夹具，后端集成使用 Mock ACP。当前交付为源码和 Desktop 构建产物，安装版需要更新构建包后验收。
