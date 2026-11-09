# 阶段 6 补充验收 — 输入占位提示即时隐藏

日期为 2026-11-09。本次修复聊天输入区域的占位提示与输入法预编辑文字重叠。

## 实现

- `apps/tui/src/agent-pane.tsx` 在进入消息编辑态时清除 placeholder，覆盖 Enter 激活、鼠标点击和会话恢复时已经处于编辑态的入口。空输入退出编辑态后恢复提示，编辑态内清空内容仍保持隐藏。
- 截图中的 `pu` 与输入法候选栏提示问题可能发生在系统输入法提交文字之前。因此选择进入编辑态就隐藏提示，提前避开预编辑窗口。
- `tests/e2e/chat-input-focus.test.tsx` 增加真实 OpenTUI renderer 回归，检查空输入聚焦后首帧、英文输入、逐字退格清空、中文及 Emoji 多行粘贴、失焦保留草稿、清空后恢复提示和鼠标聚焦。

## 验证

- 修改前新增用例在空输入聚焦后仍显示提示的断言处失败。
- `bun test tests/e2e/chat-input-focus.test.tsx` 通过，2 项测试、30 个断言。日志为 `/tmp/hhu-placeholder-focus.log`。
- `bun run typecheck` 通过，日志为 `/tmp/hhu-placeholder-typecheck.log`。
- `bun run lint` 与 `git diff --check` 通过，lint 日志为 `/tmp/hhu-placeholder-lint.log`。
- `umask 022; bun run test` 完整入口通过，包括构建、101 项 Node 集成测试和 99 项 Bun/OpenTUI 测试，共 200 项，0 失败、0 跳过。TUI 共 1359 个断言，日志为 `/tmp/hhu-placeholder-full-test.log`。工作区同期存在其他 TUI 修改，以上为当时实际代码的整体验证结果。
- `python3 tests/e2e/slash-terminal.py /home/clj/.local/bin/bun /home/clj/HarnessHub/HarnessHub/dist/cli/hhu.js` 通过。Linux PTY 配合隔离 Daemon / Mock ACP 验证 UTF-8、多行、草稿、发送及退出保活，证据目录为 `/tmp/hhu-slash-pty-dxxl2ldb`，日志为 `/tmp/hhu-placeholder-pty.log`。

## 待人工验收

Windows Terminal / VS Code WSL 的系统中文输入法预编辑本轮未验证，当前环境的 renderer 与 Linux PTY 测试无法生成截图里的 Windows IME 候选窗口。

1. 使用本轮构建打开空会话，通过 Enter 或鼠标点击进入消息输入。
2. 确认开始拼音输入之前占位提示已经消失，输入 `pu` 并保持候选栏打开，检查输入区域没有提示文字重叠。
3. 选择候选汉字、退格清空、再次输入，检查编辑态持续隐藏提示。空输入按 Esc 退出编辑后应恢复提示。
4. 输入中文多行草稿并切换会话再返回，检查草稿恢复与 Enter 发送。

本轮构建位于 `dist/cli/hhu.js`。全局安装尚未更新。
