import { PROTOCOL_VERSION, VERSION } from "@harnesshub/shared";
import type { DesktopState } from "../contracts";

export function Environment({ state }: { state: DesktopState }) {
  const backend = state.backend;
  return (
    <details className="environment" open={state.status !== "connected"}>
      <summary>环境与安装指南 · Desktop {VERSION}</summary>
      <dl>
        <dt>Desktop / 协议</dt>
        <dd>
          {VERSION} / {PROTOCOL_VERSION}
        </dd>
        <dt>WSL 发行版 / 连接状态</dt>
        <dd>
          {state.distribution ?? "请选择左侧发行版"} / {state.status}
        </dd>
        <dt>Linux Bridge / 协议</dt>
        <dd>{backend ? `${backend.bridgeVersion} / ${backend.bridgeProtocol}` : "尚未确认"}</dd>
        <dt>Daemon / 协议</dt>
        <dd>
          {backend?.daemonVersion ?? "尚未确认"} / {backend?.daemonProtocol ?? "—"}
        </dd>
        <dt>instanceId（最近核验）</dt>
        <dd>{backend?.instanceId ?? "尚未确认"}</dd>
      </dl>
      {state.status === "incompatible" ? (
        <>
          <p>
            目标版本为 {VERSION}，协议 {PROTOCOL_VERSION}。Prompt 已禁用，后台任务未停止。Windows
            安装器不会更新 Linux 后端。
          </p>
          <p>
            {backend?.readiness
              ? backend.readiness.safeToStop
                ? "上次检查未发现危险操作；这不是停止许可，操作前须重新检查。"
                : `当前不可升级：${backend.readiness.blockers.join("、")}`
              : "无法确认后台是否空闲；禁止据此升级。旧 Bridge/Daemon 可能不支持预检，请使用其匹配版本查看任务。"}
          </p>
          <ol>
            <li>
              在所选 WSL 中，用正在运行版本的 hhu 查看并完成 Turn、审批和 Handoff，检查
              UNCERTAIN；不要强制取消。
            </li>
            <li>
              运行 <code>hhu daemon upgrade-check</code>。全部安全后显式运行{" "}
              <code>hhu daemon stop --for-upgrade</code>；拒绝或无法确认时停止升级。
            </li>
            <li>
              保留旧 release 与数据库备份，在目标版本的可信源码目录运行{" "}
              <code>bun run install:local</code>，然后点击“重新连接”。
            </li>
          </ol>
          <p>
            旧版没有 upgrade-check 时须使用旧版 TUI 核对所有任务，并正常停止；不要删锁文件或按旧 PID
            杀进程。迁移失败按发布指南恢复，不能直接覆盖 SQLite。
          </p>
        </>
      ) : (
        <ol>
          <li>
            PowerShell 用 <code>wsl --status</code> 和 <code>wsl --list --verbose</code> 检查
            WSL2；没有 WSL 时请自行按 Microsoft WSL 安装指南准备。应用不会安装系统组件。
          </li>
          <li>
            在左侧选择已用于开发的 WSL2 发行版并连接。已有 Codex、Claude、Grok、OpenCode
            登录和配置继续使用。
          </li>
          <li>
            若缺少 Bridge：在该发行版的可信 HarnessHub {VERSION} 源码目录，准备 Bun 1.4.4、Node
            24.18+（小于 25）后运行 <code>bun install --frozen-lockfile</code>、
            <code>bun run install:local</code>。已有后台必须先按安全升级流程处理。
          </li>
          <li>
            连接成功即显示已有项目和会话；关闭 App 保留 WSL 后台。WSL 停止或 Windows
            重启后的任务状态以真实恢复结果为准。
          </li>
        </ol>
      )}
      <p>
        卸载只移除 Windows App，保留 Windows 客户端设置、WSL 数据库、源码、Worktree 和原生 Agent
        凭据。完整步骤见随包 DESKTOP.md。
      </p>
    </details>
  );
}
