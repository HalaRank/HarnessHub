# 阶段 1 兼容性与依据

验证日期：2026-10-30（America/Los_Angeles，UTC 为 10-31）。本表仅表示本机实际验证结果，不代表所有版本/终端均受支持。

| 组件 | 锁定/实测版本 | 结果 |
| --- | --- | --- |
| OS | Ubuntu 26.04 LTS / Linux x64 / WSL2 6.18.33.2 | 已验证 |
| Node.js | 24.18.0 LTS | Daemon 实际运行；独立类型检查不引入 Bun types |
| Bun | 1.4.4 | 安装、构建、CLI、OpenTUI 原生库与真实 PTY 已验证 |
| OpenTUI core / solid | 0.8.0 / 0.8.0 | Bun 下渲染与输入已验证；不在 Node Daemon 中加载 |
| SolidJS | 1.9.18 | JSX 由官方 Solid Bun plugin 构建；与 renderer 一起打包，确保客户端响应式 runtime |
| Hono / Node adapter | 4.13.14 / 2.1.5 | 127.0.0.1 HTTP、Bearer 授权、WS 实际测试通过 |
| ws | 8.21.0 | Hono Node adapter 与 Bun/Node 客户端已验证 |
| better-sqlite3 / SQLite | 13.0.3 / 3.53.4 | Node 24 native binding、WAL、backup、权限、外键与重启恢复通过 |
| Drizzle ORM / Kit | 0.45.4 / 0.31.11 | 生成与执行 SQL migration、CRUD 已验证 |
| TypeScript / Biome | 5.9.3 / 2.6.4 | 严格类型检查、推荐 lint 规则通过 |
| Git / flock | 2.53.0 / util-linux 2.41.3 | 实测版本；flock 在进程崩溃后释放锁 |
| Windows Terminal / VS Code WSL 终端 | 未单独验证 | 当前只能访问 Linux PTY；需用户人工验收 |
| ACP SDK / 四种真实 Harness | 未接入、未验证 | 阶段 2 再锁定 SDK/Adapter 版本及协商能力，不提前宣称兼容 |

依赖精确版本见根 `package.json` 与 `bun.lock`；`.node-version` / `.bun-version` 固定实测运行时。启动器要求 Node 24.18+ 且 <25，但当前仅 24.18.0 做过验证。

实施时核对的官方资料：

- [OpenTUI runtime 支持](https://opentui.com/docs/getting-started/runtime-support/) 与 npm `@opentui/core@0.8.0` engines：Bun >=1.3.14；其 Node 支持要求 >=26.4.0。HarnessHub TUI 使用 Bun，Daemon 的 Node 24 不加载 OpenTUI，因此不改变既定进程架构。
- [OpenTUI Solid README](https://github.com/anomalyco/opentui/blob/main/packages/solid/README.md)：`@opentui/solid/preload`、`jsxImportSource`、官方 `bun-plugin` 与 `testRender`。Bun 测试配置单独声明 `[test].preload`；构建时打包 Solid 与 binding，避免启动目录外丢失 preload 导致 SSR runtime。
- [Hono Node adapter WebSocket](https://github.com/honojs/node-server#websocket)：v2 adapter 直接提供 `upgradeWebSocket`，配合 `ws` 的 `noServer` 模式。[旧 node-ws 官方说明](https://github.com/honojs/middleware/tree/main/packages/node-ws) 已标记废弃，因此未引入旧包。
- [better-sqlite3 官方 API](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md)：WAL pragma 与 online `backup()`；原生 binding 在 Node 中实测。
- [Drizzle SQLite migrations](https://orm.drizzle.team/docs/migrations)：仓库保留生成的 SQL、journal 和 snapshot，运行时使用 better-sqlite3 migrator。

Hono 的结构化 WebSocket 类型与 `@types/ws` 在 `exactOptionalPropertyTypes` 下存在声明兼容问题；仅在官方 adapter 接口处做显式类型桥接，实际升级、认证、事件和重连均有 wire 测试。
