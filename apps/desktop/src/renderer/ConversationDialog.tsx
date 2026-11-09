import type { Conversation } from "@harnesshub/shared";
import { useEffect, useRef, useState } from "react";
import type { DesktopApi, DesktopRequest } from "../contracts";
import { call } from "./drafts";
export type ConversationDialogValue =
  | { kind: "create"; projectId?: string; workspace?: string | undefined }
  | { kind: "rename"; conversation: Conversation }
  | { kind: "delete"; conversation: Conversation };
export function ConversationDialog({
  value,
  api,
  close,
  created,
}: {
  value: ConversationDialogValue;
  api: DesktopApi;
  close: () => void;
  created: (id: string) => void;
}) {
  const [title, setTitle] = useState(
    value.kind === "rename" ? value.conversation.title : "New conversation",
  );
  const [workspace, setWorkspace] = useState(
    value.kind === "create" ? (value.workspace ?? "") : "",
  );
  const [workspaceMode, setWorkspaceMode] = useState<"shared" | "worktree">("shared");
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const submit = async () => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    const request: DesktopRequest =
      value.kind === "delete"
        ? { type: "conversation.delete", conversationId: value.conversation.id, confirmed: true }
        : value.kind === "rename"
          ? { type: "conversation.patch", conversationId: value.conversation.id, patch: { title } }
          : value.projectId
            ? { type: "conversation.create", projectId: value.projectId, title, workspaceMode }
            : { type: "conversation.standalone", workspacePath: workspace, title };
    try {
      const result = await call<Conversation>(api, request);
      if (value.kind === "create") created(result.id);
      close();
    } catch (e) {
      setError(String(e));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
      aria-label="会话管理"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2>
          {value.kind === "create"
            ? "新建 Conversation"
            : value.kind === "rename"
              ? "重命名 Conversation"
              : "确认删除 Conversation"}
        </h2>
        {value.kind === "delete" ? (
          <p>
            删除「{value.conversation.title}」的应用历史和草稿，并取消其运行任务、关闭所属
            Worker。不删除项目源码、Git 分支或 Worktree。执行结果 UNCERTAIN 不会因此变为已确认。
          </p>
        ) : (
          <label>
            名称
            <input
              aria-label="会话名称"
              value={title}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
        )}
        {value.kind === "create" && value.projectId && (
          <label>
            工作区模式
            <select
              aria-label="工作区模式"
              value={workspaceMode}
              onChange={(e) => setWorkspaceMode(e.target.value as "shared" | "worktree")}
            >
              <option value="shared">Shared Workspace · 共享项目目录</option>
              <option value="worktree">独立 Git Worktree · 从 HEAD 创建</option>
            </select>
            <small>
              {workspaceMode === "shared"
                ? "并行 Agent 可修改同一文件，请注意冲突。"
                : "由 WSL 管理分支与目录；删除会话不会删除源码、Worktree 或分支。"}
            </small>
          </label>
        )}
        {value.kind === "create" && !value.projectId && (
          <label>
            独立会话的 Linux Workspace
            <input
              aria-label="Linux Workspace"
              placeholder="/home/…/project"
              value={workspace}
              onChange={(e) => setWorkspace(e.target.value)}
            />
            <small>使用此 WSL 发行版内已存在的绝对目录。</small>
          </label>
        )}
        {error && <p role="alert">{error}</p>}
        <footer>
          <button type="button" disabled={busy} onClick={close}>
            取消
          </button>
          <button
            type="submit"
            disabled={
              busy ||
              (value.kind !== "delete" && !title.trim()) ||
              (value.kind === "create" && !value.projectId && !workspace.startsWith("/"))
            }
          >
            {busy ? "处理中…" : value.kind === "delete" ? "确认删除" : "保存"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
