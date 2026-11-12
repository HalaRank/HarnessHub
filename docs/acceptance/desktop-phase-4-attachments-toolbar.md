# Desktop 附件入口、排队操作与发送反馈

日期为 2026-11-11，Asia/Shanghai。本次属于现有 Desktop Phase 4 的输入区域修订。

## 交付内容

- 附件入口采用回形针图标，提供可访问名称、悬停说明、禁用与读取状态。已有会话和新建会话共用同一个上传入口，可多选任意文件类型，支持剪贴板文件。图片显示缩略图，其他文件显示文件图标、文件名和大小，可逐项移除。
- 输入框底部按会话选项与操作按钮分组。取消任务使用停止图标，排队按钮带队列图标与 Tab 键提示，排队和主发送按钮位于同一个不可拆分的操作组。窄屏时整组换行。
- “消息已发出”采用输入框下方的紧凑状态反馈，带完成图标和关闭按钮。普通成功提示 4 秒后收起，结果不确定和带 requestId 的核查反馈保留。输入框下方预留状态行高度，路径过长时省略并可悬停查看完整路径。
- 沿用现有附件容量，每条消息最多 4 个、单个最大 5 MiB、合计最大 10 MiB。文件内容存入现有 SQLite 草稿与消息事件。持久化字段继续使用 `images`，普通文件增加 `kind=file`，已有图片草稿与历史继续可读。
- 图片使用 ACP image 内容块。其他文件使用 ACP resource，分别核对 Agent 的 image 与 embeddedContext 能力。UTF-8 文本资源包含解码后的文本，二进制资源包含原始 base64。浏览器将 TypeScript `.ts` 标记为 video/mp2t 时也尝试严格 UTF-8 解码，二进制和含 NUL 的内容保留 blob。
- 原始附件参与请求内容去重、草稿 CAS、未知投递保留、排队与 Handoff。运行中的文件消息等待后续 Turn。

## 主要文件

- `apps/desktop/src/renderer/Composer.tsx`、`Images.tsx`、`drafts.ts`、`style.css`
- `packages/shared/src/images.ts`、`packages/core/src/runtime.ts`
- `apps/desktop/tests/chat.test.tsx`、`images.test.tsx`、`windows-images.ts`
- `tests/fixtures/mock-acp/server.mjs`、`tests/integration/desktop.test.mjs`、`pending-inputs.test.mjs`
- `docs/acceptance/evidence/desktop-attachments-toolbar/browser-interactions.json`

## 验证

| 检查 | 结果 |
| --- | --- |
| `bun run typecheck` | 根工程、Daemon、Desktop 通过，日志 `/tmp/hhu-attachments-typecheck-final.log` |
| `bun run lint` | 173 个文件通过，日志 `/tmp/hhu-attachments-lint-final.log` |
| `bun run test` | 122 项 Node 集成、125 项 TUI 测试通过，日志 `/tmp/hhu-attachments-full.log` |
| `bun run desktop:test` | CLI/Daemon/Desktop 编译通过，71 项 Desktop 单元通过，日志 `/tmp/hhu-attachments-desktop-final2.log` |
| 最终 Desktop 集成重跑 | 20/20 通过，日志 `/tmp/hhu-attachments-integration-final.log` |
| 混合附件排队专项 | 12/12 通过，日志 `/tmp/hhu-attachments-pending.log` |
| Chromium 实际 Renderer | 1100、850、520、390px 均无横向溢出，操作按钮保持同行；PDF、TypeScript 与 PNG 多选、预览、移除、发送、成功提示自动收起、手动关闭和不确定提示保留均通过 |
| 最终 Desktop 构建 | 通过，产物 `/tmp/hhu-desktop-build-dckdDb`，日志 `/tmp/hhu-attachments-build-final.log` |
| `git diff --check` | 通过 |

全仓回归之后增加 UTF-8 文本资源及 TypeScript MIME 处理，后续重新构建并用最终 Desktop 集成覆盖该分支。最终一轮 `desktop:test` 中，已有 Handoff 场景曾在 `harness.select` 之后发生一次“Daemon 未连接”，其余 19 项通过。完整 Desktop 集成重新运行得到 20/20，通过记录保存在上表最后的集成日志。

浏览器测试使用真实 React Composer、CSS 和 DesktopApi 替身。附件通过文件输入 API 选取，按钮通过 DOM click 触发 React 处理。系统原生文件选择器的等待事件、普通指针点击的稳定帧等待和截图合成在当前 headless 环境超时。因此本轮截图视觉核验、系统文件选择器与 Windows 物理鼠标/键盘交互均标记为“未验证”。浏览器脚本与详细证据位于 `/tmp/hhu-attachments-browser/`。

协议依据已核对锁定的 `@agentclientprotocol/sdk@2.2.0` ACP v1 类型，以及仓库安装的 Codex/Claude ACP 适配器资源转换实现。embeddedContext 表示接收资源块，具体格式的语义处理由原生 Agent 决定。[ACP v1 内容契约](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/schema.json)

## 真实环境与待验收

真实 Codex ACP initialize 通过，实际声明 embeddedContext=true 与 image=true。随后 session/new 在 20 秒内未返回，客户端记录超时，测试 Worker 已正常关闭且确认退出。此次未发送模型 Prompt，真实 Agent 的附件读取结果标记为“未验证”。证据见 `evidence/desktop-attachments-toolbar/real-acp.json`，隔离工作区为 `/tmp/hhu-attachments-real-3QDgmL`。

本轮交付源码与本地构建。安装版生效需要包含本轮修改的 Windows Desktop 与 WSL 后端构建。

1. 在 Windows App 的已有会话和新建页点击回形针，分别多选图片、PDF、文本/代码和其他二进制文件，核对预览、移除、容量错误与草稿重新打开。
2. 使用实际声明文件输入能力的 Agent 发送附件，核对 Agent 对所选格式的实际读取结果。
3. 运行中通过 Tab 或排队按钮提交消息，确认按钮成组布局及后续 Turn 的一次性发送。通过 Enter 追加指令，检查“消息已发出”反馈的自动收起与手动关闭。
4. 在窄窗口、不同 DPI 和中文输入法下检查菜单、焦点、Enter 与 Shift+Enter。
