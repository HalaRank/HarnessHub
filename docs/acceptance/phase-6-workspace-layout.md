# Phase 6：TUI 工作区结构与样式优化

2026-11-09。用户提供项目目录截图并要求全面优化 hhu UI。本次属于现有 TUI 阶段内优化；未进入新的产品阶段。

## 交付

- 全局栏左侧品牌与连接，右侧全局活动及 Commands；中等宽度简化审批和问题计数，窄屏保留品牌、连接及命令入口。
- 侧栏以单侧分隔线代替全包围边框，增加项目数、Add 入口及 Standalone 分组。项目行由三行收紧为两行；保留会话两行、原始名称、状态、独立折叠箭头及操作菜单。选中项增加左侧强调线。
- 项目页由单一目录列表改为工作区概览：项目标题和路径、真实会话/活动数、新建共享会话、新建 Git Worktree、按更新时间排列的会话列表及目录。归档模式仅列出归档会话。
- 内容区域达到 92 列时会话与目录并排；更小宽度上下排列。35×12 下仍显示两个创建入口、会话和目录内容。新建操作使用当前项目绑定目录，不使用启动 shell 的 cwd，也不会提前创建 ACP 会话。
- 目录标题融入分隔线，避免路径重复；目录、普通文件、隐藏文件使用不同层级，文件夹悬停可见。仍为真实只读目录，不跟随符号链接、不隐藏系统文件。
- 调整深灰底色和面板层次，统一圆角弹窗与输入框。聊天保持常规两行顶部、原有 Agent 输出配色、内容和工具折叠语义。
- 快捷提示按实际可用宽度选取完整条目，强调按键。原生命令候选的名称/参数单行截断，描述独立显示，修正 35×12 下描述被挤出视口的问题；原始命令数据不改写。
- 新增按钮和最近会话遵守弹窗所有权；Add Project 可从聊天打开并保留草稿。已有键盘和命令面板入口保留。

## 文件

- `apps/tui/src/action-button.tsx`、`workspace-overview.tsx`：操作控件与工作区概览。
- `apps/tui/src/index.tsx`、`project-tree.tsx`、`project-directory.tsx`、`ui.tsx`、`agent-pane.tsx`、`slash-commands.tsx`：全局布局、项目树、目录、共享样式、输入框与命令菜单。
- `tests/e2e/ui-hierarchy.test.tsx`、`new-conversation.test.tsx`：真实 renderer 缩放、状态可见性、目录、弹窗禁用、入口点击、项目绑定、零 ACP 启动及草稿保留。
- `tests/e2e/mouse-sidebar.test.tsx`、`phase4.test.tsx`、`phase5.test.tsx`、`tui.test.tsx`：更新布局断言。Harness 专用测试显式选中目标，兼容工作区已有的“新会话继承 Harness”修改。
- `tests/e2e/ui-actions.ts`：测试中的 Write Message 等待编辑器实际取得焦点，避免异步操作仍未完成时输入；路径补全测试等待渲染帧显示候选后再断言。

## 预览

以下来自真实 OpenTUI `captureSpans()`，使用测试项目、临时 SQLite 与真实 Node Daemon；转换为 SVG/PNG 便于查看，不是 Windows Terminal 截图，也不是远端 Agent 运行证据。

- [宽屏预览](evidence/tui-layout/workspace-wide.png)
- [35×12 预览](evidence/tui-layout/workspace-narrow.png)

预览原始数据：`/tmp/hhu-new-conversation-wkpg6q/workspace-{150,100,70,35}.{json,txt}`。颜色来自 renderer 原始 span；字体由 Linux SVG 渲染提供。

## 验证

实际执行：

```bash
bun run build
bun run typecheck
bun run lint
bun run test
bun test tests/e2e
python3 tests/e2e/new-conversation-terminal.py /home/clj/.local/bin/bun /home/clj/HarnessHub/HarnessHub/dist/cli/hhu.js
python3 tests/e2e/harness-terminal.py /home/clj/.local/bin/bun /home/clj/HarnessHub/HarnessHub/dist/cli/hhu.js
python3 tests/e2e/slash-terminal.py /home/clj/.local/bin/bun /home/clj/HarnessHub/HarnessHub/dist/cli/hhu.js
git diff --check
```

- 构建、typecheck、全仓 lint 曾全部通过，日志 `/tmp/hhu-ui-refresh-{build,typecheck,lint}-final.log`。早期 lint 受同时修改的 Desktop 文件影响，后续检查已通过；未为通过 lint 改写其他任务文件。交付前再次运行 typecheck，根项目（含 TUI）和 Daemon 均通过，Desktop 的 `apps/desktop/tests/chat.test.tsx:244` 出现同期修改的重复 JSX 属性错误，日志 `/tmp/hhu-ui-refresh-typecheck-delivery.log`；因此不宣称交付时整个共享工作区 typecheck 通过。
- `bun run test` 的 Node 集成部分 **118/118 通过**，覆盖权限、取消、WS 补拉、Handoff 去重、故障恢复、工作区与数据保护；日志 `/tmp/hhu-ui-refresh-full.log`。
- 第一轮 UI 119/121：原生命令窄窗描述遮挡已修正；steer/queue 测试单独复核通过。第二轮 UI 119/121：继承 Harness 的旧测试前提已修正，并发草稿测试定向复核通过。额外定向回归 44/45：路径补全候选渲染等待存在竞态，已改为等候可见候选。保留这些失败记录，不把早期整套测试写成通过。
- 最终 `bun test tests/e2e`：**121/121 通过，1699 个断言，0 失败**，耗时 132.23 秒，日志 `/tmp/hhu-ui-refresh-ui-complete.log`。这轮包含最终尺寸联动、菜单修复、焦点等待及全部既有 TUI 用例。最终定向 Biome 和 `git diff --check` 通过。
- Linux PTY 项目快捷键通过，`N`/`Ctrl+N`、正确 cwd、草稿和 Daemon 保活：`/tmp/hhu-new-conversation-pty-jrqmt93v`。
- Linux PTY Harness 检查通过，Legacy/Kitty Ctrl+H、Backspace、草稿、模型恢复与零 Prompt：`/tmp/hhu-harness-pty-j9un1adz`。
- 最终构建的原生命令 Linux PTY 通过，补全零 Turn、显式发送、Unicode/换行、折叠粘贴原文、菜单/侧栏保留草稿和退出保活：`/tmp/hhu-slash-pty-_ad741wi`。

## 范围与待验收

共享工作区同时存在 Desktop、存储及发行安装实现，全部保留；本次未修改这些实现。集成结果只对应执行测试时的工作区，不能代替其他任务后续修改的验收。

Windows Terminal / VS Code WSL 的物理字体、鼠标与系统剪贴板未验证；远端真实 ACP 本轮未重新验证，以上交互使用 Mock ACP。

本次交付源码与 `dist/cli/hhu.js` 构建。已安装的全局 `hhu` 仍指向独立不可变 release；未停止用户 Daemon、终止原生会话或覆盖其启动器。需要在合适时机按 `docs/OPERATIONS.md` 安全升级后，才能让全局命令使用新版。

人工验收：

1. 宽屏打开项目，确认概览、会话、目录与选中项；点击新建共享会话并检查 Workspace。
2. 缩至 100、70、35 列，检查 Commands、新建、目录、会话状态和输入框均可使用。
3. 打开归档视图，确认工作区列表只显示归档会话；用原有操作恢复。
4. 在有提交的 Git 测试项目点击 Git Worktree，确认独立工作区；非 Git 项目应明确报错。
5. 打开聊天、ACP 命令、审批和 Changes，检查原生内容、选项、草稿及 Enter/Shift+Enter；关闭 TUI 后确认后台任务仍存在。
