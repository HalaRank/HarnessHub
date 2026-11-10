import type { Conversation, ConversationEvent, Handoff, NativeSession } from "@harnesshub/shared";
import { useRef, useState } from "react";
import type { DesktopApi } from "../contracts";
import { Changes } from "./Changes";
import { Handoffs } from "./Handoffs";
import { PathActions } from "./PathActions";

export type WorkPanelTab = "details" | "changes" | "diff" | "debug";
const tabs: { id: WorkPanelTab; label: string }[] = [
  { id: "details", label: "Details" },
  { id: "changes", label: "Changes" },
  { id: "diff", label: "Diff" },
  { id: "debug", label: "Debug" },
];

export function WorkPanel({
  api,
  conversation,
  connected,
  tab,
  selectTab,
  close,
  resize,
  rename,
  archive,
  remove,
  events,
  sessions,
  handoffs,
}: {
  api: DesktopApi;
  conversation: Conversation;
  connected: boolean;
  tab: WorkPanelTab;
  selectTab: (tab: WorkPanelTab) => void;
  close: () => void;
  resize: (width: number) => void;
  rename: () => void;
  archive: () => void;
  remove: () => void;
  events: ConversationEvent[];
  sessions: NativeSession[];
  handoffs: Handoff[];
}) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const [debugPage, setDebugPage] = useState(0);
  const page = Math.min(debugPage, Math.max(0, Math.ceil(events.length / 20) - 1));
  const status = conversation.runtimeStatus;
  return (
    <aside className="work-panel" aria-label="工作面板">
      <hr
        className="panel-resize"
        aria-label="调整工作面板宽度"
        aria-orientation="vertical"
        tabIndex={0}
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
          event.preventDefault();
          const width = event.currentTarget.parentElement?.getBoundingClientRect().width ?? 400;
          resize(width + (event.key === "ArrowLeft" ? 20 : -20));
        }}
        onPointerDown={(event) => {
          event.preventDefault();
          drag.current = {
            x: event.clientX,
            width: event.currentTarget.parentElement?.getBoundingClientRect().width ?? 400,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (drag.current && event.currentTarget.hasPointerCapture(event.pointerId))
            resize(drag.current.width + drag.current.x - event.clientX);
        }}
        onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
      />
      <header className="work-panel-header">
        <div className="panel-heading">
          <div className="panel-heading-text">
            <span className="panel-eyebrow">当前会话</span>
            <h2 title={conversation.title}>{conversation.title}</h2>
          </div>
          <button type="button" className="icon" aria-label="关闭工作面板" onClick={close}>
            ×
          </button>
        </div>
        <nav className="panel-tabs" aria-label="工作面板视图">
          {tabs.map(({ id, label }) => (
            <button
              type="button"
              key={id}
              aria-pressed={tab === id}
              aria-controls="work-panel-content"
              onClick={() => selectTab(id)}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>
      <div className="panel-content" id="work-panel-content">
        {tab === "changes" || tab === "diff" ? (
          <Changes
            api={api}
            conversation={conversation}
            connected={connected}
            tab={tab}
            selectTab={selectTab}
          />
        ) : tab === "details" ? (
          <div className="conversation-details">
            <section className="panel-section" aria-label="会话详情">
              <div className="panel-section-heading">
                <h3>会话概览</h3>
                <span className={`panel-runtime ${status}`}>
                  <span aria-hidden="true" />
                  {status}
                </span>
              </div>
              <dl className="panel-facts">
                <div>
                  <dt>Harness</dt>
                  <dd>{conversation.selectedHarnessId ?? "尚未选择"}</dd>
                </div>
                <div>
                  <dt>工作区模式</dt>
                  <dd>{conversation.workspaceMode === "shared" ? "共享目录" : "独立 Worktree"}</dd>
                </div>
              </dl>
              {!connected && <p className="panel-notice">连接已断开，显示最后收到的会话状态。</p>}
            </section>
            <section className="panel-section" aria-label="Linux Workspace">
              <div className="panel-section-heading">
                <h3>Workspace</h3>
                <span className="panel-eyebrow">Linux</span>
              </div>
              <div className="workspace-location">
                <code>{conversation.workspacePath}</code>
                <PathActions
                  api={api}
                  conversationId={conversation.id}
                  path={conversation.workspacePath}
                  location={{ kind: "workspace" }}
                />
              </div>
              {conversation.workspaceMode === "shared" && (
                <p className="panel-notice">
                  共享目录允许并行 Agent 修改，注意文件冲突。Git 变更不推断归属。
                </p>
              )}
            </section>
            <Handoffs
              api={api}
              conversation={conversation}
              connected={connected}
              handoffs={handoffs}
              sessions={sessions}
            />
            <details className="panel-management">
              <summary>会话管理</summary>
              <div className="management-actions">
                <button type="button" disabled={!connected} onClick={rename}>
                  重命名
                </button>
                <button type="button" disabled={!connected} onClick={archive}>
                  {conversation.archivedAt ? "恢复归档" : "归档"}
                </button>
                <button type="button" className="danger" disabled={!connected} onClick={remove}>
                  删除
                </button>
              </div>
            </details>
          </div>
        ) : (
          <section className="panel-debug" aria-label="原始事件">
            <div className="panel-section-heading">
              <h3>原始事件</h3>
              <span className="panel-count">{events.length}</span>
            </div>
            <p className="subtle">原生事件按纯文本展示，展开查看完整内容。</p>
            {!events.length ? (
              <div className="panel-empty">
                <strong>暂无原始事件</strong>
                <p>当前会话收到事件后会显示在这里。</p>
              </div>
            ) : (
              <>
                <div className="debug-nav">
                  <button
                    type="button"
                    disabled={page === 0}
                    onClick={() => setDebugPage(page - 1)}
                  >
                    上一组
                  </button>
                  <span>
                    {page + 1} / {Math.ceil(events.length / 20)}
                  </span>
                  <button
                    type="button"
                    disabled={(page + 1) * 20 >= events.length}
                    onClick={() => setDebugPage(page + 1)}
                  >
                    下一组
                  </button>
                </div>
                <div className="debug-events">
                  {events.slice(page * 20, (page + 1) * 20).map((event) => (
                    <details key={event.id}>
                      <summary>
                        <span className="event-seq">#{event.seq}</span> {event.kind}
                      </summary>
                      <pre>{JSON.stringify(event, null, 2)}</pre>
                    </details>
                  ))}
                </div>
              </>
            )}
          </section>
        )}
      </div>
    </aside>
  );
}
