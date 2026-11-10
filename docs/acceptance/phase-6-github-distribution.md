# Phase 6 专项：GitHub 独立发行安装

日期：2026-11-10，用户授权将 `hhu` 改为可从 GitHub Releases 下载安装，无需源码仓库。版本维持 0.6.2。本任务不发布远端 Release，不进入其他产品阶段。

## 实现与边界

- `scripts/linux-release.ts`、`linux-release-lib.ts`：在仓库外全新 staging 中冻结安装生产依赖，按实际依赖关系复制运行闭包及相对链接；保留不同 SDK 版本、原生组件及资源，不复制开发机 node_modules。收集 CLI/Daemon、迁移、固定 Node/Bun、许可及逐文件 manifest，生成 tar.gz、SHA256SUMS.txt、下载脚本。拒绝覆盖已有输出目录。
- `scripts/install.sh`：固定对应 Release 版本；Linux x64/glibc 和系统工具检查；HTTPS 下载或离线包、SHA256 检查、路径预检及私有临时解压。安装脚本作为 Release 独立资产，也包含在安装包中。
- `scripts/install-release.ts`：使用随包 Node，持现有 Daemon 内核 flock，验证全部文件和链接，安装到用户级新版本目录。拒绝替换无关文件、软链接或硬链接；保留旧目录及精确 CLI/Bridge 入口备份。正常异常恢复已替换入口；两入口不宣称具备断电事务性。不停止或强杀活动任务，不执行数据库回退。
- `scripts/verify-linux-release.mjs`、`verify-linux-release-pty.py`：独立 HOME/XDG/最小系统 PATH、真实随包运行时、安装失败及重装、真实 Adapter initialize、Mock ACP 和 Linux PTY 验收。
- `.github/workflows/linux-release.yml`：Ubuntu 22.04 x64，固定工具链，类型检查/lint/全部测试/打包/安装验收。手动运行生成 artifact；匹配版本的 Tag 创建 draft Release，发布由维护者最终操作。
- `package.json` 新增 `release:linux`、`release:verify`；README、架构与实施文档、`docs/DISTRIBUTION.md` 记录发行流程及用户授权的范围变化。

现有 `install:local` 不变。最终全局命令仍为 `hhu`，Desktop Bridge 与 CLI 引用同一版本。运行时只为子进程调整 PATH，不更改原生 Agent 配置或用户 Shell。运行数据仍在 XDG 目录，Conversation 的工作区语义不变。没有 npm 发布、在线自动更新或新的审批策略。

## 验证记录

本机为 Linux x64 / WSL 环境、glibc 2.43，Node 24.18.0、Bun 1.4.4。包内 SQLite 3.53.4 实际加载、OpenTUI 原生库实际加载。安装目录含空格和单引号，验证启动器 quoting；运行 PATH 没有宿主 Node、Bun、npm 或 ACP executable。

已运行：

```sh
bun run release:linux
bun run release:linux --outdir dist/linux/releases/0.6.2-final
bun run release:linux --outdir dist/linux/releases/0.6.2-verified
TMPDIR=/home/clj/.cache/hhu-release-testing node scripts/verify-linux-release.mjs dist/linux/releases/0.6.2-final
TMPDIR=/home/clj/.cache/hhu-release-testing bun run test
bun run typecheck
bun run lint
bunx tsc --noEmit
bunx tsc --noEmit -p apps/daemon/tsconfig.json
bunx biome check scripts/linux-release-lib.ts scripts/linux-release.ts scripts/install-release.ts scripts/verify-linux-release.mjs package.json
sh -n scripts/install.sh
git diff --check
```

已完成的 `0.6.2-final` 隔离验收 **10 项通过**：下载校验失败不安装、离线独立安装/doctor、包内篡改拒绝、真实 Codex/Claude ACP initialize、Daemon/Bridge 实例身份及实际随包 Node、运行锁拒绝替换、Mock ACP 工作区/原生拒绝选项/取消/请求去重、真实 Linux PTY 及退出保活、无关文件/悬空链接保护、重装保留旧版本/精确入口/Conversation。

证据：`/home/clj/.cache/hhu-release-testing/hhu-release-verification-Mgwn16/evidence.json`；过程日志 `release-final-check.log` 位于同一 cache 根目录。此轮不发送真实模型 Prompt；真实初始化不能冒充 Agent 完整工作流验收。Mock permission 选择的是 Agent 实际提供的拒绝选项。

完整回归 **119 项 Node 集成测试 + 121 项 TUI 测试通过，0 失败**。工作区同时存在用户其他功能改动；曾出现 `apps/desktop/tests/chat.test.tsx` 重复 JSX `draft` 属性，导致全仓 typecheck/lint 失败，本任务未修改该文件。该文件其他工作完成后重新运行全仓 typecheck/lint 均通过；独立 CLI/Daemon 类型检查、发行代码 lint 和 Shell 语法也通过。

验证过程中修正了验收脚本的两个问题：最小 PATH 漏列 gzip；PTY 测试文件命名 `pty.py` 遮蔽 Python 标准库。真实 Adapter initialize 初版测试过早结束 stdin，进程正常退出但未返回响应；改为保持协议输入直到响应后关闭，Codex 2.5.0、Claude Adapter 0.99.1 均返回真实 ACP v1 能力。没有把这些初次失败记录为通过。

## 用户待验收及限制

1. **未验证**：GitHub 远端 Actions 实际运行、GitHub Release 实际下载/公开发布。需推送代码和匹配版本 Tag，确认 draft 中的 Linux 资产，再发布。此处没有执行 git commit、push、tag 或修改远端 Release。
2. **未验证**：干净 Ubuntu 22.04/24.04 系统镜像、低指令集旧 CPU、物理 Windows Terminal/VS Code WSL 的该安装包体验。CI 目标是 Ubuntu 22.04；本机测试不能代替这些平台证据。
3. **未验证**：该包在全新用户登录后的真实模型消息/工具/审批、Windows Desktop 从全新 WSL 连接。已真实验证两种 Adapter 的无登录 initialize 和 Bridge 协议，不读取或复制用户原生凭据。
4. 完整包约 409 MiB；Codex/Claude 原生传递依赖占主要体积。第三方生产包自身含源码、类型文件、资源时保留，不等同于携带 HarnessHub 源码 checkout。
5. 升级前须安全停止 Daemon；不存在自动升级或自动数据回退。旧目录、构建 staging 和验证环境保留供检查，不自动删除用户历史或项目。
6. manifest 标记当前构建源码存在未提交改动，产物用于本地验收。正式 Tag 发布需以最终检查过的仓库版本重新构建。

## 最终结果补录

最终产物：`dist/linux/releases/0.6.2-verified/harnesshub-0.6.2-linux-x64.tar.gz`，428,435,414 bytes（约 409 MiB）。SHA256：

```text
1e6dcc7653a399415fc3059facb5dc8e5e199ffef64194898e881cc8ed84203e
```

同目录包含 `install.sh`、`release-manifest.json` 和 `SHA256SUMS.txt`。此包包含最终的信号退出/私有临时目录清理逻辑；安装后不再依赖下载解压目录。正式发布仍需从最终提交构建。

实际执行 `TMPDIR=/home/clj/.cache/hhu-release-testing node scripts/verify-linux-release.mjs dist/linux/releases/0.6.2-verified`，**退出 0，11 项全部通过**。在上述 10 项基础上新增“无 instance.json 但内核锁仍被占用”保护，验证启动/无响应期间不会误装。最终安装验收环境为 `/home/clj/.cache/hhu-release-testing/hhu-release-verification-yLw30o`，其中测试 Daemon 已正常停止；未操作用户默认 Daemon、默认数据库或全局启动器。

最终全仓 `bun run typecheck`、`bun run lint`、`bun run test` 均退出 0；完整测试合计 **240 项通过**。`sh -n scripts/install.sh` 和 `git diff --check` 通过。构建、测试和安装证据已保存至 [evidence/github-distribution](evidence/github-distribution/)，包含精确安装结果、产物校验值及完整回归日志。
