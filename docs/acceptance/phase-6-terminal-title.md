# Phase 6 补充验收：TUI 终端标题与全局运行指示

日期：2026-11-13。用户授权 VS Code 终端启动 `hhu` 后显示 `hhu`，有活动会话时在名称前显示轮转指示。本次只修改 TUI 标题呈现、测试和操作文档，不开启新阶段，不修改 ACP、Daemon、数据库结构、Agent 配置或用户 VS Code 配置。

## 实现与文件

- `apps/tui/src/terminal-title.ts`：空闲标题 `hhu`，活动时每 100 ms 轮转 `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`；重复相同状态不重启动画，停止后无持续刷新，dispose 后不再写标题，定时器不保活进程。
- `apps/tui/src/index.tsx`：复用全局 snapshot 的 activity 与既有 `activeStates`，不依赖选中会话、活动栏开关、项目展开或归档过滤；只有连接正常时显示活动。原生 OpenTUI `setTerminalTitle` 仅在真实 `openTui` 生命周期调用，renderer 销毁和异常退出时清理动画，不将终端控制写入内存测试渲染器。
- `tests/e2e/terminal-title.test.tsx`：两项假时钟测试验证空闲、轮转、循环、重复状态、停止、重启与销毁后的静默。
- `tests/e2e/terminal-title.py`：构建后 CLI 的真实 Linux PTY + 隔离 Daemon + Mock ACP 验证；保留 `terminal-output.bin` 作为原始终端标题证据。
- `scripts/test.ts`：将标题单元测试加入既有默认测试入口。
- `docs/OPERATIONS.md`：标题语义、VS Code 配置、手动重命名覆盖和全局入口升级边界。

## 实际执行与结果

```bash
bun run typecheck
bun run lint
bun run build
bun test tests/e2e/terminal-title.test.tsx tests/e2e/tui.test.tsx tests/e2e/ui-hierarchy.test.tsx
HARNESSHUB_BUN="$(command -v bun)" node --test --test-concurrency=1 tests/integration/phase3.test.mjs
python3 tests/e2e/terminal-title.py "$(command -v bun)" "$PWD/dist/cli/hhu.js"
git diff --check
```

- Typecheck、lint、build、diff whitespace 检查通过。
- Bun 回归 **15 pass / 0 fail**，191 次断言；包含已有原生审批、退出保活、工具折叠与草稿恢复回归。
- Phase 3 集成回归 **10 pass / 0 fail**；隔离证据 `/tmp/hhu-phase3-F6Bzla`。
- 真实 Linux PTY 通过：初始 `hhu`；选中空闲会话且隐藏活动栏时，另一项目的后台任务仍驱动动画；两个并行任务结束一个不停止；最后一个取消后恢复 `hhu` 并停止写标题；等待原生审批仍显示动画；取消审批后恢复；Daemon 断开停止动画；TUI 干净退出。最终证据 `/tmp/hhu-terminal-title-pty-htw1oboo/terminal-output.bin`。
- 首次 PTY 受沙箱本地网络限制，提权后在隔离数据目录执行。首次 UI 回归暴露内存 renderer 的 `InvalidPhase`，已将原生标题调用移动到真实终端生命周期，复跑通过。首次 PTY 断言观察起点晚于取消完成，已修正测试的采样起点，未修改产品状态或放宽断言。

## 官方依据与边界

已读取 [VS Code 官方终端外观文档源码](https://github.com/microsoft/vscode-docs/blob/main/docs/terminal/appearance.md) 的 Tab text：默认标题来自检测的进程名，`${sequence}` 读取进程发出的标题。本地 `@opentui/core` 锁定版本 0.8.0 的 `renderer.d.ts` 和实现提供 `setTerminalTitle`，直接复用，不增加依赖或自造 ACP 能力。

- 本实现是标题中的字符动画，不是 VS Code 原生进度图标；VS Code 默认 `${process}` 仍可能显示 `bun`，需要用户设置 `${sequence}`。
- **Windows Terminal / VS Code WSL 窗口实际显示未验证**；真实 PTY 的控制序列通过不代表 GUI 标签已经人工验收。
- 本轮不调用真实远端 Harness，不扩大兼容性结论；未执行整个 `bun run test`，仅执行上述针对性回归。
- 已构建仓库 `dist/cli/hhu.js`，**没有更新全局安装入口，没有停止默认 Daemon，没有修改默认用户数据库**。测试中的停止、取消和故障注入仅作用于隔离 Daemon 与 Mock。
- 用户此前已有的 `desktop-shared-branch.png`、`windows-evidence.json` 工作区改动保持不动。

## 用户手动验收

1. 先让真实活动任务完成，按 `docs/OPERATIONS.md` 的安全升级步骤安装本次构建；不要为刷新标题取消仍需执行的任务，也不要直接覆盖已安装发布。
2. 在 VS Code 用户设置 JSON 中设置 `"terminal.integrated.tabs.title": "${sequence}"`；该设置也会影响其他终端的标题来源。新建终端，避免旧的手动标签名覆盖。
3. 执行更新后的 `hhu`，确认空闲标题 `hhu`；发起会话后确认 `hhu` 前字符轮转，切换到其他项目或空闲会话后动画继续。
4. 有两个活动会话时结束一个，确认仍转动；最后一个正常结束或显式取消后恢复 `hhu`。等待审批时动画继续，但不会自动决定审批。
5. 关闭 TUI 后重新打开，确认后台任务没有因标题功能被停止，标题依实时 snapshot 恢复；对 Windows Terminal 重复验证。
