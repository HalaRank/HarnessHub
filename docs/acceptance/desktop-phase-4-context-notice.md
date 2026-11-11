# Desktop Phase 4 补充验收：会话中断提示

## 范围与实现

按用户截图优化 Desktop 输入框上方的中断 / UNCERTAIN 状态提示，仅调整当前阶段的 Renderer 展示。

- `apps/desktop/src/renderer/Composer.tsx`：将原生上下文断开与执行结果不确定合并成一张提示卡片。默认显示中文状态、历史保留和不自动重发的说明；Worker 退出待确认状态保持可见，详细说明可展开。“使用新原生上下文继续”沿用原确认弹窗及所有禁用条件。
- `apps/desktop/src/renderer/style.css`：提示卡片与输入框保持同宽，使用低饱和暖色、图标和细边框；标题与继续按钮允许换行，减少原整块横幅的留白。
- `docs/acceptance/evidence/desktop-context-notice/`：宽屏、窄屏截图及浏览器交互结果。

不改变 ACP、Daemon、投递 / 恢复状态机、审批或数据库。历史与草稿继续保留，结果不确定时禁止发送，不自动重放消息。

## 验证

- `bun run typecheck`：通过。
- `bun run lint`：通过，173 个文件。
- `bun run desktop:test`：后端 / Desktop 构建、70 项 Desktop 单元测试、19 项 Node 集成测试通过。日志 `/tmp/hhu-context-notice-desktop-regression.log`。
- `git diff --check`：通过。
- 真实 Chromium 加载当前 Composer / CSS，使用隔离 API 替身和草稿：1100px / 390px 视口卡片高度约 100.6px，页面及卡片均无横向溢出；说明默认折叠且可展开；UNCERTAIN 发送按钮禁用；恢复弹窗在用户勾选旧任务已结束前禁用确认，确认后草稿保留，仅产生一次恢复请求，未发送消息。截图已目视检查。

浏览器探针：`LD_LIBRARY_PATH=/home/clj/.local/chromelibs/usr/lib/x86_64-linux-gnu node /tmp/hhu-context-notice-browser-xFcPbi/check.mjs`。该目录包含隔离入口与构建脚本，持久证据见上文 evidence 目录。Desktop 单元测试需从 `apps/desktop` 执行以使用 React tsconfig；从仓库根直接调用测试文件会错误使用 TUI JSX 配置，该次命令失败后已按仓库标准命令通过完整回归。

## 限制与人工验收

本轮 Windows Electron 安装版、真实 Harness 和系统 DPI 缩放效果未验证；浏览器替身不代表已恢复真实任务。未替换安装目录或停止日常 Daemon / Worker。

在 Windows Desktop 打开中断或 UNCERTAIN 会话，检查卡片与输入框对齐、展开说明、缩窄窗口时换行。点击继续入口核对恢复确认流程；只有实际检查并结束旧后台任务后才能勾选确认，消息不应自动重发。
