# Phase 6 会话文字与配色层级

日期为 2026-11-09。本次按用户提供的两张 Codex CLI 参考图与一张 HarnessHub 截图，调整当前阶段的会话显示。

## 实现范围

- 会话阅读区使用中性深灰 `#181a1b`，正文使用浅灰 `#d4d4d8`，公开思考、角色标签、工具输出及展开提示使用灰色 `#979a9b`。
- 工具完成时使用绿色圆点，完成状态文字使用灰色。运行、失败及等待审批分别显示青色、红色、黄色标记与状态文字。审批优先于工具已有的完成状态。
- 命令标题使用常规字重，命令名为蓝色，参数为淡红色，引用字符串为浅绿色，操作符为青色。其他原生工具标题使用浅灰加粗。
- 命令着色根据原生 `rawInput.command` 与标题匹配，或 ACP `execute` 类型及命令参数判定。兼容命令字符串、带 Shell 前缀的字符串及数组参数。显示标题始终使用原生标题首行，展开与 Source 保留完整材料。
- Markdown 标题使用浅灰加粗，行内代码使用浅绿色，链接使用蓝色并保留下划线。

命令着色采用轻量词法分段，复杂 Shell 语法可能只获得部分高亮。终端字体由宿主终端决定。配色采用参考图中的层级，并将灰色亮度提高到可读对比度。

## 文件

- `apps/tui/src/ui.tsx` 集中定义会话颜色。
- `apps/tui/src/native-events.tsx` 应用会话底色、角色/正文层级和状态颜色。
- `apps/tui/src/rich-content.tsx` 应用 Markdown、命令标题和工具输出样式。
- `tests/e2e/agent-output.test.tsx` 覆盖状态更新、审批、32 列窄屏、命令分段颜色/字重、命令字符串与数组、公开思考、原文来源、复制和展开交互。
- `tests/e2e/ui-hierarchy.test.tsx` 将会话文字及语法色纳入至少 4.5∶1 的对比度检查。
- `docs/acceptance/phase-6.md` 关联本记录。

## 验证结果

- `bun test tests/e2e/agent-output.test.tsx tests/e2e/ui-hierarchy.test.tsx` 通过，10 项测试、309 个断言。日志为 `/tmp/hhu-chat-colors-targeted.log`。
- `umask 022; bun run test` 完整入口通过，101 项 Node 集成测试、100 项 Bun/Solid 界面测试，零失败、零跳过。界面测试共 1439 个断言，日志为 `/tmp/hhu-chat-colors-full.log`。该入口包含构建与隔离的临时数据目录。
- `bun run typecheck`、`bun run lint`、`bun run build` 与 `git diff --check` 通过。
- 使用真实 OpenTUI 离屏 renderer 检查 112/40 列会话效果。预览来自合成事件，通过实际渲染缓冲区的文字、颜色、字重和列宽生成图片，文件为 `/tmp/hhu-chat-colors-112.png` 与 `/tmp/hhu-chat-colors-40.png`。预览中的工具失败属于合成示例。

## 用户待验收

Windows Terminal / VS Code WSL 的物理终端外观及本轮真实 ACP Agent 输出均未验证。

1. 按 `docs/OPERATIONS.md` 的安全更新流程安装本构建，执行 `hhu` 打开已有工具历史。
2. 检查普通回复、公开思考、命令、成功输出与失败状态之间的颜色和字重层级。
3. 将窗口缩窄后检查标题截断、中文换行和状态可见性。点击工具详情，再通过 Source 查看完整原文。
4. 由用户完成原生审批操作，检查黄色待审批状态，随后检查最终执行状态。
