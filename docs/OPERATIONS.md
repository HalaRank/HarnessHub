# HarnessHub Linux / WSL2 安装、升级与故障恢复

当前发行源码版本 0.6.1、SQLite schema 6。仅 Linux x64 / WSL2；TUI 用 Bun、Daemon 用 Node。安装不需要 sudo，没有 npm 公开包、在线更新或 Web UI。

## 首次安装

1. 先安装 [Node 24 LTS](https://nodejs.org/en/download)（已测 24.18.0，要求 24.18+ 且 <25）、[Bun 1.4.4](https://bun.sh/docs/installation)、Git 和 util-linux 的 `flock`。全量开发测试另需 Python 3。原生 SQLite 绑定没有可用预构建时，需要本机 C/C++ 构建工具。
2. 下载或克隆 HarnessHub 源码，在仓库根目录执行：

```bash
bun install --frozen-lockfile
bun run install:local
export PATH="$HOME/.local/bin:$PATH"
cd ~
hhu doctor
hhu
```

安装器把启动器原子写入 `~/.local/bin/hhu`，保留源码仓库与 `node_modules`；启动器引用仓库 `dist/releases/<UUID>` 内的完整发布和 Bun 的绝对路径。每次先在 `.staging-<UUID>` 构建全部产物，再切换发布与 launcher；失败或中断不会修改旧 launcher 引用的发布。旧发布和失败 staging 保留供检查，不自动删除，开发用 `bun run build` 也不会覆盖已安装的独立发布。不会自动修改 Shell 配置；需要长期生效时由用户把上述 PATH 添加到自己的 Shell 配置。

无参数 `hhu` 打开全局 Project → Conversation 界面；只有 `hhu .` / `hhu /absolute/path` 才显式注册启动目录。Agent cwd 始终来自 Conversation 的 Project root 或独立 Worktree。

Codex/Claude ACP Adapter 由 lockfile 安装；Grok/OpenCode 需用户另行安装并通过各自原生方式完成登录。HarnessHub 不读取/修改其模型、Key 或 Base URL 配置。`hhu doctor` 检查环境、原生库、Git/flock、Daemon 身份和入口是否存在，**不发送模型 Prompt，也不默认启动 Agent**。有 Conversation 后可显式握手：

```bash
hhu doctor --acp <conversationId> codex
# 等价的显式握手入口：
hhu agent session <conversationId> codex
```

两者仅 `initialize` / `session/new`；返回的配置和能力才是该版本实际暴露的能力。可执行文件存在或握手通过不代表工具、审批、取消、恢复或 Handoff 均已验证。

## 升级与停止

```bash
hhu daemon status
hhu daemon stop
# 只有确实希望取消活动任务时才显式执行：
hhu daemon stop --cancel-active
```

普通 stop 拒绝活动 Turn；`--cancel-active` 请求原生取消、等待最终响应和尾部事件，再合作式释放 Worker。取消超时、源 Worker 清理失败或进程仍未确认结束时，命令报错，Daemon 保留，不能据此假定进程已经退出。TUI 的 Ctrl+C / q 只退出 TUI；不会取消 Agent 或停止 Daemon。

正常停止或显式关闭空闲 Session 也会结束原生上下文并显示 INTERRUPTED；SQLite 历史保留，但下一条消息不会自动携带旧原生内部状态。原生设置超时不是取消证明：配置锁继续阻止新 Turn，迟到响应后才刷新选项；永不返回时可使用已鉴权的 `POST /v1/conversations/:id/session/stop`，仅在用户明确决定后提交 `{ "force": true, "confirmed": true }`。没有自动重试设置或任务。

Worker 关闭分别等待 stdio 和同一 Linux session 中的进程组结束；拒绝退出则保留句柄，不默认 SIGKILL。HarnessHub 不是进程沙箱，Agent 主动通过 setsid 脱离 session 的独立服务仍需按原生工具的生命周期核查。

安全停止后更新源码，再运行 `bun install --frozen-lockfile` 和 `bun run install:local`。安装器在构建及写启动器期间持有同一 Daemon `flock`：活动、启动中、无响应或缺少实例元数据但仍持锁的 Daemon 均会阻止安装；另一终端也不能在此时启动 Daemon。当前版本与旧版本不混连；匹配协议且通过 token/实例身份检查的旧 Daemon 可被正常请求停止。

0.5.0 / 0.6.0 → 0.6.1 不改变 schema 6；schema 5 → 6 使用已有增量迁移。迁移前备份到同目录 `harnesshub.db.backup-*`（0600）。锁定的 Drizzle 在一个事务中执行全部待迁移 SQL；SQL 失败会回滚，旧库与备份均保留，不自动覆盖库文件。高于支持版本的 schema 拒绝打开。备份不会自动清除，请按自己的保留策略妥善管理。

## 导出与隐私

```bash
hhu agent export <conversationId> chat conversation.md
hhu agent export <conversationId> debug conversation-debug.json
```

目的文件必须不存在，创建权限 0600，不覆盖已有文件。省略目的文件则输出到终端，Shell 自行重定向时文件权限由 Shell 的 umask 决定。`chat` 输出 Markdown，合并连续流式文本，保留消息/工具/思考/计划、来源、完整 Handoff；`debug` 另有所有原始 ACP 事件、序号、NativeSession、Turn、审批和用途标记。API 是 `GET /v1/conversations/:id/export?format=chat|debug`，另支持 `readable|raw` 别名。

所有导出、SQLite 和备份都可能含敏感对话、源码、路径或 Agent 自有输出。只对结构化凭据字段脱敏；不会扫描改写普通 Markdown、代码或工具字符串，也不能保证其中没有用户主动提供的秘密。导出不加入 Daemon Token 或 Profile 环境值。默认日志只写固定诊断事件，不输出 Prompt、工具结果或 Worker stderr；每类日志约 1 MiB 轮转，保留 5 个历史文件。

Conversation 归档/恢复只改应用元数据；确认删除会级联清理应用历史和草稿，保留用户源码、Git 分支及 Worktree。Worktree 清理是另一项操作：核对路径/分支，输入 CLEAN，拒绝脏/未跟踪/忽略文件、锁、关联 Conversation 和归属不符；拒绝 assume-unchanged/skip-worktree 等隐藏修改标志；通过 Git move 移入 `worktrees/retained/<UUID>` 并记录 RETAINED，保留文件、Git 登记和分支，不自动物理删除。请先核查外部编辑器/构建进程与完整文件，再自行决定手动移除。Git 移动成功但落库前中断时会显示 ERROR，明确重试 cleanup 可核对保留目录并恢复记录。

## 故障诊断与恢复备份

- `hhu doctor`：检查运行时、库与入口。缺少某个可选 Harness 是 WARN，不会阻止其他 Harness。
- `hhu daemon logs`：查看有限诊断日志。完整协议来源在 Raw Events / Debug、SQLite 或显式 debug 导出中。
- 不可达或版本不匹配时，不向元数据中的 PID 发送信号；先用匹配版本的 hhu 检查。不要删除锁文件来绕过现有进程。
- Daemon 崩溃只恢复 SQLite 历史。活动 Turn 可能为 UNCERTAIN、Session 为 INTERRUPTED、审批过期；不要重放未知结果的任务。先核查原进程与 Changes，必要时显式新建 Conversation。
- OpenCode 全隔离纯文本/取消的失败证据见原独立审计；0.6.1 的真实握手和正常关闭不代表消息/工具/取消已重新通过。详见审计修复记录。

只有在确认 Daemon 与旧 Worker 安全停止、持有同一内核锁时才恢复备份。以下例子保留失败库及 sidecar，不删除原文件；将 backup 改成实际备份的完整路径：

```bash
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/harnesshub"
db="${XDG_DATA_HOME:-$HOME/.local/share}/harnesshub/harnesshub.db"
backup="/absolute/path/to/harnesshub.db.backup-..."
flock --nonblock "$state_dir/daemon.lock" bash -s -- "$db" "$backup" <<'SH'
set -eu
db_file=$1
backup_file=$2
test -f "$backup_file"
suffix=".failed-$(date +%s)-$$"
for file in "$db_file" "$db_file-wal" "$db_file-shm"; do
  if test -e "$file"; then mv --no-clobber -- "$file" "$file$suffix"; fi
done
cp --no-clobber -- "$backup_file" "$db_file"
chmod 600 "$db_file"
SH
hhu daemon start
```

若拿不到锁、存在未确认结束的 Worker，或不确定选哪个备份，先保留现状检查，不能强行覆盖。恢复库不会恢复原生 Agent 内部状态，不会自动重发 Prompt。XDG 变量必须是绝对路径；默认数据目录 0700、数据库/WAL/SHM/备份/实例/日志 0600。
