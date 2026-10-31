# HarnessHub

HarnessHub 是 Linux x64 / WSL2 的本地 TUI。全局命令是 **`hhu`**。

当前只完成阶段 1：Project → Conversation、后台 Daemon 与 SQLite 持久化。**尚无 ACP Agent、消息发送、审批、取消或 Handoff。** 阶段结果见 [阶段 1 验收记录](docs/acceptance/phase-1.md)。

## 安装与运行

使用 Node **24.18.0** 和 Bun **1.4.4**；需要 Linux `flock`、Git。版本与官方参考见 [兼容性记录](docs/COMPATIBILITY.md)。

```bash
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run test
bun run install:local
cd ~
hhu
```

安装器生成 `~/.local/bin/hhu`，不使用 sudo、不修改 Shell 配置。此目录须已在 PATH 中；如缺失，在当前 Shell 执行 `export PATH="$HOME/.local/bin:$PATH"`。安装后的启动器引用当前源码仓库构建产物及 Bun 绝对路径，请保留仓库和 `node_modules`。重新安装前运行 `hhu daemon stop`；安装器在构建前拒绝覆盖正在使用的 Daemon 构建。

```bash
hhu /absolute/project/path   # 注册/打开真实存在的目录
hhu .                       # 显式使用当前位置
hhu doctor
hhu daemon start
hhu daemon status
hhu daemon logs
hhu daemon stop
hhu --version
```

无参数启动不会把 Shell cwd 自动注册为项目。在 TUI 中按 `p` 输入既有项目的 Linux 绝对路径，按 Enter 保存；选中项目后按 `n` 输入会话标题。↑/↓ 浏览项目/会话，Esc 关闭输入框，`q` / Ctrl+C 退出 TUI。一个终端的操作会通过 Daemon 同步至其他客户端。退出 TUI 不停止 Daemon；WSL 实例关闭后不保证后台存活。

## 开发边界

- `apps/cli`：Bun 入口、启停与诊断；`apps/tui`：OpenTUI/Solid。
- `apps/daemon`：纯 Node Hono HTTP/WS，独立 Node 类型检查。
- `packages/shared`：DTO、输入校验、XDG 路径、客户端；`packages/core`：目录校验及项目服务；`packages/storage`：Drizzle schema、迁移和 SQLite 仓储。
- `tests/integration`：真实 Node Daemon、SQLite、HTTP/WS、启停与恢复；`tests/e2e`：Solid 组件通过真实 Daemon 创建项目/会话，以及构建后 CLI 的双 Linux PTY 验证。PTY 测试需要 Python 3。

数据库默认 `~/.local/share/harnesshub/harnesshub.db`，实例锁与凭据默认位于 `~/.local/state/harnesshub/`，日志在其 `logs/`。尊重 XDG_CONFIG_HOME / XDG_DATA_HOME / XDG_STATE_HOME（须为绝对路径），应用目录 0700，数据、凭据和日志 0600。不创建或读取原生 Agent 配置。

已有数据库需要迁移时，先用 SQLite online backup 生成同目录 `harnesshub.db.backup-*`，然后执行 Drizzle migrations；schema 高于当前程序支持版本时拒绝启动。不要在 Daemon 运行时替换数据库或删除锁文件。迁移失败可查看 `hhu daemon logs`，保留原库和备份后人工排查。
