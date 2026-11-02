# Phase 6 补充：项目 / 会话列表留白（2026-11-02）

## 范围与实现

- 当前阶段的 TUI 视觉微调，不进入新阶段，不修改 ACP、Daemon、历史数据或项目 / 会话名称。
- `apps/tui/src/project-tree.tsx`：会话行占两格、项目行占三格，内容垂直居中，两侧各留一格；项目名保留加粗，颜色由 `#80cbc4` 提亮为 `#b2dfdb`。选择、悬停背景与原有交互不变。
- 锁定的 OpenTUI 文本组件没有局部 `fontSize` / `letterSpacing` 属性。本次以行间留白、项目标题的空间及颜色强调改善层级，**不宣称实现了实际字号放大或字符间距调整**，也不向名称插入空格。
- `tests/e2e/mouse-sidebar.test.tsx`：新增中英文名称在 150 / 100 列下的真实 renderer 回归，检查行高、标题粗体、名称原文、箭头 / 操作按钮的位置，以及布局调整后的会话切换和折叠。

## 验证结果

- `bun run build`、`bun run typecheck`、`git diff --check` 通过。
- `bunx --no-install biome check apps/tui/src/project-tree.tsx tests/e2e/mouse-sidebar.test.tsx` 通过。
- `bun test tests/e2e/mouse-sidebar.test.tsx`：**9/9 通过，80 个断言**。覆盖新增布局、鼠标选择、折叠、大列表滚动、草稿、后台 Worker、重命名同步及归档 / 删除确认。使用临时 XDG、真实 Node Daemon、SQLite、OpenTUI/Solid renderer 与 Mock ACP；证据目录 `/tmp/hhu-mouse-sidebar-Gh31EN`。
- 沙箱内首次启动测试 Daemon 失败；授权沙箱外运行隔离测试。新增断言初轮不兼容中英文混排的 span 分段及偶数行高的垂直居中取整，修正断言后完整侧栏回归通过，没有改动原有断言。
- 全仓 `bun run lint` 未通过：并行修改的 `tests/e2e/agent-output.test.tsx` 存在格式问题；本轮不修改该文件。未运行完整集成 / UI 套件，不宣称整个并行工作区全部通过。

## 未验证与人工验收

- Windows Terminal / VS Code WSL 物理终端视觉效果**未验证**。打开项目树，检查项目标题比会话更醒目，列表间隔是否合适；缩窄侧栏，核对名称截断、滚动、折叠箭头和会话菜单仍可操作。
- 未覆盖全局安装、默认数据库或 Agent 原生配置。构建不会替换已安装的独立 `hhu`；全局验收前须由用户按 `docs/OPERATIONS.md` 安全升级。
- 真实 ACP 和既有 MVP 人工验收限制保持不变。
