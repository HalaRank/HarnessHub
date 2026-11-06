# Phase 6：Agent / 模型常驻与 Ctrl+H

日期：2026-11-05。当前阶段的定向交互修正，不进入下一阶段。

## 行为

- Chat / Changes 顶部将当前 Agent、模型、运行状态分为独立行；Agent / 模型可换行，不随聊天滚动，也不被长状态或交接信息挤掉。30 行终端的空聊天保留至少 18 行历史区。
- 模型继续只读取 ACP 持久化能力快照，配置更新后刷新，重新打开 TUI 从已有 Session 恢复显示。无会话显示 `not initialized`，协议未提供模型则显示 `not exposed by ACP`，不读取原生配置。
- `Ctrl+H` 循环选择下一个 Harness，在输入、聊天历史、Changes 和普通导航状态可用；顶层弹窗保留键盘所有权。输入焦点和草稿保留，固定键位不能被其他动作覆盖。
- 待切换时当前 Agent / 模型仍对应实际源执行会话，目标单独显示 `PENDING_SWITCH`；目标进入 DELIVERING 后显示目标会话。只选择不创建原生会话、不调用 Prompt，仍在首条目标消息提交时启动既有 Handoff。
- 同时处理 Kitty `Ctrl+H` 和传统 BS (`0x08`)；DEL (`0x7f`) 仍删除字符。若物理 Backspace 也发送 BS，终端无法区分两者，需将其映射为 DEL 或启用可区分按键的协议。

## 文件

- `apps/tui/src/agent-pane.tsx`：独立 Agent / 模型常驻行、状态与交接显示。
- `apps/tui/src/index.tsx`：在编辑器处理前路由 Ctrl+H，保留弹窗优先级，增加快捷键提示。
- `apps/tui/src/shortcuts.ts`、`packages/shared/src/session-state.ts`：固定键位与传统终端编码。
- `tests/e2e/codex-inputs.test.tsx`、`shortcuts.test.ts`：输入/历史/Changes/弹窗、模型更新、80/32 列、草稿恢复、零 Prompt / 零额外 Session 等回归。
- `tests/e2e/tui.test.tsx`、`phase4.test.tsx`：更新旧状态栏断言，检查三行状态区顺序、历史区高度及输入不重叠。
- `tests/e2e/harness-terminal.py`：可重复运行的隔离 Linux PTY 验证。
- README、架构、操作指南、本记录及 Phase 6 索引同步。

无数据库迁移、依赖变更或原生 Agent 配置修改。

## 验证

执行：

```bash
bun run typecheck
bun run lint
bun run build
bun test tests/e2e/shortcuts.test.ts tests/e2e/codex-inputs.test.tsx tests/e2e/phase5.test.tsx
umask 022
bun run test
python3 tests/e2e/harness-terminal.py /home/clj/.local/bin/bun /home/clj/HarnessHub/HarnessHub/dist/cli/hhu.js
git diff --check
```

- 类型检查、lint、构建通过。定向 11 项 / 388 断言通过。
- 完整入口的 Node 集成 **96/96** 通过；该轮 UI **90/92**，两项仍要求旧单行状态栏的分隔符和历史高度。日志 `/tmp/hhu-harness-model-full-test.log`。按新布局更新断言并补充行高、顺序及不重叠检查后，使用 `scripts/test.ts` 中同一 12 文件列表重跑全部 UI，**92/92、1191 断言通过**，日志 `/tmp/hhu-harness-model-ui-final.log`。合计 188 项通过，不将较早聚合命令的非零退出说成单次全绿。
- Linux PTY 实测通过，证据 `/tmp/hhu-harness-pty-ld6sgycx/evidence.json` 和同目录两份 `terminal-*.bin`。真实构建的 CLI 在隔离 XDG 中使用 Mock ACP，验证 BS / Kitty Ctrl+H、DEL 删除、草稿保留、退出后重新打开显示、单 Session / 零 Prompt / 零 Handoff，Daemon 仍存活；最终正常停机。
- 故障记录：沙箱阻止测试 Daemon 启动，获得批准后在沙箱外隔离目录执行。首次 PTY 的 ANSI 增量文本匹配漏掉未改变字符，改用 resize 请求完整重绘；随后发现 Ctrl+C 按既有定义优先清空草稿，脚本改用 Quit TUI 命令验证保留草稿的退出。最终 PTY 通过，未修改产品退出语义。

## 未验证与手动验收

- Windows Terminal / VS Code WSL 物理键盘 **未验证**：打开会话确认 Agent / 模型常驻，缩窄窗口并滚动；输入草稿后 Ctrl+H 循环切换，确认草稿不变、Backspace 正常删除；在历史、Changes 中重复，弹窗内 Ctrl+H 不切换。发首条目标消息前应仅显示待切换状态。
- 本轮未调用真实远端 Agent；ACP 模型、配置、交接回归使用 Mock，不扩大既有真实 Harness 兼容性结论。模型仍使用原有实际协商与持久化路径。
- 已构建 `dist/cli/hhu.js`。已安装全局 `hhu` **未更新、未验证**，默认 Daemon / 用户数据库未操作；按操作指南安全升级后再验收全局入口。
