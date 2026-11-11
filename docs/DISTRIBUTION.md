# HarnessHub GitHub 发行包

Windows x64 安装器和 Portable ZIP 与 Linux 后端使用同一个 GitHub Release。Windows 下载、校验、安装及 WSL 准备见 [Windows Desktop 指南](DESKTOP.md#从-github-下载)；Windows 使用 `windows-x64-SHA256SUMS.txt`，下文的 `SHA256SUMS.txt` 属于 Linux 包。

Linux x64 / WSL2 发行包包含编译后的 CLI/TUI、Node Daemon、数据库迁移、Node 24.18.0、Bun 1.4.4，以及锁定的生产依赖。无需源码仓库、npm、系统 Node/Bun 或本地编译。

首批支持基线为 Ubuntu 22.04/24.04 x64（含 WSL2）、glibc；不提供 Alpine/musl、ARM64 或 macOS 包。标准 Bun x64 构建需要相应 CPU 指令集；旧 CPU 尚未验证。系统需要 Git、util-linux 的 flock/getconf、GNU tar、coreutils；在线安装还需要 curl 和 CA 证书。

## 从 GitHub 安装

以下地址在维护者发布包含 Linux 资产的 Release 后生效；CI draft 或 artifact 不会成为 latest。

```sh
curl -fsSL https://github.com/HalaRank/HarnessHub/releases/latest/download/install.sh -o /tmp/hhu-install.sh
sh /tmp/hhu-install.sh
export PATH="$HOME/.local/bin:$PATH"
hhu doctor
hhu
```

安装脚本固定到它所属的版本，下载同版本安装包和 SHA256SUMS.txt，校验后再执行随包安装器。SHA256 检查完整性，不代替发布来源认证；仅从该仓库的 Release 获取脚本。脚本不使用 sudo，也不自动修改 shell 配置。

指定版本时将 `latest/download` 替换为 `download/v<版本>`。离线安装下载同版本的 `install.sh`、`harnesshub-<版本>-linux-x64.tar.gz` 和 `SHA256SUMS.txt` 到同一目录，然后执行：

```sh
sh ./install.sh --archive ./harnesshub-<版本>-linux-x64.tar.gz
```

也可以先自行校验并解压，再执行包内 `sh install.sh`。不要通过 sudo 安装。`bin/hhu` 可在已解压目录直接使用。

## 内容及目录

```text
harnesshub-<版本>-linux-x64/
  bin/hhu, bin/desktop-bridge       便携入口
  runtime/node, runtime/bun         固定版本运行时
  dist/cli/hhu.js                   已编译 CLI + TUI
  dist/daemon/index.js, migrations/ 后台服务及数据库迁移
  node_modules/                    运行依赖、原生库、资源及上游许可文件
  lib/install.js, install.sh        安装器及下载入口
  licenses/                        运行时、内联依赖许可及依赖清单
  package.json, release-manifest.json, README.md
```

依赖闭包从全新目录按 bun.lock 冻结安装后提取；不复制开发机的 node_modules、原生 Agent 配置、源码工作区、测试、聊天数据或日志。第三方包自身的源文件及资源按需保留，不能按后缀随意裁剪。OpenTUI Solid/SolidJS 已内联，仅单独保留其许可。Codex/Claude Adapter 的传递依赖包含原生 Agent 组件，因此包体较大；Grok/OpenCode 仍由用户安装。所有登录、模型及 API 配置均由原生 Agent 自行管理。

安装目录为 `~/.local/lib/harnesshub/releases/<版本>-<安装ID>/`；入口为 `~/.local/bin/hhu` 和 `~/.local/lib/harnesshub/desktop-bridge`。启动器使用包内 Bun，并仅为子进程将包内 Node/Bun 加入 PATH。Bridge 保留安装时用户 PATH 和 XDG 路径。Conversation 的 Workspace 不由安装目录或 shell cwd 改写。

## 升级与恢复

1. 完成或明确取消活动任务后，运行 `hhu daemon stop`。
2. 执行新版本安装脚本。安装器持同一个 Daemon flock，拒绝任何仍持锁的运行/启动中实例，不自动停止、强杀或重放任务。
3. 安装至全新目录并校验完整性，再替换启动入口；原版本、数据库、项目与 Worktree 保留。
4. 运行 `hhu doctor`；首次启动继续采用现有数据库迁移前备份和事务迁移机制。

同版本重复安装也创建独立目录，不覆盖旧文件。旧启动器保存在新目录的 `previous-launchers/`，`install-receipt.json` 标明位置。两个入口不是跨文件事务；正常异常会恢复已替换入口，断电中间态需人工核查。恢复程序前须安全停止 Daemon；数据库已迁移时不能保证旧程序可读，新旧 schema 检查仍生效，不自动覆盖数据库回退。不要删除仍被入口引用的发行目录。

Windows Desktop 使用单独的 exe/zip。先在所选 WSL 发行版安装这里的后端，再连接 Desktop；客户端和后端版本必须匹配。Windows 安装器不会自动安装 WSL 后端。

## 维护者构建及发布

```sh
bun install --frozen-lockfile
bun run version:check
bun run typecheck
bun run lint
bun run test
bun run release:linux
bun run release:verify -- dist/linux/releases/<版本>
```

构建使用当前精确匹配版本的 Node/Bun 可执行文件并记录文件哈希；CI 从 setup-node/setup-bun 获取固定版本。许可文件从固定版本上游源码获取。输出目录已存在时拒绝覆盖，可通过 `bun run release:linux --outdir /新的目录` 指定新位置。临时构建目录保留供检查。manifest 记录源 commit、工作区是否有改动、lockfile 哈希、运行时版本、所有文件哈希及包内相对链接。

GitHub Actions 的 `HarnessHub release`（`.github/workflows/linux-release.yml`）支持手动运行生成 Linux 和 Windows artifact；推送与 package.json 一致的 `v<版本>` tag 后，执行 Linux 检查、打包、隔离安装验收，并调用 Windows 工作流构建 NSIS/ZIP、执行安装器验收。两个平台全部成功且资产校验通过后，创建包含所有包的一个 **draft Release**。Windows 的元数据上传为 `windows-x64-SHA256SUMS.txt`、`windows-x64-release-manifest.json`，避免覆盖 Linux 下载器依赖的同名文件；本地构建文件名不变。维护者检查资产及验收记录后再发布；无自动更新，不假定全部人工平台验收已通过。

首次发布时提交待发布代码、推送版本匹配的 Tag（本轮版本 `v0.6.4`），等待上述两个平台完成。在 GitHub Releases 打开 draft，核对 Windows 安装器/ZIP、Linux tar.gz/下载脚本、两个平台校验文件和 manifest，再发布。已有相同 Tag 的 Release 时工作流拒绝重复创建；不覆盖已发布资产。公开发布前，文档中的版本下载地址不可用。

验收脚本使用独立 HOME/XDG、包内运行时及最小 PATH，覆盖校验失败、运行锁、入口覆盖保护、安装/重装、Daemon、SQLite、Bridge、Mock ACP 和 PTY。全新系统、实际 GitHub 下载和物理 Windows 终端的验证须单独记录。

参考：[GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)、[Bun install](https://bun.com/docs/pm/cli/install)、[Bun 系统要求](https://bun.com/docs/installation)、[Node 官方分发](https://nodejs.org/en/download)。具体依赖/native 兼容以锁定版本及发行验收为准。
