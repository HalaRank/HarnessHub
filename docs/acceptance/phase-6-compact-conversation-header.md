# Phase 6 会话顶部压缩

2026-11-09。用户反馈五行顶部占用过多空间，进一步压缩当前 TUI。

## 布局

- 常规宽度使用两行。第一行是加粗标题与右侧灰色路径，路径占 40% 宽度并单行省略，标题使用其余宽度。
- 第二行左侧是 Agent 与 ACP 实际模型，右侧是运行状态与 Chat / Changes。移除 ACP、Model 等重复标签、单独工具栏和装饰横线。正常连接通过全局顶栏显示，会话连接异常直接追加在状态后。
- 32 列时 Agent / 模型和状态各占一行，总计三行。长字段与异常状态按实际空间换行，模型完整显示。
- 30 行窗口下，常规宽度的历史区至少 21 行，32 列下至少 20 行。此前五行布局的常规历史区至少 18 行。
- Project 目录视图继续提供标题和完整路径两行。Conversation 的完整路径保存在路径控件中，屏幕省略仅影响可见内容。
- 待切换仍显示真实源 Agent / 模型，目标与 Handoff、审批、UNCERTAIN 等提示继续按实际状态显示。

## 文件

- `apps/tui/src/index.tsx` 合并 Conversation 标题与路径。
- `apps/tui/src/agent-pane.tsx` 合并 Agent、模型、状态与视图名称，使用 Flex 换行。
- `tests/e2e/phase4.test.tsx` 更新行数、位置、样式、完整路径、Changes 和窄屏审批断言。
- `tests/e2e/codex-inputs.test.tsx`、`tui.test.tsx`、`phase5.test.tsx`、`mouse-sidebar.test.tsx`、`slash-commands.test.tsx`、`new-conversation.test.tsx` 更新合并后的元数据断言，保留 Harness 切换、草稿、真实 Workspace 与 Handoff 验证。
- `tests/e2e/harness-terminal.py`、`new-conversation-terminal.py` 更新终端显示检查。
- `docs/01_ARCHITECTURE.md` 记录本次用户要求对独立换行约定的修正。本记录及 Phase 6 索引更新。

## 验证

命令使用 `/home/clj/.nvm/versions/node/v24.18.0/bin` 补入测试进程 PATH，运行隔离 XDG 和 Mock ACP。

```bash
bun run typecheck
bun run lint
bun run build
bun test tests/e2e/phase4.test.tsx -t 'conversation header|compact layout'
bun test tests/e2e/shortcuts.test.ts tests/e2e/tui.test.tsx tests/e2e/phase4.test.tsx tests/e2e/agent-output.test.tsx tests/e2e/chat-scroll.test.tsx tests/e2e/chat-input-focus.test.tsx tests/e2e/phase5.test.tsx tests/e2e/mouse-sidebar.test.tsx tests/e2e/slash-commands.test.tsx tests/e2e/codex-inputs.test.tsx tests/e2e/ui-hierarchy.test.tsx tests/e2e/new-conversation.test.tsx
HARNESSHUB_BUN=/home/clj/.local/bin/bun node --test --test-concurrency=1 tests/integration/phase4.test.mjs tests/integration/phase5.test.mjs
python3 tests/e2e/harness-terminal.py /home/clj/.local/bin/bun /home/clj/HarnessHub/HarnessHub/dist/cli/hhu.js
python3 tests/e2e/new-conversation-terminal.py /home/clj/.local/bin/bun /home/clj/HarnessHub/HarnessHub/dist/cli/hhu.js
git diff --check
```

- 初轮定向布局 2/2 通过，95 个断言，100/80/32 列字符帧 `/tmp/hhu-phase4-ui-CGtRsx/compact-header-{100,80,32}.txt`。
- 全部 TUI 测试 100/100 通过、1427 个断言，日志 `/tmp/hhu-compact-header-ui.log`。
- Phase 4 / 5 集成测试 25/25 通过，覆盖 Changes、实际 Workspace、审批、取消、Handoff 去重与不确定请求，日志 `/tmp/hhu-compact-header-integration.log`。
- 最终补查 32 列 WAITING_APPROVAL 下的 Agent / 模型、原生审批选项和取消后恢复，连同布局及后台运行鼠标导航共 3/3 通过、105 个断言，日志 `/tmp/hhu-compact-header-final-targeted.log`，字符帧 `/tmp/hhu-phase4-ui-3RIccY/compact-header-{100,80,32}.txt`。审批选项会自然换行，初次整行字符串断言失败后改为忽略布局空白，复跑通过。
- typecheck、lint、构建通过。首次全仓 typecheck 遇同期 Desktop 烟测的鼠标修饰键大小写类型错误，该文件同期修正后复核通过，日志 `/tmp/hhu-compact-header-typecheck-final.log` 和 `/tmp/hhu-compact-header-lint.log`。
- 收尾复核 typecheck、lint、构建与 diff 检查通过，日志 `/tmp/hhu-compact-header-final-checks.log`。合并重复显示断言后，基础 TUI 8/8 通过、55 个断言，日志 `/tmp/hhu-compact-header-final-tui.log`。
- 两个真实 Linux PTY 脚本通过，Harness / 模型、草稿保留、重开、Ctrl+H、项目和独立会话快捷键、零 Prompt 与 Daemon 保活得到验证。证据 `/tmp/hhu-harness-pty-vr16nd5r/evidence.json` 与 `/tmp/hhu-new-conversation-pty-gjhh6zni`，日志 `/tmp/hhu-compact-header-pty.log`、`/tmp/hhu-compact-header-new-conversation-pty.log`。

## 待验收

Windows Terminal / VS Code WSL 的物理窗口外观本轮未验证。打开会话，确认两行顶部，再缩至约 32 列确认状态换行、Agent 与模型可见，切换 Changes、Harness 与审批状态检查提示。

本轮交付源码与构建。全局 `hhu` 安装待按安全升级流程更新。真实远端 Agent 本轮未验证，Mock / Linux PTY 证据仅覆盖本次渲染和既有交互路径。共享工作区包含同期 Desktop 实施，验证结果对应运行时的合并状态。
