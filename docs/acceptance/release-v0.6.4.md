# HarnessHub v0.6.4 发布验收

日期：2026-11-11。用户要求拉取最新代码并发布最新版安装包；范围为现有 Desktop Phase 4 / TUI Phase 6 的版本发布。

## 代码与版本

- `git fetch origin --tags`、`git pull --ff-only` 已执行；远端 main 与本地基线一致，为 `29c09e2`。
- 根 package.json、全部 workspace、shared VERSION 和 bun.lock 统一为 0.6.4；协议仍为 1，SQLite migrations 为 9。依赖版本未变，本次不新增迁移。
- 包含 v0.6.3 之后的 Desktop 图片选择与粘贴、项目选择清除、下拉菜单样式、会话中断提示、运行时显式恢复与排队输入保留，以及 TUI 侧栏尺寸修复。
- README、DESKTOP 和 DISTRIBUTION 更新版本与安装说明。Windows Desktop、Bridge 和 Daemon 仍须精确版本匹配。
- 两个已有验收证据文件仅存在用户原有的权限位变更，本轮保留，不纳入版本发布变更。

## 本地检查

日志和校验结果见 [evidence/release-v0.6.4](evidence/release-v0.6.4/)，完整现场保存在 `/tmp/hhu-release-v0.6.4/`。
入库日志统一为 LF 并移除行末空白；测试内容与结果保留，原始下载日志另存上述现场目录。

- `bun install --ignore-scripts`、`bun install --frozen-lockfile --ignore-scripts`、`bun run version:check`：通过。
- `bun run typecheck`、`bun run lint`、`git diff --check`：通过；lint 检查 173 个文件。
- `TMPDIR=/home/clj/.cache/hhu-release-v0.6.4/tmp bun run desktop:test`：退出 0，实际构建后端和 Desktop，70 项 Desktop 单元测试与 19 项 Node 集成测试通过，0 失败。
- `bun run test`：后端 / CLI 构建成功，Node 集成测试初轮 121/122 通过。唯一失败为真实 PTY 验收按连续文本匹配标题，但增量重绘保留了屏幕上的部分字符，输出流并不含完整标题。`tests/e2e/terminal.py` 改为等待同一项目注册表单的完整说明文案，保留 Tab 补全、重复注册、双客户端保活与退出断言；未改产品代码。
- `HARNESSHUB_BUN="$(command -v bun)" node --test tests/integration/phase1.test.mjs`：修正后 11/11 通过，含原失败 PTY 项。其余 111 项 Node 集成测试已在初轮通过。
- 标准测试脚本中的完整 TUI 测试清单单独执行：125/125 通过，0 失败。合计 122 项 Node、125 项 TUI、70 项 Desktop 单元与 19 项 Desktop 集成测试已分别验证通过。远端发布流程随后完整执行 `bun run test`，122 项 Node 与 125 项 TUI 全部通过。

## 远端构建与公开发布

2026-11-11 09:34:56 UTC，已公开发布 [HarnessHub v0.6.4](https://github.com/HalaRank/HarnessHub/releases/tag/v0.6.4)，共 8 个资产，非 draft / prerelease。匿名访问 `releases/latest` 返回 HTTP 200 并解析到此版本。

- 不可变 Tag 提交：`79106a5667faa47bbcaa3df2887abe3de0a6c689`。Linux manifest 的 sourceCommit 一致，sourceDirty=false，lockfile SHA256 与 Tag 内容一致；随包 Node 24.18.0 / Bun 1.4.4。
- [Actions 42994846240](https://github.com/HalaRank/HarnessHub/actions/runs/42994846240)：Linux、Windows 和 draft 三个 job 全部 success。Linux typecheck、lint、完整回归、独立包构建及 11 项隔离安装检查通过；Windows 4 项发布边界测试、NSIS/ZIP 构建及真实安装器检查通过；两平台汇总实际读取资产并执行 SHA256 校验通过。
- Linux 隔离检查包含无系统 Node/Bun 的离线安装、篡改拒绝、真实 Codex/Claude 无 Prompt initialize、运行锁、Bridge 身份、Mock ACP 工作区/权限/取消/去重、真实 PTY 保活、无关入口保护与重装保留历史，不代表真实登录模型工作流通过。
- Windows runner 验证 ZIP 和 NSIS 的载荷一致、安装/实际窗口启动、测试客户端异常退出与重启、重装保留数据、卸载及再次安装。未提供旧版本夹具，本轮升级检查为同版本重装；runner 不具备 WSL，不代表完整 Windows → WSL 工作流通过。
- 发布前通过认证下载 5 份元数据，核对元数据自身 SHA256、两平台校验条目与 GitHub 资产 digest、Windows manifest 的大小/哈希。发布后匿名完整下载 install.sh、Linux manifest、两平台 SHA256 文件及 Windows manifest，全部 HTTP 200、大小和哈希一致，见 `public-verification.json`。
- 本机未额外完整下载或安装 3 个大包。大包完整性依据 CI 对实际文件的汇总校验、平台安装验收及 GitHub digest 交叉核对，不将元数据下载视为大包全量下载。

| 资产 | 字节数 | SHA256 |
| --- | ---: | --- |
| Windows setup.exe | 110769370 | `eec96ab775e7f30200932a0f9e58bf37f10ecc6c8deb89d15401d24adb9519ab` |
| Windows ZIP | 153524792 | `08b1356b4d082a1b84648681e074783021a953903a23b86511c1533aa29e6f15` |
| Linux tar.gz | 428447736 | `bc5fed3165f1ac3237692747b289f60cf512184fc345eaeb83878fa9f08d99e9` |

后续 main 的发布证据和下载文档补录不改变此 Tag 或已发布资产。

## 验收边界

真实 Harness 图片识别、物理 IME、多显示器 DPI 和完整 Windows → WSL → 真实模型工作流沿用各专项记录的未验证边界，不以 Mock 或 CI 安装器结果代替。

本轮未替换用户本机安装、停止日常 Daemon 或修改原生 Agent 配置。升级时需关闭 Windows 客户端，完成或明确取消后台任务后安全停止 Daemon，同时安装同版 Windows App 与 WSL 后端。
