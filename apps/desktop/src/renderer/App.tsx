import type { Conversation, ConversationEvent, Project } from "@harnesshub/shared";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DesktopApi, DesktopRequest, DesktopState, Distribution } from "../contracts";
import { AppSettings } from "./AppSettings";
import { ArchiveDialog } from "./ArchiveDialog";
import { Composer } from "./Composer";
import { ConversationDialog, type ConversationDialogValue } from "./ConversationDialog";
import { call, DesktopDraft, newConversationDraft } from "./drafts";
import { DesktopTranscript } from "./history";
import { TranscriptView } from "./Message";
import { NewConversation, type NewConversationValue } from "./NewConversation";
import { WorkPanel } from "./WorkPanel";

declare global {
  interface Window {
    harnessHub: DesktopApi;
  }
}
const initial: DesktopState = {
  revision: -1,
  status: "idle",
  detail: "选择 WSL2 发行版以连接",
  distribution: null,
  snapshot: null,
  conversationId: null,
  events: [],
  historyLoading: false,
};
const states = {
  idle: "未连接",
  starting: "启动中",
  connected: "已连接",
  disconnected: "已断开",
  incompatible: "版本不兼容",
  error: "连接错误",
};
const runtimeLabels: Record<string, string> = {
  IDLE: "",
  PREPARING: "准备中",
  RUNNING: "执行中",
  WAITING_APPROVAL: "等待审批",
  CANCELLING: "取消中",
  ERROR: "失败",
  INTERRUPTED: "已中断",
  UNCERTAIN: "结果不确定",
};

export function App({ api = window.harnessHub }: { api?: DesktopApi }) {
  const [state, setState] = useState(initial);
  const [distros, setDistros] = useState<Distribution[]>([]);
  const [error, setError] = useState("");
  const [discovering, setDiscovering] = useState(true);
  const [settings, setSettings] = useState(false);
  const [width, setWidth] = useState(260);
  const sidebarDrag = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  const [panel, setPanel] = useState<"changes" | "diff" | "details" | "debug" | null>(null);
  const [panelWidth, setPanelWidth] = useState(400);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [archived, setArchived] = useState(false);
  const drafts = useRef(new Map<string, DesktopDraft>());
  const expanded = useRef(new Map<string, boolean>());
  const [dialog, setDialog] = useState<ConversationDialogValue | null>(null);
  const [newConversation, setNewConversation] = useState<NewConversationValue | null>(null);
  const creating = useRef(false);
  const [historyPage, setHistoryPage] = useState<number | null>(null);
  const history = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const accept = useCallback(
    (value: DesktopState) =>
      setState((previous) => {
        if (value.revision < previous.revision) return previous;
        const reset =
          value.distribution !== previous.distribution ||
          value.conversationId !== previous.conversationId ||
          value.historyVersion !== previous.historyVersion;
        const events = reset ? [] : previous.events;
        let cursor = events.at(-1)?.seq ?? 0;
        const batch = value.events.filter((event) => {
          if (event.seq <= cursor) return false;
          if (event.seq !== cursor + 1) return false; // Gap is repaired through typed history IPC below.
          cursor = event.seq;
          return true;
        });
        return { ...value, events: batch.length ? [...events, ...batch] : events };
      }),
    [],
  );
  const flushDrafts = async () => {
    await Promise.all([...drafts.current.values()].map((draft) => draft.flush()));
  };
  const request = async (input: DesktopRequest) => {
    setError("");
    try {
      if (creating.current && ["select", "connect", "reconnect"].includes(input.type))
        throw new Error("请等待新会话创建和消息提交完成。");
      if (["select", "connect"].includes(input.type)) {
        if (input.type === "connect" && [...drafts.current.values()].some((draft) => draft.busy))
          throw new Error("等待当前提交确认后再切换发行版。");
        await flushDrafts();
        if (input.type === "connect" && input.distribution !== state.distribution)
          drafts.current.clear();
      }
      const reply = await api.request(input);
      if (!reply.ok) {
        setError(reply.error);
        return false;
      }
      accept(reply.state);
      if (input.type === "select" || input.type === "connect") setNewConversation(null);
      if (reply.distributions) setDistros(reply.distributions);
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : "Desktop 连接服务不可用，请重新打开窗口。");
      return false;
    }
  };
  useEffect(() => {
    let active = true;
    const unsubscribe = api.subscribe((value) => {
      if (active) accept(value);
    });
    void api
      .request({ type: "state" })
      .then((reply) => {
        if (active && reply.ok) accept(reply.state);
      })
      .catch(() => {
        if (active) setError("无法读取连接状态。");
      });
    void api
      .request({ type: "discover" })
      .then((reply) => {
        if (!active) return;
        if (reply.ok) {
          accept(reply.state);
          setDistros(reply.distributions ?? []);
        } else setError(reply.error);
      })
      .catch(() => {
        if (active) setError("无法发现 WSL 发行版。");
      })
      .finally(() => {
        if (active) setDiscovering(false);
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api, accept]);
  const current = state.snapshot?.conversations.find((c) => c.id === state.conversationId);
  const projection = useMemo(
    () =>
      new DesktopTranscript(
        `${state.distribution}:${state.conversationId}:${state.historyVersion}`,
      ),
    [state.conversationId, state.distribution, state.historyVersion],
  );
  const rows = useMemo(() => {
    projection.append(state.events.slice(projection.cursor));
    return projection.rows.slice();
  }, [state.events, projection]);
  const visibleStart = historyPage ?? Math.max(0, rows.length - 100);
  const visibleRows = rows.slice(visibleStart, visibleStart + 100);
  useEffect(() => {
    if (state.status === "connected" && state.snapshot) {
      const ids = new Set(state.snapshot.conversations.map((c) => c.id));
      ids.add("desktop-new");
      for (const [key, editor] of drafts.current)
        if (!ids.has(editor.conversationId)) drafts.current.delete(key);
    }
  }, [state.status, state.snapshot]);
  const draftKey = `${state.distribution}:${current?.id}`;
  let draft = drafts.current.get(draftKey);
  if (current && !draft) {
    draft = new DesktopDraft(api, current.id);
    drafts.current.set(draftKey, draft);
  }
  const newDraftKey = `${state.distribution}:new`;
  let newDraft = drafts.current.get(newDraftKey);
  if (newConversation && !newDraft) {
    newDraft = newConversationDraft(api);
    drafts.current.set(newDraftKey, newDraft);
  }
  useEffect(() => {
    const id = state.conversationId;
    let active = true;
    const after = state.events.at(-1)?.seq ?? 0;
    if (!id || state.status !== "connected" || after >= (state.eventCursor ?? 0)) return;
    const version = state.historyVersion;
    void call<{ events: ConversationEvent[]; cursor: number }>(api, {
      type: "history",
      conversationId: id,
      after,
    })
      .then((page) => {
        if (!active) return;
        let seq = after;
        for (const event of page.events) {
          if (event.conversationId !== id || event.seq !== ++seq) throw new Error("历史事件不连续");
        }
        setState((previous) => {
          if (
            previous.conversationId !== id ||
            previous.historyVersion !== version ||
            (previous.events.at(-1)?.seq ?? 0) !== after
          )
            return previous;
          return { ...previous, events: [...previous.events, ...page.events] };
        });
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [
    api,
    state.conversationId,
    state.historyVersion,
    state.status,
    state.eventCursor,
    state.events,
  ]);
  useEffect(() => {
    let closing = false;
    const handler = (event: BeforeUnloadEvent) => {
      if (closing) return;
      event.preventDefault();
      event.returnValue = "";
      void Promise.all([...drafts.current.values()].map((editor) => editor.flush()))
        .then(() => {
          if ([...drafts.current.values()].some((editor) => editor.busy))
            throw new Error("正在提交消息，请等待请求确认再关闭。");
          if (creating.current) throw new Error("正在创建会话，请等待请求确认再关闭。");
          closing = true;
          return api.request({ type: "window.close" });
        })
        .catch((e) => setError(`关闭前草稿未保存：${String(e)}`));
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [api]);
  useEffect(() => {
    follow.current = state.conversationId !== null;
    setHistoryPage(null);
  }, [state.conversationId]);
  useEffect(() => {
    if (rows.length && follow.current && historyPage === null && history.current)
      history.current.scrollTop = history.current.scrollHeight;
  }, [rows, historyPage]);
  const conversations =
    state.snapshot?.conversations.filter(
      (c) =>
        c.archivedAt === null &&
        `${c.title} ${c.selectedHarnessId ?? ""}`.toLowerCase().includes(query.toLowerCase()),
    ) ?? [];
  const toggleProject = (id: string) =>
    setCollapsed((old) => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const group = (project: Project | null) => {
    const id = project?.id ?? "standalone";
    const items = conversations.filter((c) => c.projectId === (project?.id ?? null));

    if (!items.length && (query || !project)) return null;
    return (
      <section
        className={project ? "project" : "standalone-conversations"}
        key={id}
        aria-label={project ? undefined : "独立会话"}
      >
        {project && (
          <div className="project-heading">
            <button
              type="button"
              className="project-toggle"
              aria-expanded={!collapsed.has(id)}
              onClick={() => toggleProject(id)}
              title={project.rootPath}
            >
              <span aria-hidden="true">{collapsed.has(id) ? "›" : "⌄"}</span>
              <span>{project.name}</span>
              <small>{items.length}</small>
            </button>
            <button
              type="button"
              className="icon"
              disabled={state.status !== "connected"}
              onClick={() => {
                if (!creating.current)
                  setNewConversation({
                    projectId: project?.id ?? "",
                    workspace: current?.workspacePath ?? "",
                  });
              }}
              title="新建会话"
              aria-label="新建会话"
            >
              ＋
            </button>
          </div>
        )}
        {(!project || !collapsed.has(id)) && (
          <div className={project ? "conversation-list" : "standalone-list"}>
            {items.map((c) => (
              <ConversationItem
                key={c.id}
                value={c}
                active={!newConversation && c.id === state.conversationId}
                disabled={state.status !== "connected"}
                onSelect={() => {
                  void request({ type: "select", conversationId: c.id });
                }}
                rename={() => setDialog({ kind: "rename", conversation: c })}
                archive={() =>
                  void request({
                    type: "conversation.patch",
                    conversationId: c.id,
                    patch: { archived: !c.archivedAt },
                  })
                }
              />
            ))}
            {!items.length && <p className="subtle empty-group">暂无会话</p>}
          </div>
        )}
      </section>
    );
  };
  return (
    <div
      className="app"
      style={
        { "--sidebar-width": `${width}px`, "--panel-width": `${panelWidth}px` } as CSSProperties
      }
    >
      <header className="topbar">
        <button
          type="button"
          className="icon"
          onClick={() => setSettings(true)}
          aria-label="应用设置"
          aria-haspopup="dialog"
          title="应用设置"
        >
          ⚙
        </button>
        <img className="brand-logo" src="../assets/logo.png" alt="" />
        <strong>HarnessHub</strong>
        <span className="desktop-label">Desktop</span>
        <div className={`connection ${state.status}`} role="status">
          <span className="status-dot" />
          {states[state.status]}
        </div>
        <button
          type="button"
          onClick={() => {
            void request({ type: "reconnect" });
          }}
          disabled={!state.distribution}
        >
          重新连接
        </button>
      </header>
      {dialog && <ConversationDialog value={dialog} api={api} close={() => setDialog(null)} />}
      {archived && (
        <ArchiveDialog
          key={state.distribution}
          state={state}
          error={error}
          close={() => setArchived(false)}
          select={(conversationId) => request({ type: "select", conversationId })}
          restore={(conversationId) =>
            request({ type: "conversation.patch", conversationId, patch: { archived: false } })
          }
        />
      )}
      {settings && (
        <AppSettings
          api={api}
          state={state}
          distributions={distros}
          discovering={discovering}
          error={error}
          connect={(distribution) => void request({ type: "connect", distribution })}
          discover={() => void request({ type: "discover" })}
          close={() => setSettings(false)}
        />
      )}
      <div className={`workspace ${panel && current && !newConversation ? "panel-open" : ""}`}>
        <aside className="sidebar" aria-label="项目与会话">
          <div className="search">
            <button
              type="button"
              className="new-chat-button"
              disabled={state.status !== "connected"}
              onClick={() => {
                if (!creating.current)
                  setNewConversation({
                    projectId: current?.projectId ?? state.snapshot?.projects[0]?.id ?? "",
                    workspace: current?.workspacePath ?? "",
                  });
              }}
            >
              <span aria-hidden="true">＋</span> 新建会话
            </button>
            <input
              aria-label="搜索会话"
              placeholder="搜索会话…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="tree-toolbar">
            <span>项目</span>
            <button
              type="button"
              className="text-button"
              aria-haspopup="dialog"
              onClick={() => {
                setError("");
                setArchived(true);
              }}
            >
              查看归档
            </button>
          </div>
          <nav className="tree" aria-label="会话列表">
            {!state.snapshot ? (
              <p className="subtle">
                {state.status === "starting" ? "正在加载项目…" : "从左上角设置连接 WSL 后显示项目"}
              </p>
            ) : (
              <>
                {state.snapshot.projects.map(group)}
                {group(null)}
                {!state.snapshot.projects.length && !conversations.length && (
                  <p className="subtle">暂无项目或会话。可先在 WSL TUI 中创建。</p>
                )}
                {query && !conversations.length && <p className="subtle">没有匹配的会话</p>}
              </>
            )}
          </nav>
          <footer className="sidebar-footer">Agent 与历史保留在 WSL</footer>
        </aside>
        <hr
          aria-label="调整侧边栏宽度"
          aria-orientation="vertical"
          aria-valuemin={220}
          aria-valuemax={420}
          aria-valuenow={width}
          tabIndex={0}
          className="resize-handle"
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              setWidth((value) =>
                Math.min(420, Math.max(220, value + (event.key === "ArrowLeft" ? -10 : 10))),
              );
            }
          }}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            sidebarDrag.current = { pointerId: event.pointerId, x: event.clientX, width };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const drag = sidebarDrag.current;
            if (
              drag?.pointerId === event.pointerId &&
              event.currentTarget.hasPointerCapture(event.pointerId)
            )
              setWidth(Math.max(220, Math.min(420, drag.width + event.clientX - drag.x)));
          }}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onLostPointerCapture={() => {
            sidebarDrag.current = null;
          }}
        />
        <main className={`chat ${newConversation ? "chat-new" : ""}`}>
          <header className="conversation-header">
            <div>
              <h1>{newConversation ? "新建会话" : (current?.title ?? "你的工作，从这里继续")}</h1>
              <div className="conversation-meta">
                {newConversation ? null : current ? (
                  <>
                    <span>{current.selectedHarnessId ?? "尚未选择 Harness"}</span>
                    <span>{runtimeLabels[current.runtimeStatus] || "空闲"}</span>
                    <span>
                      {current.workspaceMode === "shared" ? "Shared Workspace" : "Git Worktree"}
                    </span>
                  </>
                ) : (
                  <span>选择一个会话，查看已有消息</span>
                )}
              </div>
            </div>
            <button
              type="button"
              className="icon"
              aria-label="切换工作面板"
              aria-expanded={!!panel && !!current && !newConversation}
              disabled={!current || !!newConversation}
              onClick={() => setPanel(panel ? null : "details")}
            >
              ◫
            </button>
          </header>
          {(error || state.status !== "connected") && (
            <div
              className={`banner ${error || state.status === "error" || state.status === "incompatible" ? "error" : ""}`}
              role={error ? "alert" : "status"}
            >
              {error || state.detail}
            </div>
          )}
          {state.status !== "connected" && (
            <button type="button" className="environment-help" onClick={() => setSettings(true)}>
              打开环境与安装指南
            </button>
          )}
          {newConversation && newDraft ? (
            <NewConversation
              key={state.distribution}
              api={api}
              state={state}
              value={newConversation}
              draft={newDraft}
              change={setNewConversation}
              busyChanged={(busy) => {
                creating.current = busy;
              }}
              created={async (conversation, editor) => {
                drafts.current.set(`${state.distribution}:${conversation.id}`, editor);
                const reply = await api.request({
                  type: "select",
                  conversationId: conversation.id,
                });
                if (!reply.ok) throw new Error(reply.error);
                accept(reply.state);
                setNewConversation(null);
              }}
            />
          ) : (
            <>
              <div className="history-container">
                <div
                  className="history"
                  ref={history}
                  onScroll={(event) => {
                    const element = event.currentTarget;
                    follow.current =
                      element.scrollHeight - element.scrollTop - element.clientHeight < 80;
                    if (!follow.current) setHistoryPage((value) => value ?? visibleStart);
                  }}
                >
                  {!current ? (
                    <div className="welcome">
                      <img
                        className="welcome-mark"
                        src="../assets/logo.png"
                        alt="HarnessHub Logo"
                      />
                      <h2>继续你的项目</h2>
                      <p>
                        通过左上角设置连接 WSL2 环境，再从左侧选择会话。
                        <br />
                        这里显示与 TUI 相同的消息历史。
                      </p>
                    </div>
                  ) : (
                    <div className="transcript">
                      {state.historyLoading && !rows.length && (
                        <p className="subtle" role="status">
                          正在读取历史…
                        </p>
                      )}
                      {!state.historyLoading && !rows.length && (
                        <div className="empty-chat">
                          <h2>还没有可显示的消息</h2>
                          <p>选择 Harness，发送第一条消息开始工作。</p>
                        </div>
                      )}
                      {visibleStart > 0 && (
                        <button
                          type="button"
                          onClick={() => {
                            follow.current = false;
                            setHistoryPage(Math.max(0, visibleStart - 100));
                            if (history.current) history.current.scrollTop = 0;
                          }}
                        >
                          查看较早消息（{visibleStart}）
                        </button>
                      )}
                      <TranscriptView
                        conversationId={current.id}
                        rows={visibleRows}
                        api={api}
                        expanded={expanded.current}
                      />
                      {historyPage !== null && visibleStart + 100 < rows.length && (
                        <div className="history-navigation">
                          <button
                            type="button"
                            onClick={() => {
                              setHistoryPage(visibleStart + 100);
                              if (history.current) history.current.scrollTop = 0;
                            }}
                          >
                            查看较新消息
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
                {current && historyPage !== null && (
                  <button
                    type="button"
                    className="jump-to-latest"
                    aria-label="回到最新消息"
                    title="回到最新消息"
                    onClick={() => {
                      follow.current = true;
                      setHistoryPage(null);
                      if (history.current) history.current.scrollTop = history.current.scrollHeight;
                    }}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M12 4v16m-7-7 7 7 7-7" />
                    </svg>
                  </button>
                )}
              </div>
              {current && draft ? (
                <Composer
                  key={draftKey}
                  api={api}
                  state={state}
                  conversation={current}
                  draft={draft}
                />
              ) : (
                <div className="composer-area">
                  <p className="composer-note">选择或新建会话开始聊天 · 关闭窗口不会停止后台任务</p>
                </div>
              )}
            </>
          )}
        </main>
        {panel && current && !newConversation && (
          <WorkPanel
            key={draftKey}
            api={api}
            conversation={current}
            connected={state.status === "connected"}
            tab={panel}
            selectTab={setPanel}
            close={() => setPanel(null)}
            resize={(value) => setPanelWidth(Math.max(300, Math.min(700, value)))}
            rename={() => setDialog({ kind: "rename", conversation: current })}
            archive={() =>
              void request({
                type: "conversation.patch",
                conversationId: current.id,
                patch: { archived: !current.archivedAt },
              })
            }
            remove={() => setDialog({ kind: "delete", conversation: current })}
            events={state.events}
            sessions={
              state.interaction?.conversationId === current.id ? state.interaction.sessions : []
            }
            handoffs={
              state.interaction?.conversationId === current.id ? state.interaction.handoffs : []
            }
          />
        )}
      </div>
    </div>
  );
}
export function ConversationItem({
  value,
  active,
  onSelect,
  rename,
  archive,
  disabled,
}: {
  value: Conversation;
  active: boolean;
  onSelect: () => void;
  rename: () => void;
  archive: () => void;
  disabled: boolean;
}) {
  return (
    <div className={`conversation-row ${active ? "selected" : ""}`}>
      <button
        type="button"
        className={`conversation-item ${active ? "selected" : ""}`}
        aria-current={active ? "page" : undefined}
        onClick={onSelect}
        disabled={disabled}
      >
        <span className="conversation-title">{value.title}</span>
        <span className="conversation-subtitle">
          <span>
            {value.projectId === null && <span className="standalone-label">独立会话</span>}
            {value.selectedHarnessId ?? "未选择 Harness"}
          </span>
          <span className={`runtime ${value.runtimeStatus}`}>
            {runtimeLabels[value.runtimeStatus]}
          </span>
        </span>
      </button>
      <div className="conversation-actions">
        <button
          type="button"
          aria-label={`重命名 ${value.title}`}
          title="重命名"
          disabled={disabled}
          onClick={rename}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="m4 13-1 4 4-1L17 6l-3-3L4 13Zm8-8 3 3" />
          </svg>
        </button>
        <button
          type="button"
          aria-label={`${value.archivedAt ? "恢复" : "归档"} ${value.title}`}
          title={value.archivedAt ? "恢复归档" : "归档"}
          disabled={disabled}
          onClick={archive}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M3 7h14v10H3V7Zm-1-4h16v4H2V3Zm6 7h4" />
          </svg>
        </button>
      </div>
    </div>
  );
}
