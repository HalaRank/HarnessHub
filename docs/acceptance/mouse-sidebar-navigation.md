# HarnessHub v0.6.1：侧边栏鼠标导航验收

日期：2026-11-01。独立 TUI 优化，未开启新阶段。继续使用 Bun 1.4.4、OpenTUI / Solid 0.8.0、既有 Daemon、SQLite、ACP 与草稿 CAS；不增加依赖、数据库字段或后端接口。

## 最终交互

- 单击 Project 名称：选中项目、展开或收起其会话，主区域显示该 Project root 的真实目录树。此行为按用户后续补充要求实现。点击目录树中的文件夹可逐层展开/收起，文件不打开、不修改；符号链接显示 `@`，不作为文件夹展开。读取失败展示错误，不创建缺失目录。
- 单击 Project 左侧箭头：只切换该项目的展开状态，不切换正在查看的 Conversation。项目展开状态按 Project ID 独立保存在运行期内存。
- 单击 Conversation：立即按 Conversation ID 切换到其聊天区。当前会话背景高亮，悬停使用较浅背景；主动用箭头收起当前会话所属项目时，项目行显示活动背景。
- Conversation 右侧 `⋯` 打开该会话的归档/恢复/删除菜单，操作非当前会话不会选中旁边的会话。归档、恢复和删除继续调用已有生命周期操作与当前删除确认组件；不跳过服务端活动任务保护，不删除用户目录或分支。
- 原有上下键、命令面板和快速跳转继续可用。命令面板能搜索已折叠项目内的会话，并展开目标项目，不收起其他项目。
- 侧栏使用独立 ScrollBox，滚轮不改变聊天位置；后台快照更新不把侧栏强制滚回当前会话。长标题为右侧操作入口保留固定宽度，活动状态放在标题前，避免待审批状态被长标题挤掉。
- 窄于 90 列自动隐藏侧栏后，Ctrl+B（或用户配置的原快捷键）可重新打开/关闭。展开状态、完整滚动及焦点快照不写入 SQLite。

## 实现及边界

| 文件 | 说明 |
| --- | --- |
| `apps/tui/src/index.tsx` | 按稳定 ID 选择；完整搜索列表与可见树分开；独立展开状态；窄屏手动打开；会话操作菜单和项目目录视图接线 |
| `apps/tui/src/project-tree.tsx` | 树形行、独立滚动、高亮、固定宽度操作入口及左键按下/松开手势；不使用不存在的合成 click |
| `apps/tui/src/project-directory.tsx` | 本地只读 `readdir`，按需读取子目录，目录优先排序，错误提示；不调用 Agent |
| `apps/tui/src/delete-confirmation.tsx` | 复用工作区已有确认组件，鼠标使用相同的按下/松开判定；按钮文字不启动原生选区 |
| `tests/e2e/mouse-sidebar.test.tsx` | 6 项真实 Solid/OpenTUI renderer + 隔离 Daemon/SQLite/Mock ACP 交互测试 |
| `scripts/test.ts` | 将新增测试纳入标准 test 命令，保留工作区已有测试入口 |
| `tests/e2e/phase4.test.tsx` | 为项目删除回归补充具体超时标签/失败画面，不放宽结果断言 |
| `tests/integration/phase5.test.mjs` | Worktree 删除回归等待 Handoff 源 Worker 真正 CLOSED；不将 Turn 完成当作清理完成，不绕过删除保护 |

读取的 OpenTUI 鼠标契约来自锁定版本的 `@opentui/core/Renderable.d.ts`、`renderer.d.ts`、`renderables/ScrollBox.d.ts` 及其实际事件分发实现。左键在同一目标、同一终端单元格松开才激活；右键、拖动、跨行释放和聊天选区释放不导航。专门处理 OpenTUI 在新目标按下后才发送旧目标 hover-out 的情况，避免旧 hover-out 取消新的合法点击。

聊天复制继续使用原生 selection 完成事件与既有 Clipboard Service。侧栏文字不参与选区，不改写聊天正文、原生工具名和原始事件。切换仍复用 DraftSession 的离开保存、返回前等待 CAS 保存、未确认 requestId 预留及按 Conversation ID 缓存的 ViewState；不创建 Prompt、不取消活动 Turn、不修改审批、Harness/Handoff 或 Worktree。

工作区同时存在独立的删除/归档与项目配色修改。本项在其当前实现上接线并验证，保留它们；这些后端修改不作为本项新增功能申报，也没有扩大本项后端范围。

## 自动化验收覆盖

| 验收项 | 验证方式及结果 |
| --- | --- |
| Project 展开/收起及项目主视图 | 项目名重复点击、箭头点击、真实目录/文件/子目录/符号链接、不可用根目录；通过 |
| Conversation 内容切换 | 真实会话标题、草稿和原生聊天内容；通过 |
| 不同 Project 展开独立 | 两项目交错展开/收起、跨折叠项目命令跳转；通过 |
| 当前及悬停高亮 | 实际 renderer 行背景 RGBA、移出后恢复；通过 |
| 大量会话滚轮 | 60 个会话，滚轮改变侧栏偏移、聊天偏移不变；重命名快照不重置偏移，末尾会话可点击；通过 |
| 归档/恢复/删除选择 | 非当前行操作保持当前 ID；当前消失后回到所属 Project，取消删除保留数据，确认后移除指定 ID；通过 |
| 后台 Agent | Mock ACP 为真实子进程，导航后 NativeSession ID 不变、原 Turn 未结束、无额外 Prompt 或 cancel；通过 |
| 草稿/滚动/工具展开 | 正在编辑时点击切换，多行中文草稿恢复、原滚动偏移和手动工具展开恢复；通过 |
| 导航与复制冲突 | 侧栏单击/拖动不复制；聊天拖到侧栏不切换；聊天松开自动复制捕获；通过 |
| 键盘与 Ctrl+C | 原上下键、配置快捷键、命令搜索；选区优先复制、其次清空输入、再次退出；原 Enter/Shift+Enter/Ctrl+J 回归；通过 |

新增鼠标测试独立运行：6 pass / 0 fail。修复鼠标手势后的 Phase 4 + 新测试联合回归：28 pass / 0 fail，日志 `/tmp/hhu-mouse-ui-fixed.log`。

最终标准检查全部通过：

| 检查 | 最终结果 |
| --- | --- |
| `bun run typecheck` | 通过（含 Daemon 独立 tsconfig） |
| `bun run lint` | 通过，80 个文件，无诊断 |
| `bun run build` | 通过，CLI / TUI 与 Node Daemon 构建完成 |
| `bun run test` | **83 项 Node 集成 + 40 项 Bun/Solid 界面，共 123 项，0 失败**；退出码 0 |
| `git diff --check` | 通过 |

完整最终测试日志：`/tmp/hhu-mouse-final.log`。新增测试本轮证据目录：`/tmp/hhu-mouse-sidebar-Y72ivf`。其中包含的独立删除功能回归也运行通过，但不计作本项新增后端实现。

执行命令：

```bash
bun run typecheck
bun run lint
bun run build
bun run test
git diff --check
```

开发中的失败保留：最初测试等待了不可见的历史内容或尚未完成的加载，已改为等待真实加载/完成状态；长标题挤掉操作入口与旧 hover-out 取消新点击属于实际交互问题，已修正。首轮完整测试在 Worktree 删除回归遇到 `409 Wait for Handoff Worker cleanup before deleting Conversation`，现测试等待源 Session 明确 CLOSED，未修改 Runtime 或跳过安全保护。原日志 `/tmp/hhu-mouse-full.log` 保留，不能作为全通过证据。

## 真实 Linux PTY

使用隔离 XDG、临时项目，从 Home 运行构建后的 CLI，通过实际终端 SGR 鼠标字节点击，不依赖 test renderer。已验证会话切换、项目名折叠/展开与真实目录显示、离开和返回恢复草稿、Ctrl+C 清空/退出、退出后原 Daemon 存活、两个会话零 Prompt。脚本 `/tmp/hhu-mouse-pty.py`，最终日志 `/tmp/hhu-mouse-pty-final.log`；最终私有证据目录 `/tmp/hhu-mouse-pty-31ngwiyp`，包含捕获的终端输出；所有检查均为 true。

此处没有执行新的真实 Codex / Claude / Grok / OpenCode 任务。后台 Worker 连续性由真实 Daemon + Mock ACP 子进程验证，不声称替代真实提供商人工验收。

## Windows Terminal / VS Code WSL 待人工验收

**物理鼠标、系统剪贴板实际接收与物理 Shift+Enter：未验证。** 当前环境无法直接操纵这两个 GUI 终端。Linux PTY、OpenTUI renderer 和 OSC52 捕获不代表目标终端已验收。请分别记录 Windows Terminal 版本、VS Code/WSL 版本、终端尺寸、字体、鼠标跟踪是否启用及下列实际结果：

1. 使用当前构建打开 `hhu`，准备两个 Project、多个 Conversation。反复单击项目名，应每次展开/收起且主区域显示正确项目目录；箭头应只切换展开状态；展开目录中的文件夹，核对实际文件名。
2. 在不同 Project 间单击会话，核对聊天、当前背景及 hover 反馈；展开一个项目不应收起其他项目。长标题及归档标题的 `⋯` 仍可点。
3. 准备至少 60 个会话或足够长的列表，在侧栏顶部/中部/底部滚轮，聊天位置应保持不变；在聊天区滚轮时侧栏不动。点击滚动后的会话，确认目标正确。
4. 输入中文多行草稿，不按 Esc，直接点击另一会话，再返回；核对两个草稿、聊天滚动位置及手动展开工具。运行真实无害任务时反复导航，任务应继续，审批不得自动决策。
5. 从 `⋯` 归档、查看归档并恢复；先取消删除、再明确确认删除；检查选中对象正确、项目文件与 Worktree/分支仍在。活动/待审批/UNCERTAIN 会话继续拒绝删除。
6. 拖选聊天、代码与工具输出并松开，粘贴到系统编辑器核对内容；拖选跨到侧栏不得切换会话。在侧栏拖动、右键、按下后移出再松开，不得切换或误发送。
7. Ctrl+C 有选区时只复制，无选区有草稿时只清空，空输入时才退出；连续操作并检查 TUI 退出后后台任务存活。核对终端是否拦截 Ctrl+C / OSC52，不能仅凭提示认定剪贴板已接收。
8. Enter 只提交一次，物理 Shift+Enter 只换行；必要时核对 Ctrl+J 备用键。验证上下键、命令面板、跨项目快速跳转，以及用户自定义的快捷键。
9. 缩到 72 列：侧栏自动隐藏；Ctrl+B/已配置的侧栏快捷键可以重新打开并点击，再按可关闭。放宽终端后布局应恢复。

目录树为当前 TUI 运行期按需读取的只读列表，没有文件监听；离开该项目视图再返回可重新读取根目录。展开状态、滚动和工具状态仅在当前 TUI 生命周期保留，草稿及最近选择继续沿用已有 SQLite 持久化。
