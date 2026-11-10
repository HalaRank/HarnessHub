import type { Conversation, GitChanges, GitFile, GitPatch } from "@harnesshub/shared";
import { useEffect, useRef, useState } from "react";
import type { DesktopApi } from "../contracts";
import { UnifiedDiff } from "./Diff";
import { call } from "./drafts";
import { PathActions } from "./PathActions";
export function gitStatus(file: GitFile) {
  const status = file.index + file.worktree;
  return status === "??"
    ? "Untracked"
    : status.includes("U")
      ? "Conflict"
      : status.includes("D")
        ? "Deleted"
        : status.includes("A")
          ? "Added"
          : status.includes("R")
            ? "Renamed"
            : "Modified";
}
export function Changes({
  api,
  conversation,
  connected,
  tab,
  selectTab,
}: {
  api: DesktopApi;
  conversation: Conversation;
  connected: boolean;
  tab: "changes" | "diff";
  selectTab: (tab: "changes" | "diff") => void;
}) {
  const [state, setState] = useState<GitChanges | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [patch, setPatch] = useState<GitPatch | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const lastManual = useRef(0);
  const [filePage, setFilePage] = useState(0);
  // One in-flight query, at most one automatic refresh each 3s. Closing unmounts this
  // reader, never Composer or runtime. Effect cleanup drops late conversation results.
  useEffect(() => {
    void refresh; // Explicit refresh invalidation.
    if (!connected) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      setBusy(true);
      try {
        const result = await call<GitChanges>(api, {
          type: "changes.list",
          conversationId: conversation.id,
        });
        if (active) {
          setState(result);
          setError("");
        }
      } catch (e) {
        if (active) setError(String(e));
      } finally {
        if (active) {
          setBusy(false);
          timer = setTimeout(() => void read(), 3000);
        }
      }
    };
    void read();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [api, conversation.id, connected, refresh]);
  useEffect(() => {
    if (!path || !connected || !state) return;
    let active = true;
    if (!state.files.some((f) => f.path === path)) {
      setPatch(null);
      return;
    }
    void call<GitPatch>(api, { type: "changes.diff", conversationId: conversation.id, path })
      .then((result) => {
        if (active) setPatch(result);
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [api, conversation.id, path, connected, state]);
  const currentFilePage = Math.min(
    filePage,
    Math.max(0, Math.ceil((state?.files.length ?? 0) / 100) - 1),
  );
  return (
    <section className="changes" aria-label="Workspace Git Changes">
      <div className="diff-heading">
        <h3>Workspace Git</h3>
        <button
          type="button"
          disabled={!connected || busy}
          onClick={() => {
            if (Date.now() - lastManual.current < 1500) return;
            lastManual.current = Date.now();
            setRefresh((n) => n + 1);
          }}
        >
          刷新
        </button>
      </div>
      <p className="changes-workspace file-path">{conversation.workspacePath}</p>
      <p className="panel-notice">
        {conversation.workspaceMode === "shared"
          ? "Shared Workspace · 并行修改可能冲突。"
          : "独立 Worktree。"}
        真实 Git 状态，不归属任何 Agent 或 Conversation。
      </p>
      {state && (
        <div className="changes-observation">
          <span>{state.files.length} 个变更文件</span>
          <span className="subtle">观测于 {new Date(state.observedAt).toLocaleTimeString()}</span>
        </div>
      )}
      {!state && !error && connected && (
        <p role="status" className="panel-empty">
          正在读取 Git 状态…
        </p>
      )}
      {!connected && <p role="status">连接已断开，显示最后观测结果。</p>}
      {error && <p role="alert">{error}</p>}
      {state && !state.repository && <p className="panel-empty">{state.notice}</p>}
      {state?.repository && !state.files.length && (
        <div className="panel-empty">
          <span className="empty-check" aria-hidden="true">
            ✓
          </span>
          <strong>工作区干净</strong>
          <p>当前没有 Git 变更。</p>
        </div>
      )}
      {tab === "changes" && (
        <>
          <div className="change-list">
            {state?.files.slice(currentFilePage * 100, currentFilePage * 100 + 100).map((file) => (
              <div key={file.path}>
                <button
                  type="button"
                  className="change-file"
                  title={file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}
                  onClick={() => {
                    setPatch(null);
                    setPath(file.path);
                    selectTab("diff");
                  }}
                >
                  <span className={`git-status ${gitStatus(file)}`} title={gitStatus(file)}>
                    {gitStatus(file) === "Untracked" ? "?" : gitStatus(file).slice(0, 1)}
                  </span>
                  <span className="change-file-name">
                    <span>{file.path.split("/").at(-1)}</span>
                    {file.path.includes("/") && (
                      <small>{file.path.slice(0, file.path.lastIndexOf("/"))}</small>
                    )}
                  </span>
                  <small className="git-raw-status" title="Git index / worktree status">
                    {file.index}
                    {file.worktree}
                  </small>
                  <span className="change-arrow" aria-hidden="true">
                    ›
                  </span>
                </button>
              </div>
            ))}
          </div>
          {(state?.files.length ?? 0) > 100 && (
            <div className="diff-pages">
              <button
                type="button"
                disabled={!currentFilePage}
                onClick={() => setFilePage(currentFilePage - 1)}
              >
                上一页文件
              </button>
              <button
                type="button"
                disabled={(currentFilePage + 1) * 100 >= (state?.files.length ?? 0)}
                onClick={() => setFilePage(currentFilePage + 1)}
              >
                下一页文件
              </button>
            </div>
          )}
        </>
      )}
      {tab === "diff" && (
        <>
          <button type="button" onClick={() => selectTab("changes")}>
            ‹ 返回文件列表
          </button>
          {!path ? (
            <div className="panel-empty">
              <strong>选择文件查看 Diff</strong>
              <p>在 Changes 中选择一个变更文件。</p>
            </div>
          ) : (
            <>
              <h3 className="file-path">{path}</h3>
              <PathActions
                api={api}
                conversationId={conversation.id}
                path={`${state?.repository}/${path}`}
                location={{ kind: "change", path }}
              />
              {!state?.files.some((f) => f.path === path) && <p>该文件已不在当前 Git 状态中。</p>}
              {!patch && state?.files.some((f) => f.path === path) && !error && (
                <p>正在读取文件 Diff…</p>
              )}
              {patch && (
                <p className="subtle">
                  Diff 观测 {new Date(patch.observedAt).toLocaleTimeString()} · Git 读取非原子快照
                </p>
              )}
              {patch &&
                (["staged", "unstaged", "untracked"] as const).map(
                  (kind) =>
                    patch[kind] && (
                      <UnifiedDiff
                        key={`${path}:${kind}`}
                        text={patch[kind]}
                        path={path}
                        api={api}
                        source={`Workspace Git Diff · ${kind}`}
                      />
                    ),
                )}
              {patch && !patch.staged && !patch.unstaged && !patch.untracked && (
                <p>没有文本 Diff（可能是状态变化、冲突或子模块）。</p>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
