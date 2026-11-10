# Desktop Phase 4 补充验收 — 返回最新消息箭头

日期：2026-11-10。

按用户参考图，将“回到最新消息”改为 36 × 36px 的圆形向下箭头，细边框、深色背景，固定在消息区底部居中，距底部 12px。移除原横向背景条与可见按钮文字，保留同名无障碍标签和悬停提示。“查看较新消息”仍可分页；箭头点击后回到最新页和底部，并恢复新消息跟随。

## 文件

- `apps/desktop/src/renderer/App.tsx`：独立消息滚动容器和 SVG 箭头，沿用原返回逻辑。
- `apps/desktop/src/renderer/style.css`：圆形按钮、定位与箭头描边，移除分页导航背景条。
- `docs/acceptance/evidence/desktop-jump-to-latest/browser-interactions.json`：隔离 Chromium DOM 验证记录。

## 验证

- `bun run desktop:test`：后端与 Desktop 构建、61 项单元测试、16 项 Node 集成测试通过。
- `bun run typecheck`：通过。`bun run lint`：退出 0，另有并行工作面板样式的 2 条选择器优先级警告。初次检查遇到并行改动尚未收尾的 `Changes.tsx` 类型与无障碍错误，后续重跑已通过。
- 隔离 Chromium 加载构建 Renderer，使用 Mock Desktop API 和 130 条历史消息：验证圆形尺寸、居中位置、无可见文字、较早页返回最新、按钮隐藏、新消息恢复跟随、窄窗口保持尺寸，均通过。
- 浏览器首次启动因缺少 `libnspr4.so` 失败，补用已有 `/tmp/chromium-libs/usr/lib/x86_64-linux-gnu` 动态库路径后 DOM 验证通过。截图因当前 Chromium 渲染超时未生成，不作为视觉验收通过。
- `git diff --check`：通过。

本轮仓库有并行工作面板修改，保留其内容；本记录只覆盖返回最新消息箭头。Windows Electron 实机与物理鼠标视觉验收未验证，也未打包或安装新版本。手动验收：打开长会话并向上滚动，确认输入区上方只出现小圆形箭头；点击后回到底部，新消息继续跟随。
