import type { Conversation, ManagedWorktree } from "@harnesshub/shared";
import { useEffect, useRef, useState } from "react";
import type { DesktopApi } from "../contracts";
import { Confirm } from "./Confirm";
import { call } from "./drafts";
import { Copy } from "./Markdown";
export function Worktrees({
  api,
  conversations,
  connected,
}: {
  api: DesktopApi;
  conversations: Conversation[];
  connected: boolean;
}) {
  const [rows, setRows] = useState<ManagedWorktree[]>([]);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<ManagedWorktree | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const lock = useRef(false);
  useEffect(() => {
    void revision; // Explicit refresh invalidation.
    if (!connected) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const result = await call<ManagedWorktree[]>(api, { type: "worktrees.list" });
        if (active) setRows(result);
      } catch (e) {
        if (active) setError(String(e));
      } finally {
        if (active) timer = setTimeout(() => void refresh(), 5000);
      }
    };
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [api, connected, revision]);
  const cleanup = async (row: ManagedWorktree) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setSelected(null);
    try {
      await call(api, { type: "worktrees.cleanup", worktreeId: row.id, confirmed: true });
    } catch (e) {
      setError(String(e));
    } finally {
      lock.current = false;
      setBusy(false);
      setRevision((n) => n + 1);
    }
  };
  return (
    <section className="managed-worktrees" aria-label="托管 Worktree">
      <h2>托管 Worktree</h2>
      {error && <p role="alert">{error}</p>}
      {!rows.length && <p>暂无托管 Worktree。新建项目会话时可选择独立 Worktree。</p>}
      {rows.map((row) => {
        const owners = conversations.filter(
          (c) =>
            c.worktreeId === row.id ||
            c.workspacePath === row.path ||
            c.workspacePath.startsWith(`${row.path}/`),
        );
        return (
          <article key={row.id} className="worktree-record">
            <strong>
              {row.branch} · {row.status}
            </strong>
            <p className="file-path">{row.path}</p>
            <Copy text={row.path} api={api} />
            <p>归属：{owners.map((c) => c.title).join("、") || "无绑定会话"}</p>
            <p className="subtle">Project · {row.projectId ?? "已删除"}</p>
            {row.error && <p>{row.error}</p>}
            <button
              type="button"
              disabled={
                !connected ||
                busy ||
                owners.length > 0 ||
                ["RETAINED", "REMOVED", "CREATING", "PRESERVING"].includes(row.status)
              }
              onClick={() => setSelected(row)}
            >
              安全保留式清理
            </button>
            {!!owners.length && <small>需先显式删除绑定会话；删除会话本身不删除 Worktree。</small>}
          </article>
        );
      })}
      {selected && (
        <Confirm
          title="确认保留式清理 Worktree？"
          label="确认保留式清理"
          disabled={busy || !connected}
          cancel={() => setSelected(null)}
          confirm={() => void cleanup(selected)}
        >
          <p>
            WSL 将检查归属、Git 状态及绑定会话。脏目录（含未跟踪和忽略文件）拒绝清理。不会使用
            force，不删除用户数据或 Git 分支。
          </p>
          <p>成功后状态为 RETAINED，目录移动并保留在：</p>
          <pre>
            {selected.ownerRoot}/retained/{selected.id}
          </pre>
          <p>保留分支：{selected.branch}</p>
          <p>清理不会回收磁盘空间。请先检查保留目录，再自行决定后续操作。</p>
        </Confirm>
      )}
    </section>
  );
}
