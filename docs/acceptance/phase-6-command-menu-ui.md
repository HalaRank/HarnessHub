# Phase 6：以原版双栏为基准优化全局 UI

2026-11-10。用户澄清目标：先恢复 `7422a19` 之前的 UI，再优化全局视觉，重点是 `/ Commands` 菜单。左侧项目/对话列表、右侧会话主界面的结构不可改变，其他区域可以重做。

## 当前实现

基准为 `0462655`，恢复过程见[恢复记录](phase-6-restore-tui-layout.md)。当前左侧树的组件与只读目录组件和该提交相同；项目/会话名称、侧栏尺寸、项目三行/会话两行间距、右侧标题/状态/历史/输入顺序及窄窗规则保留。主区域只调整输入框圆角、共享快捷提示的视觉，未新增工作区概览、重复会话列表或额外侧栏。

`/ Commands` 重做为顶部居中的浮层，宽度上限 88 列、高度上限 32 行：

- 搜索框固定在顶部，结果数和当前序号固定可见；移除原菜单中占空间且与当前动作无关的聊天操作说明。
- 按 Conversation、Workspace、Projects、Conversations、Interface 分组；写消息、Changes、Harness、ACP 设置优先，删除动作放在同组末尾并标红。
- 标题加粗、说明减弱，选中项同时使用背景和箭头；快捷键独立靠右，普通尺寸底部另设最多三行的选中项说明。长名称/路径在列表中截断显示，实际数据和动作不变。
- 搜索忽略大小写、前导 `/` 和首尾空白，多个关键词可跨名称/说明/路径匹配。名称精确匹配优先，其次前缀和包含匹配；清空搜索恢复分组。
- ↑↓ 选择可执行项，不选中分组标题；PgUp/PgDn 翻页；Enter 执行、Esc 关闭；鼠标点击仍按按下/释放目标 ID 验证，不把滚轮或拖动当作点击。
- 按命令 ID 保持选中项，后台快照更新或列表重排不会把用户的选择漂移到邻项；使用固定索引渲染槽避免 OpenTUI 重排警告。
- 35×12 下压缩留白和说明区，保留搜索、可滚动结果和完整可容纳的快捷提示。输入框、菜单和结果区均检查边界。

其他区域：通用弹窗按所属区域居中、限宽、圆角，标题和说明分层；新增项目、重命名改为浮层，打开时不挤压主区域。原文查看器保留宽视图。原生 Slash 建议框采用同样的边框视觉，内容、命令候选、参数和权限选项仍来自真实 ACP；没有把 HHU 管理动作混进原生命令。

## 文件

- `apps/tui/src/command-palette.tsx`：搜索、分组、导航、滚动、鼠标及命令列表样式。
- `apps/tui/src/index.tsx`：菜单分组/快捷键/说明元数据、重命名浮层、Commands 入口样式；会话选择及动作逻辑复用原实现。
- `apps/tui/src/ui.tsx`：通用浮层与按宽度展示的快捷提示。
- `apps/tui/src/project-path-input.tsx`、`source-viewer.tsx`、`slash-commands.tsx`、`agent-pane.tsx`：弹窗/原文视图/建议框/输入边框的样式。
- `tests/e2e/ui-hierarchy.test.tsx`、`new-conversation.test.tsx`：菜单分组、大小写/多关键词/路径搜索、空结果、尺寸边界、动态 ID、分页、鼠标目标及弹窗前后主区域几何不变。

## 预览

由真实 OpenTUI `captureSpans()` 导出 SVG，使用本机 librsvg/Cairo 转为 PNG。实际 App 预览使用临时 SQLite 与真实 Node Daemon、测试会话；不是物理终端截图或真实远端模型验证。

- [实际 App 中的宽屏菜单](evidence/command-menu-ui/commands-wide.png)
- [项目上下文的工作区菜单](evidence/command-menu-ui/commands-project.png)
- [35×12 菜单](evidence/command-menu-ui/commands-narrow.png)
- 同目录保留对应 SVG。

源数据：`/tmp/hhu-new-conversation-4vFzyD/commands-{in-app,project}.{txt,json}`、`/tmp/hhu-command-ui-JnKVeY/frames/commands-35.{txt,json}`；导出脚本 `/tmp/hhu-render-command-previews.py`。

## 验证结果

实际执行：

```bash
bun run build
bun run typecheck
bun run lint
bun test tests/e2e
bun test tests/e2e/ui-hierarchy.test.tsx tests/e2e/new-conversation.test.tsx
python3 tests/e2e/slash-terminal.py /home/clj/.local/bin/bun /home/clj/HarnessHub/HarnessHub/dist/cli/hhu.js
git diff --check
```

- 构建、全仓类型检查通过。最终完整 TUI **122/122**，**1694 个断言**，0 失败，耗时 96.33 秒；日志 `/tmp/hhu-ui-opt-all-final.log`。最终全仓类型检查日志 `/tmp/hhu-ui-opt-typecheck-verified.log`，最终构建日志 `/tmp/hhu-ui-opt-build-ready.log`。
- TUI 与 E2E 定向 lint 通过，日志 `/tmp/hhu-ui-opt-lint-scoped.log`。早前全仓 lint 通过；交付前再次检查，全仓 lint 被并行新增的 Desktop `ArchiveDialog.tsx` 格式问题阻塞，日志 `/tmp/hhu-ui-opt-lint-ready.log`，本任务未改写其他任务文件，不能宣称交付时全仓 lint 通过。`git diff --check` 通过。
- 最后说明文字对齐、项目上下文默认动作及嵌套弹窗边界修正后，菜单及实际 App 定向复核 **9/9**、188 个断言通过，日志 `/tmp/hhu-ui-opt-bounds.log`。项目菜单默认选中新建会话，删除仍在组末尾并需要确认。新增右侧嵌套弹窗的 150/100/70 列边界测试，确认不会按全终端宽度错误居中到父区域之外。动态菜单固定索引渲染也有独立 **16/16** 定向回归，日志 `/tmp/hhu-ui-opt-targeted.log`。
- Linux PTY 原生命令、显式提交、Unicode/换行、折叠粘贴原文、菜单/侧栏保留草稿、Ctrl+C 及退出后 Worker 保活通过；证据 `/tmp/hhu-slash-pty-wamuyiz6`，日志 `/tmp/hhu-ui-opt-slash-pty-delivery.log`，使用隔离 Mock ACP。
- 本任务前一部分已运行 `bun run test`，Node 集成 **119/119**；本轮后续只修改 TUI，未重复运行相同后端回归，日志 `/tmp/hhu-tui-restore-test.log`。
- 开发中定向检查发现窄窗结果区只剩一行、搜索输入越界，已压缩留白并限制输入宽度；测试翻页最初传入了普通字符串，改为真实 PgDn 转义序列；Esc 断言等待解析完成。以上问题修正后再运行上述通过结果。

Windows Terminal / VS Code WSL 物理键盘、字体、鼠标与系统剪贴板本轮未验证；没有把 Mock ACP 交互当作真实远端 Harness 验证。本次不改后端、数据库、原生权限与 Handoff 状态机，不进入下一阶段。

## 全局安装状态

本轮已构建最新 `dist/cli/hhu.js`。先前恢复版的全局安装见恢复记录；菜单优化版另行更新。

检测到全局 Daemon 再次运行后，读取其活动统计为运行任务 0、待审批 0，执行普通 `hhu daemon stop` 成功；没有使用取消活动任务或强制终止。但随后 Daemon 又以新 PID 启动，`bun run install:local` 在 `scripts/install-local.ts:40` 拒绝替换启动器。因此此轮尝试没有更新全局发布，旧启动器保持可用。日志 `/tmp/hhu-ui-opt-{stop,install}.log`。随后用户明确选择“先保留当前运行，交付源码和构建”；本轮不再停止或更新默认实例，安装锁未被绕过。以后更新需先关闭可能启动 Daemon 的客户端并保持停止。

共享工作区另有持续更新的 Desktop、Core 和相关测试修改，本任务未编辑或回滚这些文件。上述验证结果对应各日志运行时的工作区，不能替代并行任务后续修改的验收。期间一次全仓类型检查因同期 Desktop `App.tsx:506` 引用缺失报错；该文件随后被其所属工作更新，最终完整类型检查通过，本任务未修改该文件。

## 人工验收

1. 重开新版 `hhu`，确认左右两块原版结构、名称、滚动和会话切换一致。
2. 打开 `/ Commands`：浏览分组，输入名称、多关键词或路径，检查选中说明、分页、鼠标及 Esc 返回草稿。
3. 打开新增项目、重命名、删除、ACP 设置和原文窗口，检查视觉与焦点；删除仍必须确认，原生审批仍由用户决定。
4. 缩至 35×12 后再回宽屏，检查边界和输入；在目标 Windows 终端分别核对 Enter/Shift+Enter 和剪贴板。
