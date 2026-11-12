# Desktop 附件容量修订

2026-11-12，Asia/Shanghai。用户要求取消此前自行设置的单文件 5 MiB 和每条最多 4 个附件限制。本次继续 Desktop Phase 4。

## 实现

- 移除 Renderer 与共享 Zod 契约中的单文件大小、附件数量及合计 10 MiB 阈值。上传图标说明改为“支持多选各类文件”。文件名、MIME、base64 格式、图片非空和 Agent 能力校验沿用原有契约。
- 草稿、新建页草稿、普通 Turn 和运行中 inputs 接口接收附件 JSON，请求体不设固定容量阈值。草稿中的 pendingSubmission 可以包含与附件相同的内容副本。其他接口沿用各自请求契约。
- Desktop 与共享 TUI 客户端将 ws 的 maxPayload 设为 0，允许接收包含大附件的完整事件。
- 附件仍通过现有 FileReader、base64、SQLite 和 ACP 资源链路传递。可处理的实际容量取决于进程内存、SQLite、原生 Agent 与模型。锁定 ACP SDK 的 stdio 接收端默认单条消息限制为 32 MiB，原生适配器自行创建其接收流，具体拒绝或失败继续沿用真实投递状态。

## 变更文件

- `packages/shared/src/images.ts`、`client.ts`
- `apps/desktop/src/renderer/Images.tsx`、`main/connection.ts`
- `apps/daemon/src/index.ts`
- `apps/desktop/tests/images.test.tsx`
- `tests/integration/desktop.test.mjs`、`pending-inputs.test.mjs`
- `docs/acceptance/desktop-phase-4-attachments-toolbar.md` 与本记录

## 验证

| 检查 | 结果 |
| --- | --- |
| `bun run typecheck` | 根工程、Daemon、Desktop 通过，日志 `/tmp/hhu-unlimited-typecheck-final.log` |
| `bun run lint` | 173 个文件通过，日志 `/tmp/hhu-unlimited-lint-final.log` |
| `bun run desktop:test` | CLI/Daemon/Desktop 构建与 71 项 Desktop 单元测试通过，日志 `/tmp/hhu-unlimited-desktop.log` |
| Node 全量集成 | 122/122 通过，日志 `/tmp/hhu-unlimited-full.log` |
| TUI 完整重跑 | 125/125、1733 个断言通过，日志 `/tmp/hhu-unlimited-ui-final.log` |
| 最终 Desktop 集成 | 20/20 通过，日志 `/tmp/hhu-unlimited-integration.log` |
| Chromium 实际 Renderer | 6 MiB PDF 与 6 个文本文件读取、草稿保存及提交通过，页面错误为零，证据 `evidence/desktop-attachment-limits/browser-interactions.json` |
| `git diff --check` | 通过 |

首次 Desktop 集成的大附件断言完成后，测试把 `onState` 的返回值当成取消监听函数，导致用例失败。修正测试用法后，完整重跑 20 项通过。运行中大附件排队的专项用例也已在标准全量入口中通过。标准全量入口的 TUI 部分最初有一个既有中断恢复用例超过 5 秒，并产生后续异步超时错误，其余 124 项通过。该文件单独重跑 10/10 通过，随后完整重跑 13 个 TUI 测试文件得到 125/125、1733 个断言通过。

容量回归覆盖以下路径。

1. 共享 schema 接受 20 个附件和单个 6 MiB 的图片/文件，合计超过原 10 MiB。
2. Desktop typed action 保存 12 MiB 文件与 6 张图片，共 7 个附件。草稿及 pendingSubmission 双副本使 HTTP 请求超过原 30 MiB。实际 ACP Prompt 中的附件字节与数量正确，超过原 Desktop WS 16 MiB 的事件到达后连接持续为 connected。
3. 运行中的 6 MiB 文件与 6 张图片经 inputs 接口排队，后续 Turn 保留完整字节，收到一次 ACP prompt。
4. Chromium 使用实际 Composer 读取 6 MiB PDF 与 6 个文本文件，草稿与提交保留 7 个附件。

## 待验收

本轮 Windows 原生文件选择器、物理键盘及真实 Agent 的大文件解析为“未验证”。浏览器检查使用文件输入 API、DOM click 和 DesktopApi 替身，Agent 投递由真实 Daemon、SQLite 与 Mock ACP 验证。

使用本轮 Windows Desktop 与 WSL 后端构建，选择一个大于 5 MiB 的文件，再添加至少 4 个其他附件。检查预览、移除、重开草稿、普通发送与运行中排队，并用实际 Harness 检查所选格式的处理结果。
