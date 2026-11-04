# Phase 6 定向修正：字母快捷键必须带修饰键

> 本文为 2026-11-02 的历史验收。默认键位和工具折叠规则已由 `phase-6-ctrl-shortcuts-and-tool-details.md` 的 2026-11-04 定向修正替代。

日期：2026-11-02。仅调整当前 TUI 键盘交互，不进入下一阶段。

## 行为与文件

- `packages/shared/src/session-state.ts`：集中声明固定导航组合键；可配置快捷键继续拒绝裸字母和 Shift+字母，并拒绝覆盖固定组合键，避免动作冲突。
- `apps/tui/src/shortcuts.ts`、`index.tsx`、`agent-pane.tsx`：原单字母动作改为准确匹配 Alt 组合键；编辑器和弹窗仍优先接收输入，未增加自动聚焦或自动提交。
- `apps/tui/src/native-events.tsx`、`changes-pane.tsx`、`transcript.ts`：工具、来源查看、复制和刷新改用 Alt 组合键；同步应用自有提示，保留滚动、方向键及 Agent 原始内容。
- `README.md`、`docs/acceptance/windows-terminal-checklist.md`：更新使用说明和待人工验收键位。
- `tests/e2e/shortcuts.test.ts`、`scripts/test.ts`、相关 `tests/e2e/*.test.tsx` 和键盘 PTY 脚本：独立无 Daemon 键位测试纳入完整入口；原正向操作改发组合键，新增裸字母、大小写字母、固定键冲突、工具面板及 Changes 回归。

| 范围 | 组合键 |
| --- | --- |
| 注册项目 / 新建会话 / 操作菜单 / 退出 | Alt+P / Alt+N / Alt+O / Alt+Q |
| 聚焦输入 / 原生审批 / 取消 Turn | Alt+M（或 Enter）/ Alt+A / Alt+C |
| 选择 Harness / 取消切换 / Handoff 失败材料 | Alt+H / Alt+X / Alt+F |
| 选择工具 / 展开折叠 / 查看来源 / 原文复制 | Alt+T / Alt+E / Alt+R / Alt+Y |
| Changes 刷新 / 完整 Diff | Alt+G / Alt+Y |

原 Ctrl+P、Ctrl+B、Ctrl+D、Ctrl+G、Ctrl+Y、Ctrl+C 三态、Enter、Shift+Enter、Ctrl+J 和 Esc 行为不变。`[` / `]` 仍为非字母的聊天项选择键。Alt 在现有配置语法中写作 `meta`；按键不带要求的修饰键时不得触发对应动作。字母快捷键不在消息编辑器或其他输入弹窗中抢占普通输入；导航模式下打字不会自动开始消息。

## 验证

- 初次沙箱内测试因隔离 Daemon 启动失败而受阻；授权后在沙箱外运行隔离本地测试，不使用默认用户实例。
- 最终 `bun run typecheck`、`bun run lint`、`bun run build`、`git diff --check` 均通过；日志分别为 `/tmp/hhu-modifier-shortcuts-typecheck.log`、`/tmp/hhu-modifier-shortcuts-lint.log`、`/tmp/hhu-modifier-shortcuts-build.log`。期间出现过并行修改带来的类型和 lint 报错，最终工作区复核已通过，未覆盖其交互实现。
- `bun test tests/e2e/shortcuts.test.ts tests/e2e/agent-output.test.tsx tests/e2e/chat-scroll.test.tsx tests/e2e/chat-input-focus.test.tsx`：**9/9，通过 567 个断言**，日志 `/tmp/hhu-modifier-shortcuts-offline.log`。覆盖全部固定/默认键的精确修饰符、全部可配置动作对裸字母和 Shift+字母的拒绝、固定键冲突，并复核 Agent 输出、滚动和输入聚焦。
- 初轮 `bun test tests/e2e/tui.test.tsx tests/e2e/phase4.test.tsx tests/e2e/slash-commands.test.tsx`：**52/56**，日志 `/tmp/hhu-modifier-shortcuts-targeted.log`。新增导航裸字母、大小写输入和固定键校验通过；失败包含窄屏项目提示被较长 Alt 键位截断的断言（已改为等待可见 `Press Alt+N`），以及并行滚动/选择修改期间的 Esc 与鼠标/Ctrl+C 用例。之后增加的工具裸字母及 Changes Alt+G/Y 用例尚未完成最终 Daemon 重跑，不能宣称当前整组通过。
- `bun run test`：构建通过，集成 **83/84**，日志 `/tmp/hhu-modifier-shortcuts-full.log`。既有 `phase6.test.mjs:185` 的权限前置断言因当前 Shell `umask 0077` 将创建的 0644 文件收紧至 0600 而失败，UI 阶段未执行；未改动该无关测试或用户 Shell 配置。可在获准的测试进程中用 `umask 022; bun run test` 重跑。
- 最终全部 TUI 重跑请求未执行：审批服务返回 HTTP 503 维护状态。没有绕过审批在沙箱外运行；因此全量通过仍**未验证**。
- `python3 tests/e2e/slash-terminal.py /home/clj/.local/bin/bun /home/clj/HarnessHub/HarnessHub/dist/cli/hhu.js`：通过，证据 `/tmp/hhu-modifier-shortcuts-pty.log`，隔离实例 `/tmp/hhu-slash-pty-lz_ljjfa`。实际 Linux PTY 验证 Alt+M、字母输入、中文/Emoji、换行、命令补全不发送、显式 Enter 仅一条 Turn、Ctrl+P/Ctrl+B 保留草稿、Ctrl+C 清空再退出，以及 Daemon/Session 保活。仅使用 Mock ACP，不是实际模型验证。
- 执行期间有其他任务并行修改同一 TUI 和测试；保留其修改，不将未完成全量检查宣称为全部通过。

## 未验证与手动步骤

推送前复核（2026-11-02）：构建及集成 **84/84** 通过（`/tmp/hhu-push-test.log`），TUI 最终全部 **78/78**、1111 个断言通过（`/tmp/hhu-push-ui-suite.log`），typecheck / lint / build / diff 检查通过。已修正点击聚焦清除历史选区的问题以及 Changes 刷新、鼠标焦点、工具选择的测试同步；详见 [焦点复核记录](phase-6-chat-input-focus.md)。此前沙箱和审批受阻为历史结果，不再代表本轮 Mock 回归状态。Windows GUI 终端及真实 Agent 限制保留。

Windows Terminal / VS Code WSL 的物理 Alt、Shift+Enter、输入法组合及系统保留键本轮**未验证**：当前只有 Linux PTY 和 OpenTUI renderer，不能替代目标 GUI 终端。

1. 在两个终端分别测试所有表内 Alt 组合键；不支持某组合时使用 Ctrl+P 命令面板执行同一操作。
2. 浏览时依次按原裸字母 `pnoqmahcxfteryg` 和对应大写，确认不打开菜单、不切换 Harness、不取消、不退出、不展开或复制。
3. Enter / Alt+M 聚焦输入后输入大小写字母、中文和多行；核对原文完整，Enter 发送、Shift+Enter/Ctrl+J 换行，Esc 返回浏览仍保留草稿。
4. 工具和 Changes 中验证裸字母无动作、Alt+E/R/Y/G 才操作；审批仍须用户按真实 Agent 选项确认。

没有安装或覆盖全局 `hhu`，没有重启用户 Daemon。已有运行实例不会因仓库构建自动更新。
