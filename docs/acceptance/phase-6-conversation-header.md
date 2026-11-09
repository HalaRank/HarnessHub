# Phase 6 会话顶部信息层级

2026-11-09，当前阶段的 TUI 视觉调整。

用户随后要求进一步减少顶部占用。常规两行与窄屏换行的当前实现见[压缩验收记录](phase-6-compact-conversation-header.md)，本文件保留五行版本的实施和验证历史。

## 实现

- 会话标题独立加粗，移除顶部 `Conversation ·` 前缀，为实际标题保留宽度。长标题使用 OpenTUI 单行省略，归档标记使用 warning 色。
- Workspace 标签为 muted，路径为 secondary，长路径单行省略。
- Agent 名称加粗，ACP 标签弱化，真实执行状态带圆点，靠右与 Agent 同行。模型独立常驻，标签和值使用不同文字层级。
- Chat / Changes 与连接信息位于底部工具栏，中间横线划分顶部与内容区域。正常连接使用辅助色，异常继续使用既有状态色。
- 常规顶部占五行。Agent 和模型支持换行，实际身份、模型、待切换及 Handoff 提示来自已有数据路径。

## 文件

- `apps/tui/src/index.tsx` 的标题和 Workspace 渲染。
- `apps/tui/src/agent-pane.tsx` 的 Agent、模型、执行状态与工具栏。
- `tests/e2e/phase4.test.tsx` 增加长中文标题、100/80/32 列、颜色字重、边界、不重叠、聊天区高度及 Changes 检查，更新原布局顺序断言。
- `tests/e2e/tui.test.tsx`、`mouse-sidebar.test.tsx`、`new-conversation.test.tsx`、`phase5.test.tsx` 更新顶部标题或状态显示断言，命令面板中的 Conversation 分类名称继续保留。
- `tests/e2e/ui-actions.ts` 共用标题等待方法，直接比较顶部标题控件的内容，避免侧栏同名文字提前满足等待条件。

## 验证

使用 `/home/clj/.nvm/versions/node/v24.18.0/bin` 补入测试进程 PATH。

```bash
bun run typecheck
bun run lint
bun run build
bun test tests/e2e/phase4.test.tsx -t 'conversation header|compact layout'
umask 022
bun run test
python3 tests/e2e/harness-terminal.py /home/clj/.local/bin/bun /home/clj/HarnessHub/HarnessHub/dist/cli/hhu.js
git diff --check
```

- 定向布局测试 2/2 通过，109 个断言。字符帧在 `/tmp/hhu-phase4-ui-zTW5jr/conversation-header-{100,80,32}.txt`，日志 `/tmp/hhu-conversation-header-targeted.log`。30 行终端保留至少 18 行聊天历史区域。
- typecheck、lint、构建与 diff 检查通过。完整测试 101/101 项 Node 集成与 99/99 项 TUI 通过，共 200 项，TUI 1359 个断言，日志 `/tmp/hhu-conversation-header-full-test.log`。
- 随后补强顶部标题等待断言，对涉及标题与布局的五个 UI 测试文件复跑，63/63 通过、625 个断言，日志 `/tmp/hhu-conversation-header-final-ui.log`。最终字符帧在 `/tmp/hhu-phase4-ui-MUxr9b/conversation-header-{100,80,32}.txt`。复核 typecheck、lint 与构建也通过。
- 最新构建的 Linux PTY 通过。PTY 使用隔离 XDG 和 Mock ACP，验证真实 CLI 的模型显示、Ctrl+H、草稿、关闭后重开、零 Prompt 与 Daemon 保活。最终证据 `/tmp/hhu-harness-pty-vf2evztb/evidence.json`，日志 `/tmp/hhu-conversation-header-final-pty.log`。
- 布局评估和机械预扫描使用两个独立子 Agent。终端布局评估发现的标题竞争、字段等权、正常连接过度强调与内容缺少边界已在本次调整中处理。detector 前后均返回 `[]`，其 HTML/CSS 规则不能代替终端 renderer 的布局验证。
- 开发中首轮新测试把全局 Connected 状态一并纳入会话栏颜色检查，随后发现 32 列下前缀影响标题可见性。已限定逐行样式断言，并移除标题前缀后重跑通过。

## 待人工验收

Windows Terminal / VS Code WSL 物理终端的字体和颜色呈现本轮未验证。打开会话，在宽屏和约 32 列窗口检查标题省略、Workspace、Agent 与状态对齐、模型常驻和工具栏，并切换 Changes 和待交接 Harness 后检查身份与模型显示。

本轮未调用真实远端 Agent，未更新全局安装。共享工作区存在同期输入占位文字、鼠标和原生内容渲染修改，整体验证结果对应执行时的共享工作区。
