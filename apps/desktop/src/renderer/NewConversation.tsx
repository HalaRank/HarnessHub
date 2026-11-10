import type { Conversation, ProjectBranches } from "@harnesshub/shared";
import { useEffect, useRef, useState } from "react";
import type { DesktopApi, DesktopRequest, DesktopState } from "../contracts";
import { inputAction, slashIntent } from "./Composer";
import { Confirm } from "./Confirm";
import { call, DesktopActionError, DesktopDraft } from "./drafts";

export type NewConversationValue = { projectId: string; workspace: string };

export function NewConversation({
  api,
  state,
  value,
  change,
  created,
  busyChanged,
  draft,
}: {
  api: DesktopApi;
  state: DesktopState;
  value: NewConversationValue;
  change: (value: NewConversationValue) => void;
  created: (conversation: Conversation, draft: DesktopDraft) => Promise<void>;
  busyChanged: (busy: boolean) => void;
  draft: DesktopDraft;
}) {
  const [branches, setBranches] = useState<ProjectBranches | null>(null);
  const [branchError, setBranchError] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [worktree, setWorktree] = useState(false);
  const [, render] = useState(0);
  const text = draft.text;
  const [harness, setHarness] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [plain, setPlain] = useState(false);
  const [creationUnknown, setCreationUnknown] = useState(false);
  const lock = useRef(false);
  const composing = useRef(false);
  const compositionEnd = useRef(0);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const prepared = useRef<{
    conversation: Conversation;
    draft: DesktopDraft;
    submitted: boolean;
  } | null>(null);
  const project = state.snapshot?.projects.find((p) => p.id === value.projectId);
  const connected = state.status === "connected";
  const previousConversation =
    state.snapshot?.conversations.find(
      (c) => c.id === state.conversationId && c.selectedHarnessId,
    ) ??
    state.snapshot?.conversations
      .filter((c) => c.selectedHarnessId)
      .toSorted((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)[0];
  const previousHarness = state.profiles?.find(
    (p) => p.id === previousConversation?.selectedHarnessId,
  )?.id;
  const selectedHarness = harness || previousHarness || state.profiles?.[0]?.id || "";
  useEffect(() => {
    const unsubscribe = draft.subscribe(() => render((n) => n + 1));
    void draft.load().catch((e) => setError(String(e)));
    return () => {
      unsubscribe();
      draft.invalidateLoads();
    };
  }, [draft]);
  useEffect(() => {
    let active = true;
    setBranches(null);
    setBranchError("");
    setBaseBranch("");
    setWorktree(false);
    if (value.projectId && connected)
      void call<ProjectBranches>(api, { type: "project.branches", projectId: value.projectId })
        .then((result) => {
          if (!active) return;
          setBranches(result);
          setBaseBranch(result.currentBranch ?? "");
        })
        .catch((e) => {
          if (active) setBranchError(String(e));
        });
    return () => {
      active = false;
    };
  }, [api, value.projectId, connected]);
  useEffect(() => {
    if (draft.loaded) textarea.current?.focus();
  }, [draft.loaded]);
  const disabled =
    busy ||
    creationUnknown ||
    !draft.loaded ||
    !connected ||
    !text.trim() ||
    !selectedHarness ||
    (!!value.projectId && !project) ||
    (!project && !value.workspace.startsWith("/")) ||
    (worktree && !branches?.hasCommits);
  const submit = async (confirmedPlain = false) => {
    if (disabled || lock.current) return;
    if (!confirmedPlain && slashIntent(text, undefined).confirmText) {
      setPlain(true);
      return;
    }
    lock.current = true;
    setBusy(true);
    busyChanged(true);
    setError("");
    try {
      await draft.flush();
      if (!prepared.current) {
        const request: DesktopRequest = project
          ? {
              type: "conversation.create",
              projectId: project.id,
              workspaceMode: worktree ? "worktree" : "shared",
              ...(branches?.hasCommits && baseBranch ? { baseBranch } : {}),
            }
          : { type: "conversation.standalone", workspacePath: value.workspace };
        try {
          const conversation = await call<Conversation>(api, request);
          prepared.current = {
            conversation,
            draft: new DesktopDraft(api, conversation.id),
            submitted: false,
          };
        } catch (e) {
          if (!(e instanceof DesktopActionError && [400, 409].includes(e.status ?? 0))) {
            setCreationUnknown(true);
            throw new Error(`会话创建结果未确认，请先查看侧栏中的新会话。${String(e)}`);
          }
          throw e;
        }
      }
      const { conversation, draft: editor } = prepared.current;
      if (!prepared.current.submitted) {
        await editor.load();
        editor.update(text);
        await editor.flush();
        draft.update("");
        await draft.flush();
        prepared.current.submitted = true;
        // The real Conversation and its CAS draft exist before submitting any Turn.
        // Hand the editor to App even if the Turn result is uncertain.
        await editor.submit(selectedHarness);
      }
      await created(conversation, editor);
    } catch (e) {
      setError(String(e));
    } finally {
      lock.current = false;
      setBusy(false);
      busyChanged(false);
    }
  };
  return (
    <section className="new-conversation" aria-label="新建会话">
      <div className="welcome new-conversation-welcome">
        <img className="welcome-mark" src="../assets/logo.png" alt="HarnessHub Logo" />
        <h2>
          {project ? (
            <>
              你想在 <strong>{project.name}</strong> 中构建什么？
            </>
          ) : (
            "你想从哪里开始？"
          )}
        </h2>
      </div>
      <div className="composer-area">
        <div className="new-conversation-options">
          <label>
            <span>项目</span>
            <select
              aria-label="项目"
              value={value.projectId}
              disabled={busy || !!prepared.current}
              onChange={(e) => change({ ...value, projectId: e.target.value })}
            >
              {state.snapshot?.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
              <option value="">独立会话</option>
            </select>
          </label>
          {project && (
            <>
              <label>
                <span>{worktree ? "起始分支" : "分支"}</span>
                <select
                  aria-label="分支"
                  value={baseBranch}
                  disabled={busy || !!prepared.current || !branches?.hasCommits}
                  onChange={(e) => setBaseBranch(e.target.value)}
                >
                  {!branches ? (
                    <option value="">{branchError ? "读取失败" : "读取分支…"}</option>
                  ) : !branches.isGit ? (
                    <option value="">非 Git 项目</option>
                  ) : !branches.hasCommits ? (
                    <option value={baseBranch}>{baseBranch || "尚无提交"}</option>
                  ) : (
                    <>
                      {!branches.currentBranch && <option value="">当前 HEAD（游离）</option>}
                      {branches.branches.map((b) => (
                        <option key={b} value={b}>
                          {b}
                        </option>
                      ))}
                    </>
                  )}
                </select>
              </label>
              <label className="worktree-toggle">
                <input
                  type="checkbox"
                  role="switch"
                  aria-checked={worktree}
                  aria-label="创建工作树"
                  checked={worktree}
                  disabled={busy || !!prepared.current || !branches?.hasCommits}
                  onChange={(e) => setWorktree(e.target.checked)}
                />
                <span>创建工作树</span>
              </label>
            </>
          )}
        </div>
        {!project && (
          <label className="new-workspace">
            Linux 工作目录
            <input
              aria-label="Linux Workspace"
              placeholder="/home/…/project"
              value={value.workspace}
              disabled={busy || !!prepared.current}
              onChange={(e) => change({ ...value, workspace: e.target.value })}
            />
          </label>
        )}
        {!!value.projectId && !project && (
          <p className="composer-note error" role="alert">
            所选项目已不可用，请重新选择项目。
          </p>
        )}
        {branchError && (
          <p className="composer-note" role="status">
            {branchError}
          </p>
        )}
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <textarea
            ref={textarea}
            aria-label="消息输入"
            placeholder="描述你想完成的任务…"
            value={text}
            disabled={busy || !connected || !draft.loaded}
            rows={3}
            onChange={(e) => draft.update(e.target.value)}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
              compositionEnd.current = Date.now();
            }}
            onKeyDown={(e) => {
              if (
                inputAction(
                  {
                    key: e.key,
                    shiftKey: e.shiftKey,
                    isComposing: e.nativeEvent.isComposing,
                    keyCode: e.nativeEvent.keyCode,
                  },
                  composing.current || Date.now() - compositionEnd.current < 80,
                  false,
                ) === "send"
              ) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <div className="composer-footer">
            <select
              aria-label="Harness"
              value={selectedHarness}
              disabled={busy}
              onChange={(e) => setHarness(e.target.value)}
            >
              {!state.profiles?.length && <option value="">选择 Harness</option>}
              {state.profiles?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button type="submit" className="send" aria-label="发送消息" disabled={disabled}>
              {busy ? "创建中…" : "↑"}
            </button>
          </div>
        </form>
        {error && (
          <p className="composer-note error" role="alert">
            {error}
          </p>
        )}
        {draft.error && (
          <div className="composer-note error" role="alert">
            {draft.error}
            <button
              type="button"
              disabled={busy || !connected}
              onClick={() => {
                void draft.reload().catch((e) => setError(String(e)));
              }}
            >
              重新载入已保存草稿
            </button>
          </div>
        )}
        <p className="composer-note">
          {worktree
            ? "在所选分支的独立工作树中开始"
            : baseBranch && baseBranch !== branches?.currentBranch
              ? "首次发送时将共享目录切换到所选分支，会影响使用该目录的其他会话"
              : "共享目录中的并行任务可能修改同一文件"}
          {" · Enter 发送，Shift+Enter 换行"}
        </p>
      </div>
      {plain && (
        <Confirm
          title="作为普通文本发送？"
          label="作为普通文本发送"
          disabled={disabled}
          cancel={() => setPlain(false)}
          confirm={() => {
            setPlain(false);
            void submit(true);
          }}
        >
          <p>新会话尚未获取 ACP 命令。确认后将这条消息作为普通文本发送给 Agent。</p>
          <pre>{text}</pre>
        </Confirm>
      )}
    </section>
  );
}
