# HarnessHub 兼容性与依据

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

## Phase 2：ACP 实测（2026-10-31）

共享 Client 锁定 `@agentclientprotocol/sdk@2.2.0`，使用稳定 v1 导出 `ClientApp`、`ndJsonStream`、`request` / `notify`。四种 Agent 及自定义入口使用同一实现；Adapter 自己依赖的 SDK 2.1.0 属于其内部实现，不是 HarnessHub 的另一套 Client。

| Harness | 实际 ACP 入口与版本 | initialize / session/new | 本机 ACP 配置 | 真实执行 |
| --- | --- | --- | --- | --- |
| Codex | `@agentclientprotocol/codex-acp@2.5.0` 的 `dist/index.js`；锁内置 `@openai/codex@0.165.0`，另有 PATH CLI 0.166.0 | 通过，返回 Agent 身份与 sessionCapabilities | `mode`、`collaboration_mode`、`model`；本次模型未暴露独立 effort selector | 读取、pwd、Node 测试 1 pass；另一个真实 Turn 原生取消返回 `cancelled` |
| Claude Code | `@agentclientprotocol/claude-agent-acp@0.99.1/dist/index.js`，内置 Agent SDK 0.3.312；另有 PATH CLI 2.1.311 | 通过 | `mode`、`model`、`effort`、`ultracode` | 读取、pwd、Node 测试 1 pass；真实权限请求阻塞，用户选择 `allow-with-updates` 后继续 |
| Grok Build | 本机 `grok agent stdio`，`grok 1.0.50 (c58f321264ba)` | 通过；本次未返回 `agentInfo`，版本以实际 CLI 输出为证 | 仅 `model`，没有模式/推理 selector | 读取、pwd、Node 测试 1 pass |
| OpenCode | 本机 `opencode acp`，1.18.32 | 通过，返回 Agent 身份 | `model`、`mode` | 读取、pwd、Node 测试 1 pass |
| 自定义 | `command + args + envOverrides`，Mock 使用真实 Node stdio 子进程 | 自动化通过 | 完全取决于 Agent 的返回值 | Mock 覆盖权限、故障、流顺序与生命周期；其他自定义产品未宣称验证 |

四者均在 Client `fs.readTextFile=false / fs.writeTextFile=false / terminal=false` 时使用自身原生工具完成验证；HarnessHub 不代为读写文件或执行 Agent 工具。需要客户端这些能力的 Agent 当前不受支持，不能据此推断所有 ACP Agent 都可用。没有声明子 Agent、elicitation、AIR 或 ACP v2 扩展能力；未知通知保留原始事件。虽然四者协商返回 `loadSession` / resume 等能力，本阶段不尝试自动恢复原生内部状态。

Codex 本次原生输出包含“自定义模型缺少 metadata、使用 fallback”的警告；按原文保留，未读取或修补原生模型配置。安装在 PATH 的原生 CLI 与 Adapter 捆绑版本分别列出，不假设两者相同。内置 Profile 优先使用 PATH Adapter；没有时回退到 lockfile 内的已验证 CLI 文件；Claude 的包默认导出 `dist/lib.js` 是库入口，不能拿来启动 ACP。

核对的官方资料和实际依赖证据：

- [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk)、[SDK 2.2.0 npm 元数据](https://registry.npmjs.org/@agentclientprotocol/sdk/2.2.0)；本机安装包的 `dist/v1/stable/acp.d.ts` / `dist/v1/schema/types.gen.d.ts`，确认 v1 初始化、权限回调、原生 config options、取消和 session close 方法。
- [ACP v1 Prompt Turn / cancellation](https://agentclientprotocol.com/protocol/v1/prompt-turn)、[ACP 初始化](https://agentclientprotocol.com/protocol/v1/initialization)；取消通知不是 Prompt 完成确认，末尾通知仍需接收。
- [Codex Adapter README](https://github.com/agentclientprotocol/codex-acp/blob/main/README.md)、[2.5.0 npm 元数据](https://registry.npmjs.org/@agentclientprotocol/codex-acp/2.5.0)；入口为 `codex-acp`，由 Adapter 启动 App Server。
- [Claude Adapter README](https://github.com/zed-industries/claude-agent-acp/blob/main/README.md)、[0.99.1 npm 元数据](https://registry.npmjs.org/@agentclientprotocol/claude-agent-acp/0.99.1)；`bin` 明确指向 `dist/index.js`，与包的 `main` 不同。
- 本机 `grok --version`、`grok agent --help` 和真实 stdio 握手；`opencode --version`、`opencode acp --help` 和真实握手。没有用文档中可能过期的命令替代安装版本验证。

详细事件边界、测试命令、能力限制和人工验收见 [Phase 2 记录](acceptance/phase-2.md)。以上不替代 Windows Terminal / VS Code WSL 的人工验证。
