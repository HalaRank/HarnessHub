# Phase 6 UI 层级重构

2026-11-05，现有 MVP 界面改进。

## 实施范围

- `apps/tui/src/ui.tsx` 提供色板、输入和列表样式、统一弹窗及快捷键提示。主文字 `#edf2f7`，说明 `#b8c4d0`，辅助文字 `#94a4b5`，焦点强调 `#80cbc4`。普通说明与输入占位文字对比度达到 4.5。
- `slash-commands.tsx` 将加粗命令名、普通参数提示和缩进描述分层。背景和箭头共同表示选中，标题与操作提示分别固定在顶部和底部，长描述支持换行、滚动。
- `index.tsx` 分开品牌、连接、活动统计、会话标题和 Workspace 路径。命令面板动作名与说明分开，路径和 Conversation 状态作为辅助信息，搜索包含说明。
- `agent-pane.tsx` 区分 Harness、运行状态、Handoff、模型和连接信息，根据编辑/导航上下文显示操作提示。输入高度随终端高度收缩，35×12 下仍显示命令及说明。审批突出用户决策与原生选项，选项区域支持滚动。
- `project-tree.tsx` 统一选中、悬停和项目标题，Conversation 名优先显示，状态随后显示。侧栏操作使用统一弹窗。
- `project-directory.tsx`、`project-path-input.tsx` 调整目录标题、文件层级和项目路径输入。
- `command-palette.tsx`、`changes-pane.tsx`、`source-viewer.tsx`、`delete-confirmation.tsx` 统一标题、列表、说明与操作提示。ACP 设置、Worktree 管理/清理、Handoff 复用弹窗。
- 同期新增的消息队列与历史搜索复用输入/列表色板。小窗口及搜索中的命令面板收起全局帮助文字，保留结果列表空间。

## 自动化与证据

- 新增 `tests/e2e/ui-hierarchy.test.tsx`，纳入 `scripts/test.ts`。真实 OpenTUI renderer 检查 100/35 列、选中与未选中时的字重/颜色、路径搜索、空结果 Enter 和对比度。共享工作区 3 项、53 断言通过，日志 `/tmp/hhu-ui-merged-hierarchy-final2.log`。
- `tests/e2e/slash-commands.test.tsx` 增加 35×12 候选描述可见及弹窗顶边在视口内的断言。与层级测试合计 17 项、141 断言通过，日志 `/tmp/hhu-ui-isolated-targeted-final.log`。
- `mouse-sidebar.test.tsx` 更新标题/路径及色板断言，会话 helper 适配按上下文变化的底部提示。
- `phase4.test.tsx` 更新模型信息行断言，`terminal.py` 更新 Workspace 和项目输入标题的 PTY 检查。
- 真实 App renderer 加隔离 Mock ACP 检查聊天顶部/底部、Slash 菜单、命令面板和窄窗口。字符帧 `/tmp/hhu-ui-{chat,slash,palette,narrow}.txt`，对应 span 信息为同名 JSON，日志 `/tmp/hhu-ui-preview.log`。
- 最终构建通过真实 Linux PTY 的 `slash-terminal.py`。从 `/home/clj` 启动，命令补全为 0 Turn，显式发送为 1 Turn，Unicode/换行、菜单/侧栏保留草稿、Ctrl+C 清空/退出和 Daemon/原生会话保活通过。证据 `/tmp/hhu-slash-pty-z7h0t_5j`，日志 `/tmp/hhu-ui-isolated-slash-pty.log`，使用隔离 Mock ACP。

### 并行修改的验证边界

共享工作区同时在实施本地命令、消息排队、steer、历史搜索和键位调整，涉及 `agent-pane.tsx`、`index.tsx`、`native-events.tsx`、`command-palette.tsx` 及后端/共享包。这些修改被保留，新增的队列与搜索视图补齐统一样式。同期默认键位改变影响依赖旧键位的现有测试。

本任务的独立回归使用 `/tmp/hhu-ui-check-XXHZZQ`，由 HEAD 基线及本次渲染/样式/测试修改组成。AgentPane 的行为逻辑取基线，渲染取本任务实现，依赖安装、构建和测试数据独立。合并后的键位与队列行为需按并行任务最终版本另验。

最终验证分开执行，集成 **84/84**、TUI **83/83**，共 **167 项通过**。集成日志 `/tmp/hhu-ui-isolated-full-final2.log`，最终全部 TUI 日志 `/tmp/hhu-ui-isolated-all-ui-complete.log`，TUI 共 1304 个断言。隔离副本的 typecheck、lint、build 通过，日志 `/tmp/hhu-ui-isolated-{typecheck,lint,build}-complete.log`。

共享工作区最近一次 typecheck 和 build 通过，日志 `/tmp/hhu-ui-merged-last-{typecheck,build}.log`。最近一次全仓 lint 报同期修改的格式、导入整理及未用导入问题，日志 `/tmp/hhu-ui-merged-last-lint.log`。

随后实际执行共享工作区全部 TUI 测试，结果为 **70 通过、13 失败、1 个测试间错误**，日志 `/tmp/hhu-ui-merged-all-ui.log`。失败覆盖菜单/侧栏操作后的光标、Harness 选择、Esc/滚动、原生消息附加控件、生命周期操作及鼠标导航。执行期间仍有另一任务修改同批文件与测试，合并后的整体回归尚未通过。菜单光标用例单独复跑也失败，不能用隔离基线的通过结果覆盖这些问题。

首次隔离完整回归 Node 83/84，唯一失败为 PTY 等待旧的 `Workspace:` 标题，更新后 84/84。第二轮 UI 暴露旧标题断言、后台审批状态被长会话名截掉、初始化中的输入被测试过早访问，以及多一行元数据使 30 行终端的历史区变小。修正标题检查、将后台运行状态放到独立辅助行、等待实际草稿就绪、将模型信息整合进 Harness 信息行后，最终 83/83。

早期鼠标失败还包含旧颜色断言及同期默认快捷键变化，日志 `/tmp/hhu-ui-refactor-targeted*.log` 保留。新增 palette 用例最初把 Ctrl+A 当作全选，改用实际行首与删除到行末后通过。

## 待人工验收

Windows Terminal 和 VS Code WSL 的字体、物理键盘、系统剪贴板与终端色彩呈现均未验证。请在两个终端分别记录版本、尺寸和结果。

1. 在当前构建打开项目和会话，检查顶部标题、路径和状态，开关侧栏并调整宽度。
2. 输入 `/`，检查命令名、参数、描述、选中态，使用方向键、滚轮和鼠标补全，覆盖长描述与中文。
3. 在约 35×12 的小窗口检查菜单和输入框，再输入长草稿并连续缩放。
4. 打开命令面板、设置、审批、Changes、原文、项目注册、重命名、归档/删除、Worktree 与 Handoff，检查层级和操作提示。
5. 使用同期键位任务最终确认的操作入口，核对编辑、发送、审批、取消和后台运行。

实际检查 `/home/clj/.local/bin/hhu` 后，入口指向已有的 `dist/releases/24bbe051-f142-4c46-b36d-1ed50f6da5ee/cli/hhu.js`。本轮仓库构建位于 `dist/cli/hhu.js`，全局入口目前仍使用已有发布目录。
