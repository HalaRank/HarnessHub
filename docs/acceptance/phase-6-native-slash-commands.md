# Phase 6：原生 Slash 命令与 HHU 管理分离

日期：2026-11-09。现有 TUI 定向修正，不开启新阶段，不调整 ACP Runtime/数据库协议。

## 审查与实现

- 原实现将 `localCommands` 合并进当前 ACP 候选，并将未发布的 `/new`、`/model`、`/quit` 等拦截成 HHU 操作，违背本次用户明确的原生语义。
- `apps/tui/src/agent-pane.tsx` 只使用当前 live NativeSession 的 `sessionCommands`，保留原始名称、描述、参数提示；删除本地执行分支。Tab/Enter 选择只补全，显式发送仍走既有原文、nativeSessionId、requestId 去重及服务端校验。
- 删除 `apps/tui/src/local-commands.ts`；`apps/tui/src/index.tsx` 删除 slash 到 HHU 的别名路由，保留 Commands/按钮/快捷键管理入口，新增 Message Queue 面板入口。空输入 `?` 仍打开 HHU 帮助。
- ACP 未发布的命令不补造、不静默执行 HHU 操作；显式选择普通 Prompt 的确认界面说明它不保证原生执行。切换 Harness、断线、旧 session 等既有过滤规则不变。
- `project-directory.tsx` 的新会话提示改为导航态 `N`；README 与架构记录明确两类入口分离。
- `slash-commands.test.tsx` 新增发布的 `/new`、`/model`、`/quit` 原样出站与未发布同名命令不触发 HHU 的回归；检查补全零 Turn、会话数量不变、退出回调不触发。`codex-inputs.test.tsx` 改用面板管理 queue/settings/Changes；移除把已恢复为新会话快捷键的 Ctrl+N 当作 retired 的旧测试前提。目录提示相关 TUI 测试同步更新。

## 验证记录

- 最终定向 `bun test tests/e2e/slash-commands.test.tsx tests/e2e/codex-inputs.test.tsx --timeout 15000`：**20/20 通过**，日志 `/tmp/hhu-native-slash-targeted-final.log`。
- `bun run build`：通过，最终日志 `/tmp/hhu-native-slash-build-final.log`。
- `bun run typecheck`、`bun run lint`：最终复核通过，日志 `/tmp/hhu-native-slash-typecheck-final.log`、`/tmp/hhu-native-slash-lint-final.log`。本次文件单独 Biome 检查也通过，见 `/tmp/hhu-native-slash-scoped-lint.log`。中途并行 Desktop 文件有格式诊断，未修改其代码；后续全库复核已无诊断。
- 完整 `bun run test`：后端 **100/101 通过**，入口在 `phase6.test.mjs:186` 的权限断言失败后退出，没有自动执行 TUI。日志 `/tmp/hhu-native-slash-full.log`。当前 Shell `umask=0077` 将测试创建时声明的 0644 裁成 0600，测试预期固定 0644；不是本次命令代码引起。单独执行 `umask 022; HARNESSHUB_BUN=/home/clj/.local/bin/bun node --test --test-name-pattern='unsafe SQLite/sidecar symlinks' tests/integration/phase6.test.mjs` **1/1 通过**，日志 `/tmp/hhu-native-slash-permissions-final.log`。未改无关测试或用户 Shell 设置，不宣称完整入口单次通过。
- 单独运行 `bun test tests/e2e --timeout 15000`：**102/103 通过**，日志 `/tmp/hhu-native-slash-ui-final.log`。命令与输入相关用例全部通过；唯一失败为 `phase4.test.tsx` 的窄屏会话头布局断言，历史区实际 19 行、预期至少 20 行。本次未修改该布局逻辑，也未放宽断言；工作区并行输入尺寸修改已保留，布局差异留待对应任务核查。
- Linux PTY：`python3 tests/e2e/slash-terminal.py /home/clj/.local/bin/bun /home/clj/HarnessHub/HarnessHub/dist/cli/hhu.js` 通过。补全 0 Turn，显式发送 1 Turn，Unicode/换行、草稿保留及退出后 Daemon/Session 保活通过；日志 `/tmp/hhu-native-slash-pty.log`，证据 `/tmp/hhu-slash-pty-bvgpnnkl`。使用 Mock ACP，不代表真实模型命令执行。
- 首轮沙箱内 Daemon 无法启动，获准在沙箱外使用隔离临时库复测。开发期曾因测试使用不存在的集合路由、遗留本地 slash 测试及 Ctrl+N 旧前提失败，均修正，旧失败日志不当作通过证据。

## 真实 Codex 与限制

运行 `node scripts/verify-acp-commands.mjs codex`：真实 Codex ACP 2.5.0 成功 initialize/session/new，收到 19 项命令，包含 plan、mcp、skills、status、review、review-branch、review-commit、compact、goal、rename、logout 及 8 项本机 skill 命令；**没有 `/new`**。证据 `/tmp/hhu-real-commands-BKqA14/evidence.json`，摘要 `/tmp/hhu-native-slash-real.log`。仅观察初始化后 2 秒，不推断以后不会发布更新。

探针 `session/prompt=0`、权限请求 0，合作式退出已确认；未读取/修改原生配置，未执行真实命令。首次沙箱内 ACP 连接关闭，沙箱外复核成功，未掩盖首次失败。

因此本次修复了“HHU 冒充原生命令”，但**没有实现或验证 Codex `/new` 的原生 session 重建**：当前适配器未发布该命令，不能用 HHU Conversation 创建或普通 Prompt 假装实现。Mock 仅验证路由，不代表 Codex 真正支持这些测试命令。Windows Terminal / VS Code WSL 物理按键未验证。

工作区存在并行 Desktop、输入尺寸及相关测试修改，保留原样；本记录不将其归为本次实现，不自动推进 Desktop 阶段。

## 用户待验收

1. 选中已初始化 Harness，在聊天输入 `/`，检查仅显示它发布的名称、描述和提示；切换 Harness 后不沿用源命令。
2. 选择一个无害的已发布命令，第一次 Enter 仅补全，再次 Enter 由 Harness 处理；HHU 不生成同名管理操作。
3. 当前 Codex `/new` 不在列表；粘贴后发送只能显示普通 Prompt 确认，取消后保留原文，不创建 HHU 会话。
4. 通过 Commands → New Conversation、HarnessHub ACP settings、Message Queue、Quit TUI 验证 HHU 管理入口独立可用。
