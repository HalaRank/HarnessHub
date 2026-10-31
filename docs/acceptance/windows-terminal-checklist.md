# Windows Terminal / VS Code WSL 人工验收

当前状态：**两种真实终端均未人工验收**。开发环境只能运行 Linux PTY / OpenTUI renderer，不能替代物理键盘、鼠标与 Windows 系统剪贴板。请每种终端分别复制此记录、填写版本和实际结果；不能把空白当成通过。

| 环境记录 | Windows Terminal | VS Code WSL |
| --- | --- | --- |
| 终端 / VS Code / Remote WSL 版本 | 待填写 | 待填写 |
| WSL 发行版、内核、Node、Bun、hhu 版本 | 待填写 | 待填写 |
| 字体、初始列/行、输入法、剪贴板/OSC52 设置 | 待填写 | 待填写 |
| 验收日期与测试人 | 待填写 | 待填写 |

准备：使用临时 Git 仓库（`mktemp -d`、`git init`、创建并提交一个测试文件），从 `~` 执行 `hhu` 注册该仓库。不得在真实项目测试删除/清理。至少创建两个 Conversation；真实 Agent 若请求权限，只由你选择原生选项。把复制结果粘贴到 Windows 文本编辑器逐字核对，单看 OSC52 输出不算通过。

| 编号 | 操作与预期 | Windows Terminal | VS Code WSL |
| --- | --- | --- | --- |
| 01 | `cd ~; hhu` 打开全局 Project → Conversation 树；不自动注册 Home | 待验收 | 待验收 |
| 02 | 另一终端也打开 hhu，`daemon status` PID/实例相同；关闭一个 TUI 不影响另一个 | 待验收 | 待验收 |
| 03 | `m` 输入中文和空行；**无选区 Ctrl+C** 清空输入，TUI 仍在 | 待验收 | 待验收 |
| 04 | **空输入、无选区 Ctrl+C** 退出 TUI；Daemon 与运行中的 Agent 继续 | 待验收 | 待验收 |
| 05 | 有输入时在聊天中拖出有效选区，**Ctrl+C 复制选区**，输入不清空、TUI 不退出、Agent 不取消 | 待验收 | 待验收 |
| 06 | 物理 Enter 提交一次：只新增一条 user.message 和一次用户 Prompt | 待验收 | 待验收 |
| 07 | 物理 Shift+Enter 换行不发送；记录实际键码/终端限制，不能以软件注入替代 | 待验收 | 待验收 |
| 08 | Ctrl+J 备用换行可用；粘贴多行文本不自动提交 | 待验收 | 待验收 |
| 09 | 鼠标拖选后松开即复制，无须再按复制键 | 待验收 | 待验收 |
| 10 | 双击选词、三击选行；中文/英文混合内容选择结果符合终端与 OpenTUI 行为 | 待验收 | 待验收 |
| 11 | 复制中文、emoji、空行、缩进、长于一屏的文本到 Windows 编辑器核对 | 待验收 | 待验收 |
| 12 | 用 `y` 复制完整 Markdown、代码、工具输出，确认是原文而非格式化屏幕；超长原文可分页阅读且可完整复制 | 待验收 | 待验收 |
| 13 | 宽终端、窄于 90 列、反复 Resize：输入框/状态可用，侧栏自动收起，选择保留 | 待验收 | 待验收 |
| 14 | Ctrl+P 搜索 Project/Conversation、快速切换；Ctrl+B 切侧栏 | 待验收 | 待验收 |
| 15 | 两个 Conversation 并发；状态和待审批通知正确；切换不串流、不丢草稿 | 待验收 | 待验收 |
| 16 | 原生权限请求阻塞，显示原始选项；不选择时不批准；两 TUI 竞争决定只生效一次 | 待验收 | 待验收 |
| 17 | 运行中/失败/审批工具展开，成功默认折叠；手动展开在流更新/切会话后保留 | 待验收 | 待验收 |
| 18 | Markdown、代码、计划、公开 Thinking 保留原文；initialize/正常控制响应不进入普通聊天 | 待验收 | 待验收 |
| 19 | Ctrl+P → Raw Events / Debug 可看全部原始来源、序号、未知事件与真实错误 | 待验收 | 待验收 |
| 20 | 向上滚历史后流式输出不强制拉底；End 恢复跟随；切回会话可继续原位置 | 待验收 | 待验收 |
| 21 | Ctrl+D Changes 与绑定 Workspace 的 `git status`/diff 一致，不推测谁修改 | 待验收 | 待验收 |
| 22 | 运行中退出所有 TUI，再打开补齐历史，NativeSession 未更换且 Prompt 数不增加 | 待验收 | 待验收 |
| 23 | 未发送草稿退出/重连恢复；两个客户端冲突保留本地输入；未确认提交不自动重发 | 待验收 | 待验收 |
| 24 | 归档、显示归档、恢复、输入 DELETE 删除同步到另一 TUI；文件/分支/Worktree 保留 | 待验收 | 待验收 |
| 25 | 同 Harness 连续消息复用 Session；只用 h 切目标不调用模型；x 取消 pending | 待验收 | 待验收 |
| 26 | Codex→Grok→Codex：首条目标消息才生成九章节报告；正常自动接管，第三段是新 Codex Session | 待验收 | 待验收 |
| 27 | Handoff `e` 展开、`y` 原文复制、`r` 来源可核对；完整报告可粘贴到 Windows 编辑器 | 待验收 | 待验收 |
| 28 | 隔离 Mock 报告失败：f 先查看材料，不确认不投递；确认降级/取消/重试按状态执行；UNCERTAIN 拒绝全部重发路径 | 待验收 | 待验收 |
| 29 | 源运行/审批/取消未结束时向目标提交被拒；不同 Conversation 仍允许并发 | 待验收 | 待验收 |
| 30 | 创建标题时 Ctrl+W 选独立 Worktree；路径、分支、Agent pwd、Changes 一致 | 待验收 | 待验收 |
| 31 | 删除 Worktree Conversation 后文件/分支保留；绑定/dirty/untracked/ignored/Git lock 均阻止清理 | 待验收 | 待验收 |
| 32 | Manage Worktrees 核对路径/分支，输入 CLEAN 才清理；普通清理后分支仍在，无 force | 待验收 | 待验收 |
| 33 | `hhu agent export <id> chat out.md` / debug JSON 为 0600，含消息/来源/工具/Handoff，已有目的文件拒绝覆盖 | 待验收 | 待验收 |

失败场景可按 `tests/integration/phase5.test.mjs` / `phase6.test.mjs` 的隔离 XDG + `tests/fixtures/mock-acp/server.mjs` Profile 复现：`HHU_MOCK_REPORT_FAIL=1` 制造报告失败；`HHU_MOCK_REPORT_CRASH=1` 制造源断线。只使用临时数据/仓库，不能把真实 Agent 换成 Mock 后宣称真实兼容性通过。Windows 人工测试无需主动 SIGKILL 真实 Agent。

最终记录至少包含：失败编号、复现操作、期望/实际、终端版本、是否使用 Ctrl+J fallback、Windows 剪贴板粘贴结果。两种终端全部满足要求且真实 Harness 未验证项妥善解决后，才可确认最终 MVP 验收。
