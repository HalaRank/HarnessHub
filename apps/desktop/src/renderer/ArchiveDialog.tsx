import { useEffect, useRef, useState } from "react";
import type { DesktopState } from "../contracts";

export function ArchiveDialog({
  state,
  error,
  select,
  restore,
  close,
}: {
  state: DesktopState;
  error: string;
  select: (conversationId: string) => Promise<boolean>;
  restore: (conversationId: string) => Promise<boolean>;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const locked = useRef(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const projects = new Map(state.snapshot?.projects.map((project) => [project.id, project]));
  const owner = (projectId: string | null) =>
    projectId === null ? "独立会话" : (projects.get(projectId)?.name ?? "原项目不可用");
  const archived = state.snapshot?.conversations.filter((c) => c.archivedAt !== null) ?? [];
  const search = query.trim().toLowerCase();
  const items = archived
    .filter((c) =>
      `${c.title} ${owner(c.projectId)} ${c.selectedHarnessId ?? ""}`
        .toLowerCase()
        .includes(search),
    )
    .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
  const act = async (id: string, open: boolean) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(id);
    try {
      const ok = await (open ? select(id) : restore(id));
      if (ok && open) close();
    } finally {
      locked.current = false;
      setBusy(null);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="archive-dialog"
      aria-label="归档会话"
      onCancel={(event) => {
        event.preventDefault();
        if (!locked.current) close();
      }}
    >
      <header className="archive-header">
        <h2>
          归档会话 <small>{archived.length}</small>
        </h2>
        <button
          type="button"
          className="icon"
          aria-label="关闭归档窗口"
          disabled={busy !== null}
          onClick={close}
        >
          ×
        </button>
      </header>
      <input
        aria-label="搜索归档会话"
        placeholder="搜索会话、项目或 Harness…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {error && <p role="alert">{error}</p>}
      {state.status !== "connected" && <p role="status">连接 WSL 后可查看和恢复归档会话。</p>}
      <ul className="archive-list" aria-label="归档会话列表">
        {items.map((conversation) => (
          <li key={conversation.id}>
            <button
              type="button"
              className="archive-open"
              aria-label={`查看归档 ${conversation.title}`}
              disabled={busy !== null || state.status !== "connected"}
              onClick={() => void act(conversation.id, true)}
            >
              <span className="archive-title">{conversation.title}</span>
              <span className="archive-meta">
                {owner(conversation.projectId)} ·{" "}
                {conversation.selectedHarnessId ?? "未选择 Harness"}
              </span>
            </button>
            <button
              type="button"
              aria-label={`恢复 ${conversation.title}`}
              title="恢复归档"
              disabled={busy !== null || state.status !== "connected"}
              onClick={() => void act(conversation.id, false)}
            >
              {busy === conversation.id ? "处理中…" : "恢复"}
            </button>
          </li>
        ))}
      </ul>
      {!items.length && <p className="subtle">{search ? "没有匹配的归档会话" : "暂无归档会话"}</p>}
    </dialog>
  );
}
