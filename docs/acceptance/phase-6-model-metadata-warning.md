# Phase 6 补充验收：模型 metadata fallback 警告展示过滤

日期：2026-11-12。用户明确要求 TUI 与 Desktop 不再显示非官方模型触发的 `Model metadata … not found` 警告。本次仅调整当前阶段的聊天展示投影，不新增阶段、配置项或数据库迁移。

## 根因与范围

已有真实 Codex ACP 记录 `evidence/desktop-phase-2/real-codex-observable-events.json` 显示：该警告通过 `agent_message_chunk.content.text` 发出，属于聊天正文，并非 HHU 转发 stderr。因此在两个客户端共享的 `projectEvent()` 处理，而不改 Agent 配置、原生 ACP、SQLite 历史或进程输出。

按用户本次要求，为原生输出保真增加一项明确的展示例外：仅匹配 Agent 消息开头完整的固定警告 `Warning: Model metadata for <model> not found. Defaulting to fallback metadata; this can degrade performance and cause issues.`，支持任意模型 ID、有无反引号及 LF/CRLF。纯警告归入内部诊断，不生成空聊天行；警告与回复同一事件时仅移除前缀，后续回复原样展示。TUI 与 Desktop 的增量追加、历史回放共用规则。

用户消息、代码块或说明中的引用、工具输出、其他 warning 和真实错误不适用该规则。完整原始及结构化事件仍保留，Raw Events / Debug / 原始导出可追溯。本次不对跨多个 ACP 事件拆分的半条警告做缓存或猜测；当前锁定 Adapter 的已有真实记录为整段独立事件。

## 文件

- `packages/shared/src/event-projection.ts`：固定诊断前缀识别及展示文本投影。
- `apps/tui/src/transcript.ts`、`apps/desktop/src/renderer/history.ts`：展示投影后的正文，不修改来源事件。
- `tests/e2e/agent-output.test.tsx`：TUI 实际渲染、实时/回放、回复拼接、结束状态、源码保留及误过滤边界。
- `apps/desktop/tests/history.test.tsx`：Desktop 实时/回放、序号推进、CRLF、多模型及其他告警/错误保留。
- 本记录及 `docs/acceptance/phase-6.md`：专项验收入口。

## 验证

- `bun run typecheck`：通过。
- `bun run lint`：通过。
- `bun run desktop:build`：通过。
- `bun run test`：构建通过；Node 集成 122 pass / 0 fail；TUI/UI 129 pass / 0 fail，1784 次断言。包括新过滤测试及原有审批、取消、WS 补拉、Handoff 去重回归。完整日志 `/tmp/hhu-model-metadata-test.log`。
- `cd apps/desktop && bun test tests`：72 pass / 0 fail，445 次断言。
- 对已有真实 Codex ACP JSON 做 TUI、Desktop 回放：19 个事件，隐藏 1 条完整警告，其余 Agent 回复 369 字符逐字一致，来源 JSON 未改动。证据原本只记录可观察事件，回放仅在内存副本中重排连续 seq，不写数据库。
- 首次把 TUI 与 Desktop 测试合并从仓库根目录运行，Desktop React 渲染测试受到根目录 Solid JSX 测试配置影响出现 Invalid hook call；按仓库既有方式分别从各自目录运行后 Desktop 全部通过，不修改产品代码规避该配置边界。
- 额外构建 Desktop Main 测试 bundle，执行 `HARNESSHUB_BUN="$(command -v bun)" node --test tests/integration/desktop.test.mjs`：两轮均为 19 pass / 1 fail。失败均为既有的 `Desktop mixed attachment drafts, ACP bytes, request deduplication and Handoff retain attachments` 场景出现 `socket hang up` / `ECONNRESET`，完整日志 `/tmp/hhu-model-metadata-desktop-integration.log`、`/tmp/hhu-model-metadata-desktop-integration-final.log`。本次未修改该场景、HTTP 传输或附件实现，也未据此声称完整 Desktop 集成通过。
- 对上述失败场景使用 `--test-name-pattern='Bridge starts absent|Desktop mixed attachment'` 定向复查，首次复查仍失败，主回归结束后再次复查为 2 pass / 0 fail。另在 `/tmp/hhu-metadata-baseline-aHR6VK` 构建仅把本次三个产品源码文件替换为 HEAD 内容的对照产物，定向复查同为 2 pass / 0 fail；未修改工作区源码。该结果只能证明此附件问题有间歇性，不能确定其根因或认定已修复。
- `git diff --check`：通过。未修改工作区已有的 Desktop shared-branch 证据文件。

## 未验证与手动验收

本轮没有发起真实远端模型请求，也没有在 Windows GUI / 物理终端上操作。既有真实事件回放与自动化渲染通过不等于本轮实时模型或 Windows GUI 已验证。

构建并按既有安全升级流程更新实际使用的 HHU 客户端，打开含上述警告的历史会话并向该模型发送一条普通消息：TUI 与 Desktop 聊天中不再出现该警告，正文正常流式显示；Raw Events / Debug 原始导出仍包含完整警告。其他真实失败和审批继续按原生事件显示。本轮不更新全局安装、不重启日常 Daemon、不改用户模型来源或认证配置。
