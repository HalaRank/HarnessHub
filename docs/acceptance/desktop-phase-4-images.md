# Desktop 图片上传与粘贴

2026-11-11，Asia/Shanghai。用户要求 Windows App 支持选择图片及 Ctrl+V 粘贴图片。本轮继续现有 Desktop 阶段，覆盖新建页和已有会话。

## 实现

- 输入栏增加“+ 图片”，系统文件选择支持多选。消息输入框的原生 paste 事件接收 Windows 剪贴板图片，文字粘贴沿用浏览器编辑行为。
- 待发图片显示缩略图、文件名和独立移除按钮。图片可以单独发送，也可随文字发送。发送后历史显示本地图片预览。
- 默认支持 PNG、JPEG、GIF、WebP。每条最多 4 张，单张最多 5 MiB，总计最多 10 MiB。这些初始限制由本轮实现确定。
- 文件经浏览器 FileReader 读取，传递 MIME 与 base64 字节。WSL Agent 接收 ACP image content block。发送前检查实际 initialize.agentCapabilities.promptCapabilities.image，未声明能力时展示错误。新建页首次发送先建立 Conversation 和对应草稿，再投递图片。
- SQLite schema 9 为 conversation_drafts、new_conversation_drafts 增加 JSON 图片列。迁移默认空数组，沿用私有备份和事务迁移。旧客户端省略 images 时保留现有附件，缺失附件的 pendingSubmission 预留会被拒绝。
- 附件加入 Turn 请求哈希、原用户事件和待确认请求。未知结果保留原 requestId 与附件供查询。Handoff 从原用户事件取回首条目标消息的图片，在目标能力确认后随背景和用户文字发送。降级摘要只带历史图片名称及 MIME，原图仍保存在原始事件中。
- 图片读取期间的关闭 flush 会等待读取和保存。CAS 冲突保留本地附件。与图片相关的 HTTP 草稿及 Turn 路由允许 30 MiB，请求字段继续按图片总量校验。

ACP 图片块及能力字段按锁定 SDK 2.2.0 和官方 v1 文档核对。[Content](https://agentclientprotocol.com/protocol/v1/content)、[Initialization](https://agentclientprotocol.com/protocol/v1/initialization)

## 变更文件

| 范围 | 文件 |
| --- | --- |
| 图片契约 | packages/shared/src/images.ts、index.ts、runtime.ts、session-state.ts |
| SQLite | packages/storage/src/schema.ts、index.ts、migrations/0008_solid_william_stryker.sql 及生成的 meta |
| ACP 与传输 | packages/core/src/runtime.ts、handoff.ts、pending-inputs.ts，apps/daemon/src/index.ts |
| Desktop | renderer/Images.tsx、Composer.tsx、NewConversation.tsx、drafts.ts、history.ts、Message.tsx、style.css，main/actions.ts |
| 自动化 | apps/desktop/tests/images.test.tsx、chat.test.tsx、windows-images.ts、windows-smoke.ts，tests/integration/desktop.test.mjs、standalone-conversations.test.mjs，tests/fixtures/mock-acp/server.mjs，scripts/verify-desktop-windows.ts |

共享工作区同时存在选择框的独立改动，涉及 Select、WslEnvironment 和部分相同 Renderer/CSS 文件。本记录描述图片功能。验证使用当时共享工作区的完整构建。

## 验证

| 命令 | 结果 |
| --- | --- |
| bun run typecheck | 通过，根工程、Daemon、Desktop |
| bun run lint | 通过 |
| bun run build、bun run desktop:build | 通过 |
| bun run desktop:test | 67 项 Desktop 单元、18 项 Daemon/SQLite/Mock ACP 集成通过 |
| HARNESSHUB_BUN=/home/clj/.local/bin/bun node --test tests/integration/desktop.test.mjs | 18 项通过 |
| 同上执行 tests/integration/standalone-conversations.test.mjs | 3 项通过，包括真实 schema 6/8 升级、草稿默认图片和备份 |
| bun run test | 120 项 Node 集成、123 项 TUI/UI 测试通过 |
| HHU_DESKTOP_IMAGES_ONLY=1 bun scripts/verify-desktop-windows.ts | 真实 Windows x64 / Electron 45.2.3 / WSL2 通过，含新建会话首条纯图片发送 |

图片单元覆盖格式、大小、数量、纯图片消息、草稿恢复、CAS 冲突、读取期间 flush、丢失 ACK 保留原 ID、预览和移除。Desktop 集成验证传输实际字节、重复请求、内容变化拒绝、跨 Harness 图片交接、超过旧 1 MiB 上限的草稿及无图片能力时零 Prompt。

首次完整回归发现旧 schema 测试夹具调用新版 Store.saveDraft，提前读取尚未迁移的 images 列。已改为按历史列写入夹具，并追加 schema 8 升级验证。实际升级后使用新版 Store。首次 Windows 自动化缺少 Chromium Page.enable，未收到文件选择事件。补充后真实文件选择与粘贴通过。补测的剪贴板恢复根据 Electron 45 类型和实际错误调整为先读取各 MIME 的数据，再构造可写 ClipboardItem，最终复验通过。

Windows 自动化使用真实 Electron、WSL Daemon、SQLite 与 Mock ACP，模型识图效果另行记录。Windows 最终通过的现场为 `/mnt/c/Users/31970/AppData/Local/Temp/hhu-desktop-smoke-VZzAs9`，隔离数据位于 `/tmp/hhu-windows-smoke-furlSA`。截图和结果已保存至 `evidence/desktop-images/`，截图已查看。最终日志为 `/tmp/hhu-images-windows-complete.log`、`/tmp/hhu-images-desktop-complete.log`、`/tmp/hhu-images-regression-final.log`。

## 真实 Harness 与待验收

真实 Codex initialize 声明图片能力，但 session/new 超时，图片 Prompt 尚未发出。真实 Claude 声明图片能力并收到图文 Prompt，随后返回 -32000 Authentication required，结果保留为 UNCERTAIN。真实模型识图效果为“未验证”。测试使用合成色块，隔离工作区和 SQLite。测试 Worker 经核实 cwd 与进程组后正常 SIGTERM，隔离 Daemon 已停止，历史保留。证据见 codex-evidence.json 和 claude-evidence.json。

使用已认证的图片 Harness 在已有会话和新建页分别选择截图、Ctrl+V 粘贴，检查预览和移除，再发送纯图片及图文消息并核对 Agent 的识图回答。检查 Enter 发送、Shift+Enter 换行、关闭重开恢复附件和跨 Harness 交接。真实物理键盘/输入法、系统格式差异、所有图像编码变体和超长图片历史压力为“未验证”。

图片原字节与事件保存在同一私有 SQLite 中，历史包含 base64 会增加数据库及历史读取内存。当前完整 Renderer 历史的内存边界沿用 Desktop 既有限制。图片随空闲会话 Turn 发送。

本轮交付源码与本地构建。安装版更新需要重新打包，WSL 后端也需使用包含 schema 9 和图片契约的构建。
