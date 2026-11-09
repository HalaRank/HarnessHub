# 阶段 6 补充验收：输入框增高与大段粘贴折叠

日期：2026-11-09。本轮仅完善现有 TUI 输入，不扩展到 Desktop 或下一阶段。工作区已有其他 Desktop、原生 Slash 命令与文档修改，均保留。

## 行为与实现

- `apps/tui/src/agent-pane.tsx`：输入高度统一按锁定 OpenTUI 0.8.0 的 `editorView.getTotalVirtualLineCount()` 计算，而不是仅取可见虚拟行数；普通输入向上增高，最多 8 行，删除后收缩，窄终端保留高度限制。空文本不统计 placeholder 的折行，避免占位提示撑高空输入框。
- `apps/tui/src/paste-blocks.ts`：单次 bracketed paste 达到 6 行或 1000 个 Unicode 字符时折叠。使用现有 OpenTUI extmarks 跟踪标签范围和原文，不按字符串全局替换，因此用户手打同名标签不被展开成其他内容。延续原有粘贴解码和 ANSI 过滤。
- 支持多个粘贴块、F2 / 点击提示展开全部内容后编辑、Backspace / Delete 整块删除、部分选区替换按整块处理、词删除、撤销与重做。展开本身保留撤销历史。
- `messageText()` 为发送和草稿提供完整原文；历史导航缓存也保留原文。Enter、运行中追加及 Tab 排队共用既有 requestId / Draft CAS 投递路径，不改变审批、取消或重试规则。
- SQLite 仅保存原文。重开会话恢复为完整可编辑文本，不恢复折叠 UI 状态，无数据库迁移。折叠不会触发任何 Agent 调用。
- `tests/e2e/paste-blocks.test.tsx` 覆盖阈值、中文/Emoji、同名普通标签、多块拼接、替换、删除、撤销/重做、展开、清空与恢复；已加入 `scripts/test.ts`。
- `tests/e2e/chat-input-focus.test.tsx` 补输入框向上增高、自动折行、窗口宽度变化、多行草稿和收缩测试；修改前已复现自动折行后仍只有一行高度。
- `tests/e2e/codex-inputs.test.tsx` 补隔离 Daemon / Mock ACP 原文发送、F2/点击展开、历史导航、SQLite 草稿重开、排队和未发布 slash 的确认保护测试；`tests/e2e/slash-terminal.py` 增加 Linux PTY 大段粘贴验收。
- `docs/OPERATIONS.md` 补使用说明。

## 验证记录

- 离线 OpenTUI 粘贴用例通过：9 项测试，57 个断言，日志 `/tmp/hhu-paste-blocks.log`；合并输入框焦点/增高用例后，12 项测试、135 个断言通过，日志 `/tmp/hhu-paste-offline.log`。
- `umask 022; bun run test` 完成构建并通过 **101/101 Node 集成测试**，日志 `/tmp/hhu-paste-full-test.log`。此轮 TUI 首跑 114/116，暴露窄终端占位提示增高和选区内换行拆标签两项问题，均已修复并补断言；没有将首跑整体入口记为通过。
- 修复后重跑标准 runner 的全部 13 个 TUI 测试文件：**116/116 通过，1582 个断言，0 失败**，日志 `/tmp/hhu-paste-ui-final.log`。其中包含 8 项完整输入交互测试。集成测试之后的实现修正仅涉及 TUI，故集成结果与最终 TUI 结果分开记录。
- 最终 `bun run typecheck`、`bun run lint`、`bun run build`、`git diff --check` 均通过。日志 `/tmp/hhu-paste-typecheck.log`、`/tmp/hhu-paste-lint.log`、`/tmp/hhu-paste-build.log`。
- `python3 tests/e2e/slash-terminal.py /home/clj/.local/bin/bun /home/clj/HarnessHub/HarnessHub/dist/cli/hhu.js` 用最终构建通过。证据 `/tmp/hhu-slash-pty-tos10jvm/evidence.json`，日志 `/tmp/hhu-paste-pty-final.log`。验证从 Home 启动、终端 bracketed paste 显示标签、SQLite 草稿原文、F2 展开、清空、折叠内容显式发送一次且 ACP `session/prompt` 完全一致，以及退出后 Daemon/Session 保活。
- 早先输入高度修复的全量测试在沙箱内受 `spawnSync ... EPERM` 阻塞，未算通过；本轮已申请沙箱外隔离测试权限，不访问默认用户数据库。

## 限制与人工验收

- Windows Terminal / VS Code WSL 的物理粘贴、F2 和系统 IME 本轮未验证。真实 Agent 未用于本功能测试；Mock 结果不代表真实 ACP 提供方验收。
- 仅对终端识别为粘贴的事件折叠，不将连续键入猜测成粘贴。重新打开草稿时显示原文，这是不持久化 UI 快照的明确行为。
- 在两种目标终端粘贴 6 行中文/Emoji 以及 1000 字符单行内容，确认出现方括号块；继续键入前后文，再用 F2 或点击展开编辑。检查短粘贴不折叠、普通长文本自动增高。
- 在块尾 Backspace 删除后撤销，确认原文仍在；切换会话再返回，确认原文草稿完整且未误发送。显式 Enter 后对照完整消息，运行中 Tab 排队也应保存完整原文。
- 未更新全局 `hhu` 安装、未停止默认 Daemon、未提交或推送 Git。构建产物位于 `dist/cli/hhu.js`；全局升级仍应使用既有安全安装流程。
