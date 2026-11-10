# HarnessHub v0.6.3 发布验收

日期：2026-11-10。用户明确要求发布本轮 Windows App 与 CLI 修改；范围为当前 Desktop Phase 4 / TUI Phase 6 的版本发布，不进入新产品阶段。

## 版本与变更

- 根 package.json、所有 workspace、shared VERSION 和 bun.lock 统一为 0.6.3，协议仍为 1，SQLite migrations 8。本轮不新增迁移。
- Windows：会话工作面板与应用设置分离、常驻可调宽侧栏、独立归档窗口、共享目录分支选择、紧凑 WSL 环境摘要和跳至最新消息箭头。
- CLI/TUI：恢复分栏布局并改进 Commands 菜单、搜索与浮层。
- README、DESKTOP 和 DISTRIBUTION 更新当前版本及安装/兼容信息。历史版本的验收记录保留。
- 构建使用不可变版本 Tag；不覆盖 v0.6.2 及其公开资产。Windows 与 Linux/WSL 同步构建，保持精确版本匹配和无自动更新。

## 本轮检查

日志与校验结果见 [evidence/release-v0.6.3](evidence/release-v0.6.3/)，完整现场保存在 `/tmp/hhu-release-v0.6.3/`。

- `bun scripts/version.ts 0.6.3`、`bun install --ignore-scripts`、`bun install --frozen-lockfile --ignore-scripts`、`bun run version:check`：通过，依赖版本未变。
- `bun run typecheck`、`bun run lint`、`git diff --check`：通过。
- `bun run test`：退出 0，实际构建 CLI/Daemon，119 个 Node 集成与 122 个 TUI 测试通过，0 失败。
- `TMPDIR=/home/clj/.cache/hhu-release-v0.6.3/tmp bun run desktop:test`：最终退出 0，实际构建后端/Desktop，61 个 Desktop 单元与 16 个 Node 集成测试通过，0 失败。合计 318 项通过。
- 初轮 Desktop 集成 15/16 通过：共享分支活动保护测试错误使用 Mock 未定义的 `slow` 指令，Agent 实际立即完成，检查时已不再活动。`tests/integration/desktop.test.mjs` 的该项及关闭客户端保活项改为 Mock 明确定义的 `wait`，等待本 Turn 的 `started` 事件后才继续；保活项额外断言关闭后仍 RUNNING、取消后为 CANCELLED。完整 Desktop 回归重跑通过，未修改产品运行逻辑。

## 远端构建与公开发布

2026-11-10 10:03:31 UTC，已公开发布 [HarnessHub v0.6.3](https://github.com/HalaRank/HarnessHub/releases/tag/v0.6.3)，共 8 个资产，非 draft / prerelease。匿名访问 `releases/latest` 返回 HTTP 200 并解析到此版本。

- 不可变 Tag 提交：`c1d13d064411d183c6baaead2ea587e81c931215`。Linux manifest 实读 `sourceCommit` 一致、`sourceDirty=false`，lockfile SHA256 与 Tag 内容一致；随包 Node 24.18.0 / Bun 1.4.4。
- [Actions 42794539843](https://github.com/HalaRank/HarnessHub/actions/runs/42794539843)：Linux、Windows 和 draft 三个 job 全部 success。Linux 执行 typecheck/lint/119 个 Node 集成与 122 个 TUI 测试、独立包构建及 11 项隔离安装验收；Windows 执行 4 项发布边界测试、NSIS/ZIP 构建、实际安装/启动/重装/异常退出/卸载保留验证。两平台汇总校验通过。
- 11 项 Linux 安装验收含无系统 Node/Bun 的离线安装、包内篡改拒绝、真实 Codex/Claude 无 Prompt initialize、运行锁、Bridge 身份、Mock ACP 工作区/权限/取消/去重、真实 PTY 保活、无关入口保护与重装保留历史；不代表真实登录模型工作流通过。
- 发布前下载两个平台校验文件和 manifest、Linux install.sh，核对元数据本身 SHA256、全部条目与 GitHub 资产 digest 和 Windows manifest 大小/哈希。发布后匿名完整下载 install.sh、两平台 SHA256 文件及 Windows manifest，全部 HTTP 200、哈希一致，见 `public-verification.json`。
- 本轮未完成公开 Windows 大安装包的额外全量下载：可选下载速度持续降低后停止，部分文件仅保存在仓库外 `.partial`；未执行。完整安装包的 SHA256 由 CI 汇总实际读取校验，并与 GitHub digest 核对，不把匿名小文件下载冒充大包的全量下载或本机安装。

| 资产 | 字节数 | SHA256 |
| --- | ---: | --- |
| Windows setup.exe | 110767900 | `4838eca0d3a4f4dfd6d6234285b79aec8330df2b43c8524e434b7f8f670ff537` |
| Windows ZIP | 153520017 | `82c892bf2442f37196d48817902642ec63b30f3f40d7511f954b8238d49a0385` |
| Linux tar.gz | 428449440 | `9913ecd2c7e45f3ed50c6c382f3f967242b6bca78def5e553eff88d64d1b7aeb` |

后续 main 的发布证据/下载文档补录不改变此 Tag 或已发布资产。

## 验收边界

CI Windows runner 不具备 WSL，安装器验证不能冒充完整 Windows → WSL → 真实 Harness 验收。既有专项 Windows/WSL Mock ACP、Git 与交互证据见对应 Desktop 补充验收；本次不追认物理 IME、多显示器 DPI、全新用户真实模型登录与完整工作流已通过。

本轮发布不替换用户本机安装，不停止日常 Daemon，不修改原生 Agent 配置、业务数据或用户项目。Windows 包仍 unsigned；用户升级需同时安装同一 Release 的 Windows App 和 WSL 后端。
