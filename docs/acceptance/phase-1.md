# 阶段 1：工程骨架、CLI 与 Daemon 验收记录

日期：2026-10-30（America/Los_Angeles）。范围仅阶段 1；阶段 2 未实施。

## 结论

阶段 1 工程实现与本机自动化检查通过，可交付人工验收。已建立真实的 `hhu → Bun OpenTUI/Solid → Node Hono Daemon → SQLite` 闭环。没有以假 Agent、假执行状态或预置项目冒充真实连接。Windows Terminal / VS Code WSL 的人工操作尚待用户验收。

## 仓库与环境检查

初始仓库只有 `AGENTS.md`、两份规范文档与 Windows Zone.Identifier 附属文件，Git main 尚无提交，也无现有阶段验收。完整阅读三份规范后实施，未改动核心架构或原始规范。未创建 Git commit。

本机 Ubuntu 26.04 LTS，WSL2，Linux x64，kernel `6.18.33.2-microsoft-standard-WSL2`；Node 24.18.0 已安装，Bun 原先未安装。本次用户级安装 Bun 1.4.4，未修改 Shell 配置或原生 Agent 配置。依赖和官方资料证据见 [兼容性记录](../COMPATIBILITY.md)。

## 实际实现与文件

| 文件/目录 | 完成内容 |
| --- | --- |
| `package.json`, `bun.lock`, `bunfig.toml`, `tsconfig.json`, `biome.json`, `.node-version`, `.bun-version`, `.gitignore` | Bun Workspaces、单锁文件、严格 TS、推荐 lint、运行时锁定、生成物忽略 |
| `apps/cli/src/index.ts`, `lifecycle.ts` | `hhu [path]`、`doctor`、`--version`、`--help`、`daemon start/stop/status/logs`；无参数全局列表；显式路径规范化后注册 |
| `apps/tui/src/index.tsx` | 真正 OpenTUI/Solid 界面；项目/会话树、空态、路径、连接状态、项目注册、会话创建、方向键、Esc、q/Ctrl+C；明确展示 Agent 尚未实现 |
| `apps/daemon/src/index.ts`, `tsconfig.json` | Node Hono HTTP/WS；仅 127.0.0.1 随机端口；内核 flock 单实例；健康/版本/身份验证；授权；安全停止；独立 Node 类型检查 |
| `packages/shared/src/*` | DTO、Zod 输入校验、XDG、0700/0600、私有原子实例文件、HTTP 客户端、WS 自动重连与状态重读 |
| `packages/core/src/index.ts` | 存在性/目录/可访问性校验、realpath、规范根目录、会话继承 Project workspace |
| `packages/storage/src/*`, `migrations/*` | better-sqlite3 + Drizzle schema/CRUD/migration；WAL、外键、root 唯一约束；事务内先落库再广播；schema 检查与迁移前 online backup |
| `scripts/build.ts`, `test.ts`, `install-local.ts` | 分别构建 Bun CLI 和 Node Daemon；真实测试编排；安装 `~/.local/bin/hhu`；活 Daemon 安装前置保护；拒绝覆盖无关同名文件 |
| `tests/integration/phase1.test.mjs`, `tests/e2e/terminal.py`, `tui.test.tsx` | 真实进程、SQLite、HTTP/WS、双 Linux PTY、Solid 键盘交互测试 |
| `README.md`, `docs/COMPATIBILITY.md`, 本文件 | 安装、使用、兼容性、限制与验收步骤 |

CRUD API：`GET/POST /v1/projects`、`GET/PATCH/DELETE /v1/projects/:id`、`GET/POST /v1/projects/:id/conversations`、`GET/PATCH/DELETE /v1/conversations/:id`。删除仅删除应用元数据，Project 下 Conversation 外键级联删除，绝不删除项目文件。

其他 API：`GET /v1/health`、`/v1/capabilities`、`/v1/snapshot`、`/v1/events?after=N&limit=M`、WS `/v1/ws`、`POST /v1/daemon/stop`。全部要求私有实例文件内的随机 Bearer 凭据，拒绝带浏览器 Origin 的请求，凭据不进入 URL 或日志。

阶段 1 WS 发送持久化的**全局元数据变更**及 hello；客户端每次建连/重连和变更后重读 SQLite 一致快照，避免读取与订阅间的空隙。`metadata_changes.seq` 不冒充未来 Conversation ACP event seq。尚未实现阶段 3 的原生流式历史补拉。

Daemon 在取得 flock 后才加载服务，竞争失败的启动器退出后 CLI 才返回；stop 等待实例文件移除及锁释放，不把 HTTP 503 当成退出成功。TUI 关闭只释放 UI/WS。日志只记录有限生命周期/错误标签和 PID，不记录请求正文或 Token，daemon/startup 日志各按 1 MiB 轮转并保留一份旧日志。

数据库 `user_version=1`，另保留 Drizzle migration journal。已有数据库待迁移时，先创建同目录 0600 的 `harnesshub.db.backup-<timestamp>-<uuid>`；更高 schema 拒绝打开，不改写数据。阶段 1 无 Worker/Turn，因而没有活跃 Agent 迁移风险；后续引入 runtime 时必须补停机/升级活动任务保护。

## 执行过的验证

| 命令/操作 | 实际结果 |
| --- | --- |
| `bun install --frozen-lockfile` | 通过，锁文件无需修改 |
| `bun run db:generate` | 生成初始 Drizzle SQL、journal、snapshot |
| `bun run typecheck` | 通过；包含仅 Node types 的 Daemon 独立检查 |
| `bun run lint` | 通过；Biome recommended，未通过关闭 lint 回避问题 |
| `bun run build` | 通过；CLI 使用官方 Solid plugin；Daemon target=node |
| `bun run test` | 10 个 Node 集成测试 + 1 个 Bun/Solid 界面测试通过，0 失败 |
| `bun run install:local` | 安装实际 `~/.local/bin/hhu`，保留源码引用；未覆盖其他工具 |
| 在 `~` 执行 `hhu --version`、`hhu doctor`、Daemon start/status/stop | 实测通过；doctor 确认 Node 24.18.0、Bun 1.4.4、SQLite 3.53.4 与 OpenTUI 原生库 |
| 在 `~` 通过已安装 `hhu` 同时打开两个 PTY | 两者连接同一 Daemon；注册真实仓库 Project；关闭一个，另一个仍能创建 Conversation；全部 TUI 退出后 PID 保持不变；最后主动正常停止 |

自动化检查覆盖：

1. 六个并发 CLI 启动只产生一个可服务 Daemon；真实 Node runtime、初始零项目。
2. HTTP/WS 未授权访问、浏览器 Origin 和未授权停止均被拒绝。
3. 不存在/相对项目路径拒绝且无目录创建；symlink 规范化、重复路径去重、真实 Project/Conversation CRUD、根目录重新绑定；用户项目文件保留。
4. WS 事件先提交后广播，断线期间变更可由持久化事件与快照读回；真实客户端跨 Daemon 重启重新读取实例 token/端口并恢复状态，无命令重放。
5. SQLite WAL、外键、schema 版本、目录 0700、DB/WAL/SHM/实例/锁 0600。
6. 正常停止/启动恢复历史；模拟仅本测试 Daemon 的 SIGKILL，内核释放锁；伪造指向无关活进程的陈旧 PID 不会被 CLI kill。
7. 迁移前备份可读且保留原数据，更高 schema 拒绝且数据完整。
8. doctor/版本/CLI 错误；安装保护在 build 前拒绝活 Daemon。
9. 构建后的 hhu 从 `~` 冷启动 Daemon，两个真正 Linux PTY 同时连接；退出一个仍可操作另一个，全部退出仍保活；显式路径快捷打开保持项目去重。
10. Solid renderer 通过真实 HTTP/WS/SQLite，从零项目输入目录、创建空会话、选中详情、退出后仍可连接 Daemon。

测试使用隔离的临时 XDG 目录、真实临时目录和真实 SQLite；终端测试进程最终关闭，测试 Daemon 正常停止。临时证据目录打印在测试输出中，未强制删除。已安装入口的独立验证在默认数据目录留下真实 Project `HarnessHub`（本仓库根目录）及空会话 `Phase 1 acceptance`；没有任何 Agent Turn。

开发检查曾发现并已修复：测试 preload 与构建后 Solid runtime 的加载差异、注册快捷键进入新输入框、stop 过早返回/竞争启动器迟到取得锁的竞态。最终检查结果见上表。

## 已知限制与未验证事项

- **真实 ACP Harness 未验证**：阶段 1 不包含 ACP runtime/SDK、Worker、NativeSession、Prompt、审批、取消、Handoff 或 Worktree；不存在可声称已通过的 Agent 测试。未读取/改写 Codex/Claude/Grok/OpenCode 原生配置。Mock ACP 故障测试随阶段 2 runtime 实施。
- **Windows Terminal、VS Code WSL 人工体验未验证**：本环境可执行 Linux PTY 和 OpenTUI renderer，不能替代两种终端的用户验收；Shift+Enter/聊天发送属于后续阶段，当前未实现且未声称通过。
- 界面为阶段 1 最小视图；当前通过 TUI 创建/浏览项目与会话，重命名/删除/重新绑定提供 API，完整管理交互留在后续阶段。窄屏、命令面板和完整聊天 UI 尚未实现。
- 本阶段连接恢复使用元数据快照；Conversation 原生事件排序、Turn 幂等和草稿是后续阶段工作。
- 本地安装引用当前 checkout 的 dist/node_modules 与 Bun 路径，移动/删除仓库后需重新安装；没有发布独立二进制或 npm 包。仅表内版本与 Linux x64 实测，不承诺 Windows 原生或任意 Node/Bun 版本。
- 当前没有任何活动 Agent，停止与安装保护只覆盖现有 Daemon；阶段 2 引入 Worker 前必须接入活动 Turn 的停止保护，不能继续沿用无任务假设。

## 用户人工验收步骤

1. 当前机器已安装；在两个 WSL 终端分别 `cd ~ && hhu`。确认显示全局项目树，且不会自动增加 Home 项目；第三终端 `hhu daemon status` 记录 PID。
2. 任选终端按 `p`，输入一个已存在且不同于 Home 的项目绝对路径，Enter；另一终端应同步出现该项目。重复输入同一路径不会重复创建。输入不存在路径应报错且磁盘上不产生目录。
3. 选中 Project，按 `n` 输入会话标题，Enter；用方向键选中会话，核对 Workspace 是 Project root。输入框按 Esc 取消，正常界面按 q/Ctrl+C 退出。
4. 退出一个 TUI，另一个继续浏览/创建会话；退出全部 TUI 后运行 `hhu daemon status`，应保持原 PID。再次 `hhu` 应看到原项目/会话。
5. `hhu daemon stop && hhu daemon start`，重新打开 TUI，确认 SQLite 元数据仍在。停止后重新从 `~` 直接 `hhu`，确认自动启动而不需要手动 start。
6. `hhu doctor` 应报告本机实际版本和 Daemon 状态；`hhu daemon logs` 不应含请求正文、Prompt 或凭据。按 README 核查文件权限；运行 Daemon 时 `bun run install:local` 应在构建前拒绝。
7. 分别在 Windows Terminal 与 VS Code WSL 终端重复界面步骤，记录显示、输入、退出与终端恢复的结果。此项目前标记**未验证**。

阶段 1 完成后等待用户验收；不会自动进入阶段 2。
