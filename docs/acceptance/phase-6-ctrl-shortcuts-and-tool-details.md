# Phase 6 定向修正：Ctrl 快捷键与工具详情默认折叠

> 后续按用户提供的 Codex 截图进一步改为“单行调用 + 最多三行原生输出”，协议 JSON 即使展开也只在来源视图显示；见 `phase-6-compact-tool-transcript.md`。本文保留本次改键与初次折叠的历史验收结果。

日期：2026-11-04。仅修正当前阶段的 TUI，不进入下一阶段。

## 行为

- 默认动作不再使用 Alt，改为精确匹配 Ctrl；裸字母、Shift+字母及旧 Alt 组合键不触发默认动作。
- 为避免 Ctrl+P 命令面板、Ctrl+C 复制/清空/退出，以及 Ctrl+M / Ctrl+H 的传统终端 Enter / Backspace 别名，部分动作更换字母，而不是直接替换修饰键。
- 按本次用户要求，工具详情不论 pending、in_progress、completed、failed、WAITING_APPROVAL，均默认折叠，替代此前“运行中/失败/等待审批默认展开”的规则。状态、颜色及原生审批选项仍显示，不自动批准或隐藏审批入口。
- Ctrl+E 显式展开后显示原生参数、结果、终端内容和其他原始详情；后续状态更新和面板重新挂载尊重手动选择。不改写 Guardian Review 或其他工具的原生状态、名称与正文。
- Ctrl+R 查看原始事件；Ctrl+Y 有选区时复制选区，无选区时打开当前项完整原文。Changes 面板复用 Ctrl+R 刷新、Ctrl+Y 查看完整 Diff，与聊天互斥挂载。
- 不修改数据库、Agent 配置或审批机制，不重放 Turn，不自动安装或重启用户实例。自定义快捷键保留原有配置语法兼容。

| 动作 | 默认组合键 |
| --- | --- |
| 注册项目 / 新建会话 / 操作菜单 / 退出 | Ctrl+W / Ctrl+N / Ctrl+O / Ctrl+Q |
| 聚焦输入 / 原生审批 / 取消 Turn | Ctrl+L（或 Enter）/ Ctrl+A / Ctrl+X |
| 选择 Harness / 取消切换 / Handoff 失败材料 | Ctrl+F / Ctrl+U / Ctrl+K |
| 选择工具 / 展开折叠 / 来源 / 原文 | Ctrl+T / Ctrl+E / Ctrl+R / Ctrl+Y |
| 命令面板 / 侧栏 / Changes / 活动汇总 | Ctrl+P / Ctrl+B / Ctrl+D / Ctrl+G |

Enter 发送、Shift+Enter / Ctrl+J 换行、Esc、方向键、分页和 Ctrl+C 三态保持原行为。导航快捷键不抢占消息编辑器或输入弹窗里的原生编辑键。

## 文件

- `packages/shared/src/session-state.ts`：固定 Ctrl 键位、配置冲突校验和默认复制键兼容。
- `apps/tui/src/native-events.tsx`、`transcript.ts`、`rich-content.tsx`、`index.tsx`、`agent-pane.tsx`、`changes-pane.tsx`：折叠策略及全部应用自有提示。
- `tests/e2e/shortcuts.test.ts`、`agent-output.test.tsx`：键位精确匹配、旧 Alt 不触发、所有工具状态默认折叠、Guardian Review 历史、手动展开保留及原始事件保真回归。
- 其他 `tests/e2e/*.test.tsx`、键盘 PTY 脚本及 `tests/integration/phase4.test.mjs`：正向操作改用 Ctrl，更新折叠预期与配置示例。
- `README.md`、`docs/OPERATIONS.md`、Windows 终端清单和 Phase 6 记录：同步当前操作说明，旧验收保留为历史。

## 验证

- `bun test tests/e2e/shortcuts.test.ts tests/e2e/agent-output.test.tsx`：6/6 通过，646 个断言。
- `bun run typecheck`、`bun run lint`、`bun run build`、`git diff --check`：通过。
- `python3 tests/e2e/slash-terminal.py /home/clj/.local/bin/bun /home/clj/HarnessHub/HarnessHub/dist/cli/hhu.js`：通过。证据 `/tmp/hhu-ctrl-pty.log`、隔离目录 `/tmp/hhu-slash-pty-xbm5pc16`；从 Home 启动，Ctrl+L 聚焦、中文/Emoji、多行输入、命令补全零 Turn、显式发送仅一 Turn、Ctrl+P / Ctrl+B 保留草稿、Ctrl+C 清空再退出、Daemon/Session 保活。
- 沙箱内完整测试在隔离 Daemon 启动前受阻，未计为通过。授权后的首轮集成 82/84：PTY 等待的状态栏文本被增量 ANSI 输出拆分；另一个权限断言受继承的 `umask 077` 影响（期望 0644、实际 0600）。PTY 现改等非忙碌状态栏的稳定后缀，不能只等输入框出现就开始输入。
- 前两次单独 PTY 探测分别在上述就绪检查和启动忙碌期输入丢失处失败，未计为通过；失败探测遗留的两个临时 Daemon 已按各自 XDG 目录正常关闭，未使用 force。
- `umask 022; bun run test`：集成测试 **84/84 通过**；界面测试初次 **78/79**，仅原“运行中 Diff 自动展开”预期超时并产生关联异步错误，因此该完整入口当次仍退出非零。只调整该测试进程的 umask，不修改用户 Shell；日志 `/tmp/hhu-ctrl-full-test-final.log`。
- 将该 Diff 渲染用例的第二个工具也显式设置为展开后，按 `scripts/test.ts` 的相同文件清单单独重跑全部界面回归：`umask 022; bun test tests/e2e/shortcuts.test.ts tests/e2e/tui.test.tsx tests/e2e/phase4.test.tsx tests/e2e/agent-output.test.tsx tests/e2e/chat-scroll.test.tsx tests/e2e/chat-input-focus.test.tsx tests/e2e/phase5.test.tsx tests/e2e/mouse-sidebar.test.tsx tests/e2e/slash-commands.test.tsx`，**79/79 通过，1225 个断言，无错误**。日志 `/tmp/hhu-ctrl-ui-final.log`。此后没有产品源码变更；未再次重复耗时的集成段，不声称完整入口有单次全绿结果。

## 未验证与人工验收

- Windows Terminal / VS Code WSL 物理键盘、桌面剪贴板及真实 ACP Agent 本轮**未验证**；不扩大 Agent 支持矩阵或最终 MVP 验收结论。
- 旧自定义配置若占用了新增固定 Ctrl 导航键（例如旧示例的 `palette: ctrl+o`），须在 Configure Shortcuts 中改用未保留键或提交 `{}` 恢复默认；本轮不迁移或静默改写这类用户自定义配置。
- 更新安装后打开用户所述历史：工具及 Guardian Review 应只显示标题、状态和折叠入口，Ctrl+T 选择、Ctrl+E 展开/折叠，Ctrl+R / Ctrl+Y 核对来源和原文；运行中状态不得因 UI 折叠伪装为完成。
- 测试真实审批时，工具详情折叠仍须保留 Agent 原生选项；用户不选择就不得批准。检查 Ctrl+X 取消、Ctrl+C 复制/清空/退出和关闭 TUI 后后台保活。
- 本轮未更新全局安装、未停止默认 Daemon、未修改用户数据；全局 `hhu` 的安装更新按 `docs/OPERATIONS.md` 执行。
