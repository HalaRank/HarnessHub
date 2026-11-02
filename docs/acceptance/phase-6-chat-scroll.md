# 阶段 6 补充验收：消息滚动与返回最新消息

日期：2026-11-02。只调整当前 MVP 的消息区交互，未进入新阶段。

## 实现与文件

- `apps/tui/src/native-events.tsx`：消息区滚轮使用固定 5 倍步长，每个标准滚轮事件上下移动五行；到达边界时截断。Esc 与原有 End 共用返回最新页、布局完成后滚到底部的逻辑，并恢复新消息跟随。帮助栏显示 Esc/End。
- `apps/tui/src/index.tsx`：无弹窗时不再提前吞掉 Esc，交由消息区处理；已有弹窗继续优先消费关闭按键。
- `apps/tui/src/agent-pane.tsx`：输入框内 Esc 退出编辑时同时请求返回最新消息，保留未发送草稿；斜杠候选优先关闭，不同时跳转。
- `tests/e2e/chat-scroll.test.tsx`：纯 OpenTUI renderer 回归，覆盖上下五行、边界、跨历史分页返回、后续消息跟随、弹窗优先与编辑器跳转请求。
- `tests/e2e/phase4.test.tsx`：补充 App + Mock Daemon 的 Esc 路由、输入框退出、草稿保留及命令面板优先关闭回归。
- `scripts/test.ts`：将新增纯渲染测试纳入标准 runner。

不修改 ACP、审批决策、Daemon 生命周期、SQLite 或消息原文；不修改侧栏、Changes、原文弹窗等其他区域的滚轮步长。保留工作区内已有与并行编辑的样式、鼠标和快捷键改动。

## 执行结果

- `bun test tests/e2e/chat-scroll.test.tsx tests/e2e/agent-output.test.tsx`：最终重跑 **6/6 通过，101 个断言**，其中本次新增滚动测试 3 项、17 个断言。
- `bun test tests/e2e/phase4.test.tsx --test-name-pattern 'App Esc returns'`：App 专项通过，6 个断言；隔离 Mock Daemon 位于临时目录，不访问默认用户数据库。沙箱内无法启动 Daemon，授权沙箱外运行后完成验证。
- 最终基于当前源码执行 `bun test tests/e2e/phase4.test.tsx --test-name-pattern 'App Esc returns|long history has bounded|a new history page'`：**3/3 通过，20 个断言**；证据目录 `/tmp/hhu-phase4-ui-j66y6Z`。
- `bun run typecheck`、`bun run build`、`git diff --check`：通过。
- `bun run lint`：最终通过，87 个文件。此前检查曾报告并行编辑新增的 `agent-pane.tsx` 静态元素鼠标事件、文案格式及 `native-events.tsx` / `changes-pane.tsx` 导入顺序问题；保留其他操作中的修改，待其更新后最终复查通过。
- 扩大执行 `bun test tests/e2e/phase4.test.tsx tests/e2e/slash-commands.test.tsx tests/e2e/mouse-sidebar.test.tsx`：**36 通过、20 失败、8 个额外错误**。本次 App Esc、长历史滚动/恢复和跨页锁定用例通过；其余包括初始编辑焦点、Ctrl+C、鼠标选择和快捷键提示等待失败。运行期间同一源码及测试持续被并行编辑，不能把该结果视为稳定合并工作区全量通过，也不在本任务中修复无关交互。
- 开发中修正测试对 Esc 解析及异步 Markdown/初始布局的等待；并行快捷键切换期间出现过原文弹窗与样式测试失败，最终上述纯渲染六项重跑通过。

## 未验证与手动步骤

提交前另以已提交基线加本次八个文件的独立补丁，在 `/tmp/hhu-scroll-commit-p2y1Yu/tree` 验证，排除其他未提交改动：typecheck、lint、build 通过，纯滚动测试 3/3（17 个断言）、App/长历史/跨页回归 3/3（20 个断言）通过；Mock 证据 `/tmp/hhu-phase4-ui-vMo2qT`。独立提交保留基线原有快捷键，工作区尚未提交的快捷键适配不混入本次提交。

- 本轮未跑完整后端集成套件，未调用真实 ACP Agent，Windows Terminal / VS Code WSL 物理终端**未验证**；不扩大 MVP 最终验收结论。
- 用本构建打开长会话：滚轮单格上下滚动应为五行；翻到旧消息后按 Esc，应回到最新页底部，后续消息继续跟随。
- 输入未发送草稿并滚动，再按 Esc：退出编辑、返回底部且草稿保留；有斜杠候选、原文或命令面板时，第一次 Esc 只关闭对应弹窗。
- 未覆盖全局安装、未停止用户默认 Daemon。全局 `hhu` 需按 `docs/OPERATIONS.md` 安全升级流程重新安装后验收。
