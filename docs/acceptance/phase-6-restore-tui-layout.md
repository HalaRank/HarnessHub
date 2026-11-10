# Phase 6：恢复上次重构前的 TUI

2026-11-10。用户要求以最近一次 TUI 重构之前的 UI 为基准，恢复左侧项目/对话树、右侧会话主界面。本次属于现有 TUI 调整，不进入下一阶段。

用户随后明确要求以恢复后的版本继续优化全局 UI，当前呈现与验证见[命令菜单及全局 UI 优化](phase-6-command-menu-ui.md)。本记录描述恢复步骤与首次安装。

## 基准与实现

- 重构提交：`7422a19 feat(tui): redesign workspace overview and responsive layout`。
- 恢复基准：该提交的父提交 `0462655`。`index.tsx`、`project-tree.tsx`、`project-directory.tsx`、`ui.tsx`、`agent-pane.tsx` 的呈现恢复到该版本。
- 左侧恢复带边框的 `Projects → Conversations`、34 列上限、项目三行/会话两行间距；右侧会话保留紧凑标题、Agent/模型/状态、原生聊天历史和输入框。选中项目时恢复原来的只读目录页。
- 恢复顶部左侧 Commands 入口、原配色、输入框和弹窗边框、底部快捷提示。窄于 90 列沿用原版自动收起及手动开关侧栏的行为。
- 删除本次被撤回重构独有的 `action-button.tsx` 和 `workspace-overview.tsx`，不保留重复会话概览。保留 `workspace-sidebar` / `conversation-main` 的 renderer ID，便于检查真实布局；它们不改变呈现。
- 保留窄窗原生命令标题单行截断修复，以及测试中等待焦点、路径补全渲染和固定 Harness 前置状态的修复。
- 调整原有 UI 断言；用真实 renderer 回归替换概览测试，检查 150/100/70/35 列及回宽、会话点击、项目绑定、零原生会话创建和弹窗草稿保留。PTY 重开检查使用实际初始化状态和持久化会话 ID，避免把增量绘制后的原始字节串当作完整屏幕文本。

## 验证

日志：`/tmp/hhu-tui-restore-{build,typecheck,lint-final,test}.log`。

```bash
bun run build
bun run typecheck
bun run lint
umask 022
bun run test
python3 tests/e2e/new-conversation-terminal.py /home/clj/.local/bin/bun /home/clj/HarnessHub/HarnessHub/dist/cli/hhu.js
python3 tests/e2e/slash-terminal.py /home/clj/.local/bin/bun /home/clj/HarnessHub/HarnessHub/dist/cli/hhu.js
git diff --check
```

构建、类型检查、全仓 lint 和 `git diff --check` 通过。`bun run test` 完整通过：Node 集成 **119/119**，TUI **120/120**、1631 个断言，零失败；Node 耗时 305.35 秒，TUI 耗时 72.33 秒。

- 新建/布局定向复核 **4/4 通过，60 个断言**；`/tmp/hhu-tui-restore-layout-recheck.log`。首次定向执行新增用例因侧栏目标在视口外而超时，修正测试先滚动到真实目标后通过。
- Linux PTY 新建/重开通过：`/tmp/hhu-new-conversation-pty-zg67jucb/evidence.json`；项目 N、独立 Ctrl+N、正确绑定目录、草稿及退出后 Daemon 保活、零 ACP 请求。首次 PTY 原始字节串未包含完整 `codex`，不代表会话恢复失败，相关旧断言已修正。
- Linux PTY 原生命令通过：`/tmp/hhu-slash-pty-zrj6gkt8`；补全零 Turn、显式发送、Unicode/换行、折叠粘贴原文、菜单/侧栏草稿保留及退出后 Worker 保活。使用隔离 Mock ACP。
- renderer 字符帧及颜色：`/tmp/hhu-new-conversation-rS8Clm/restored-chat-{150,100,70,35}.{txt,json}`，使用隔离项目和真实 Node Daemon，并非物理终端截图。

## 全局安装

用户确认已停止 Daemon 后，实测默认实例不可达，再执行 `bun run install:local`，成功更新 `~/.local/bin/hhu` 与配套 Bridge 启动器。全程使用安装器既有实例锁和原子替换，没有修改用户数据库、停止用户 Worker 或重放任务。

- 新发布：`dist/releases/d047ecab-8724-45e7-82e1-50001693c46c`；`hhu --version` 返回 `HarnessHub 0.6.2`。
- 旧启动器备份：该发布的 `previous-launchers/`，旧发布保留。
- 安装日志：`/tmp/hhu-tui-restore-install.log`。
- 直接从 `/home/clj` 运行已安装 `~/.local/bin/hhu` 的隔离 Linux PTY 检查通过：显示原版 `Projects → Conversations` 与欢迎页，Ctrl+C 正常退出且 Daemon 保活。证据 `/tmp/hhu-restored-installed-wbd_4185/evidence.json`，日志 `/tmp/hhu-tui-restore-installed-pty.log`。仅测试实例被清理，默认用户实例保持停止。

## 范围和人工验收

未验证 Windows Terminal / VS Code WSL 物理字体、键盘及鼠标；本轮未重新验证真实远端 ACP。未修改 Daemon、ACP、SQLite、Desktop 或发行工作流；原有未提交的发行文档和证据保留。

1. 从 `~` 运行新版 `hhu`，检查原版左侧项目/对话树与右侧聊天，点击会话切换。
2. 选中项目检查只读目录，按 N 创建项目会话，确认 Workspace；Ctrl+N 仍创建启动目录下的独立会话。
3. 检查宽窄缩放、原生 Slash、Enter/Shift+Enter、工具展开、审批、Changes 和草稿，退出客户端后确认后台工作继续。
