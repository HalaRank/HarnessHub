# HarnessHub v0.6.4 发布验收

日期：2026-11-11。用户要求拉取最新代码并发布最新版安装包；范围为现有 Desktop Phase 4 / TUI Phase 6 的版本发布。

## 代码与版本

- `git fetch origin --tags`、`git pull --ff-only` 已执行；远端 main 与本地基线一致，为 `29c09e2`。
- 根 package.json、全部 workspace、shared VERSION 和 bun.lock 统一为 0.6.4；协议仍为 1，SQLite migrations 为 9。依赖版本未变，本次不新增迁移。
- 包含 v0.6.3 之后的 Desktop 图片选择与粘贴、项目选择清除、下拉菜单样式、会话中断提示、运行时显式恢复与排队输入保留，以及 TUI 侧栏尺寸修复。
- README、DESKTOP 和 DISTRIBUTION 更新版本与安装说明。Windows Desktop、Bridge 和 Daemon 仍须精确版本匹配。
- 两个已有验收证据文件仅存在用户原有的权限位变更，本轮保留，不纳入版本发布变更。

## 本地检查

完整日志保存在 `/tmp/hhu-release-v0.6.4/`。

- `bun install --ignore-scripts`、`bun install --frozen-lockfile --ignore-scripts`、`bun run version:check`：通过。
- `bun run typecheck`、`bun run lint`、`git diff --check`：通过；lint 检查 173 个文件。
- `TMPDIR=/home/clj/.cache/hhu-release-v0.6.4/tmp bun run desktop:test`：退出 0，实际构建后端和 Desktop，70 项 Desktop 单元测试与 19 项 Node 集成测试通过，0 失败。
- `bun run test`：后端 / CLI 构建成功，Node 集成测试初轮 121/122 通过。唯一失败为真实 PTY 验收按连续文本匹配标题，但增量重绘保留了屏幕上的部分字符，输出流并不含完整标题。`tests/e2e/terminal.py` 改为等待同一项目注册表单的完整说明文案，保留 Tab 补全、重复注册、双客户端保活与退出断言；未改产品代码。
- `HARNESSHUB_BUN="$(command -v bun)" node --test tests/integration/phase1.test.mjs`：修正后 11/11 通过，含原失败 PTY 项。其余 111 项 Node 集成测试已在初轮通过。
- 标准测试脚本中的完整 TUI 测试清单单独执行：125/125 通过，0 失败。合计 122 项 Node、125 项 TUI、70 项 Desktop 单元与 19 项 Desktop 集成测试已分别验证通过；远端发布流程仍须完整执行 `bun run test`。

## 发布状态与验收边界

尚未创建发布提交、Tag 或 v0.6.4 Release。远端目前最新公开版仍为 v0.6.3；文档中 v0.6.4 直链须在公开发布后使用。

发布流程沿用 `.github/workflows/linux-release.yml`：从不可变版本 Tag 构建 Linux 与 Windows，执行隔离安装和 Windows 安装器验证，两平台汇总校验通过后创建 draft，再核对资产并公开发布。

本轮尚未执行 v0.6.4 Windows 安装器、Linux 独立包隔离安装或公开下载验证。发布前须补录 Actions 地址、Tag 提交、平台结果、资产哈希及公开访问结果。

真实 Harness 图片识别、物理 IME、多显示器 DPI 和完整 Windows → WSL → 真实模型工作流沿用各专项记录的未验证边界，不以 Mock 或 CI 安装器结果代替。

本轮未替换用户本机安装、停止日常 Daemon 或修改原生 Agent 配置。升级时需关闭 Windows 客户端，完成或明确取消后台任务后安全停止 Daemon，同时安装同版 Windows App 与 WSL 后端。
