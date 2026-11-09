import type { Conversation, Project } from "@harnesshub/shared";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DesktopApi, DesktopRequest, DesktopState, Distribution } from "../contracts";
import { messages } from "./history";

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
  const [choice, setChoice] = useState("");
  const [error, setError] = useState("");
  const [discovering, setDiscovering] = useState(true);
  const [sidebar, setSidebar] = useState(true);
  const [width, setWidth] = useState(260);
  const [panel, setPanel] = useState<"details" | "debug" | null>(null);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [archived, setArchived] = useState(false);
  const [debugPage, setDebugPage] = useState(0);
  const history = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const accept = useCallback(
    (value: DesktopState) =>
      setState((previous) => (value.revision >= previous.revision ? value : previous)),
    [],
  );
  const request = async (input: DesktopRequest) => {
    setError("");
    try {
      const reply = await api.request(input);
      if (!reply.ok) {
        setError(reply.error);
        return;
      }
      accept(reply.state);
      if (reply.distributions) setDistros(reply.distributions);
    } catch {
      setError("Desktop 连接服务不可用，请重新打开窗口。");
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
  useEffect(() => {
    if (state.distribution) setChoice(state.distribution);
  }, [state.distribution]);
  const current = state.snapshot?.conversations.find((c) => c.id === state.conversationId);
  const rows = useMemo(() => messages(state.events), [state.events]);
  useEffect(() => {
    follow.current = state.conversationId !== null;
    setDebugPage(0);
  }, [state.conversationId]);
  useEffect(() => {
    if (rows.length && follow.current && history.current)
      history.current.scrollTop = history.current.scrollHeight;
  }, [rows]);
  const conversations =
    state.snapshot?.conversations.filter(
      (c) =>
        !!c.archivedAt === archived &&
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
    if (!project && !items.length) return null;
    if (query && !items.length) return null;
    return (
      <section className="project" key={id}>
        <div className="project-heading">
          <button
            type="button"
            className="project-toggle"
            aria-expanded={!collapsed.has(id)}
            onClick={() => toggleProject(id)}
            title={project?.rootPath}
          >
            <span aria-hidden="true">{collapsed.has(id) ? "›" : "⌄"}</span>
            <span>{project?.name ?? "独立会话"}</span>
            <small>{items.length}</small>
          </button>
          <button
            type="button"
            className="icon"
            disabled
            title="新建会话 · Desktop Phase 2"
            aria-label="新建会话"
          >
            ＋
          </button>
        </div>
        {!collapsed.has(id) && (
          <div className="conversation-list">
            {items.map((c) => (
              <ConversationItem
                key={c.id}
                value={c}
                active={c.id === state.conversationId}
                onSelect={() => {
                  void request({ type: "select", conversationId: c.id });
                }}
              />
            ))}
            {!items.length && <p className="subtle empty-group">暂无会话</p>}
          </div>
        )}
      </section>
    );
  };
  return (
    <div className="app" style={{ "--sidebar-width": `${width}px` } as CSSProperties}>
      <header className="topbar">
        <button
          type="button"
          className="icon"
          onClick={() => setSidebar(!sidebar)}
          aria-label={sidebar ? "隐藏侧边栏" : "显示侧边栏"}
        >
          ☰
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
      <div className={`workspace ${sidebar ? "" : "sidebar-hidden"} ${panel ? "panel-open" : ""}`}>
        {sidebar && (
          <>
            <aside className="sidebar" aria-label="项目与会话">
              <div className="environment">
                <label htmlFor="distribution">WSL 执行环境</label>
                <div className="distribution-row">
                  <select
                    id="distribution"
                    value={choice}
                    onChange={(event) => setChoice(event.target.value)}
                  >
                    <option value="">{discovering ? "正在发现…" : "选择 WSL2 发行版"}</option>
                    {distros.map((d) => (
                      <option key={d.name} value={d.name} disabled={d.version !== 2}>
                        {d.name} · WSL{d.version}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={!choice || state.status === "starting"}
                    onClick={() => {
                      void request({ type: "connect", distribution: choice });
                    }}
                  >
                    连接
                  </button>
                </div>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    void request({ type: "discover" });
                  }}
                >
                  刷新发行版
                </button>
              </div>
              <div className="search">
                <input
                  aria-label="搜索会话"
                  placeholder="搜索会话…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              <div className="tree-toolbar">
                <span>{archived ? "已归档" : "项目"}</span>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setArchived(!archived)}
                >
                  {archived ? "返回会话" : "查看归档"}
                </button>
              </div>
              <nav className="tree" aria-label="会话列表">
                {!state.snapshot ? (
                  <p className="subtle">
                    {state.status === "starting" ? "正在加载项目…" : "连接 WSL 后显示项目"}
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
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId))
                  setWidth(Math.max(220, Math.min(420, event.clientX)));
              }}
              onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
            />
          </>
        )}
        <main className="chat">
          <header className="conversation-header">
            <div>
              <h1>{current?.title ?? "你的工作，从这里继续"}</h1>
              <div className="conversation-meta">
                {current ? (
                  <>
                    <span>{current.selectedHarnessId ?? "尚未选择 Harness"}</span>
                    <span>{runtimeLabels[current.runtimeStatus] || "空闲"}</span>
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
              aria-expanded={!!panel}
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
          <div
            className="history"
            ref={history}
            onScroll={(event) => {
              const element = event.currentTarget;
              follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
            }}
          >
            {!current ? (
              <div className="welcome">
                <img className="welcome-mark" src="../assets/logo.png" alt="HarnessHub Logo" />
                <h2>继续你的项目</h2>
                <p>
                  在左侧选择 WSL2 环境和会话。
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
                    <p>此阶段提供只读预览，可在 WSL TUI 中继续对话。</p>
                  </div>
                )}
                {rows.map((row) => (
                  <article
                    key={row.id}
                    className={`message ${row.role === "You" ? "user-message" : "agent-message"} ${row.kind}`}
                  >
                    <div className="message-label">{row.role}</div>
                    <div className="message-body">{row.text}</div>
                  </article>
                ))}
              </div>
            )}
          </div>
          <div className="composer-area">
            <div className="composer">
              <textarea
                aria-label="消息输入（Phase 1 只读）"
                placeholder="Desktop Phase 1 · 只读预览，请在 WSL TUI 中继续对话"
                disabled
                rows={2}
              />
              <div className="composer-footer">
                <span>
                  {current?.selectedHarnessId ?? "Harness"}
                  <span className="subtle"> · 模型与推理选项将在交互阶段接入</span>
                </span>
                <button type="button" disabled aria-label="发送（Phase 2）">
                  ↑
                </button>
              </div>
            </div>
            <p className="composer-note">关闭窗口不会停止后台任务</p>
          </div>
        </main>
        {panel && (
          <aside className="work-panel" aria-label="工作面板">
            <header>
              <button
                type="button"
                aria-pressed={panel === "details"}
                onClick={() => setPanel("details")}
              >
                Details
              </button>
              <button type="button" disabled title="Desktop Phase 2">
                Changes
              </button>
              <button
                type="button"
                aria-pressed={panel === "debug"}
                onClick={() => setPanel("debug")}
              >
                Debug
              </button>
              <button
                type="button"
                className="icon"
                aria-label="关闭工作面板"
                onClick={() => setPanel(null)}
              >
                ×
              </button>
            </header>
            <div className="panel-content">
              {panel === "details" ? (
                <>
                  <h2>会话详情</h2>
                  <dl>
                    <dt>WSL 发行版</dt>
                    <dd>{state.distribution ?? "未选择"}</dd>
                    <dt>Linux Workspace</dt>
                    <dd>{current?.workspacePath ?? "未选择会话"}</dd>
                    <dt>工作区模式</dt>
                    <dd>{current?.workspaceMode ?? "—"}</dd>
                    <dt>执行状态</dt>
                    <dd>{current?.runtimeStatus ?? "—"}</dd>
                  </dl>
                  <p className="subtle">Changes、Diff、文件详情和 Handoff 报告将在后续阶段接入。</p>
                  <details>
                    <summary>会话管理</summary>
                    <div className="management-actions">
                      {["重命名", "归档", "恢复归档", "删除"].map((action) => (
                        <button type="button" key={action} disabled>
                          {action} · Phase 2
                        </button>
                      ))}
                    </div>
                  </details>
                </>
              ) : (
                <>
                  <h2>原始事件</h2>
                  <p className="subtle">仅用于调试；事件内容按纯文本显示。</p>
                  <div className="debug-nav">
                    <button
                      type="button"
                      disabled={debugPage === 0}
                      onClick={() => setDebugPage((value) => value - 1)}
                    >
                      上一组
                    </button>
                    <span>{debugPage + 1}</span>
                    <button
                      type="button"
                      disabled={(debugPage + 1) * 20 >= state.events.length}
                      onClick={() => setDebugPage((value) => value + 1)}
                    >
                      下一组
                    </button>
                  </div>
                  {state.events.slice(debugPage * 20, (debugPage + 1) * 20).map((event) => (
                    <details key={event.id}>
                      <summary>
                        #{event.seq} · {event.kind}
                      </summary>
                      <pre>{JSON.stringify(event, null, 2)}</pre>
                    </details>
                  ))}
                </>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
function ConversationItem({
  value,
  active,
  onSelect,
}: {
  value: Conversation;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`conversation-item ${active ? "selected" : ""}`}
      aria-current={active ? "page" : undefined}
      onClick={onSelect}
    >
      <span className="conversation-title">{value.title}</span>
      <span className="conversation-subtitle">
        <span>{value.selectedHarnessId ?? "未选择 Harness"}</span>
        <span className={`runtime ${value.runtimeStatus}`}>
          {runtimeLabels[value.runtimeStatus]}
        </span>
      </span>
    </button>
  );
}
