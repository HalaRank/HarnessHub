import { object, pretty } from "@harnesshub/shared/event-projection";
import { memo, useState } from "react";
import type { DesktopApi } from "../contracts";
import { NativeDiff } from "./Diff";
import { groupToolActivity, type Message as MessageData } from "./history";
import { ImagePreviews } from "./Images";
import { Copy, Markdown } from "./Markdown";
import { PathActions } from "./PathActions";

const toolIcons = new Map([
  ["read", "M8 3H3v15h5l4 3 4-3h5V3h-5l-4 3-4-3Zm4 3v15M8 3v15m8-15v15"],
  ["execute", "M4 4h16v16H4V4Zm3 4 3 3-3 3m6 1h4"],
  ["search", "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm5 12 6 6"],
  ["edit", "m15 4 5 5M4 20l5-1L21 7l-5-5L4 14v6Z"],
]);

function ToolIcon({ kind }: { kind: unknown }) {
  return (
    <svg className="tool-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d={toolIcons.get(String(kind)) ?? "M12 3 3 12l9 9 9-9-9-9Z"}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const toolStatuses = new Map([
  ["pending", "等待执行"],
  ["in_progress", "运行中"],
  ["completed", "已完成"],
  ["failed", "失败"],
]);

export function TranscriptView({
  rows,
  ...props
}: {
  rows: MessageData[];
  api: DesktopApi;
  expanded: Map<string, boolean>;
  conversationId?: string;
}) {
  return groupToolActivity(rows).map((item) =>
    "tools" in item ? (
      <ToolActivity key={item.id} id={item.id} rows={item.tools} {...props} />
    ) : (
      <MessageView key={item.id} row={item} {...props} />
    ),
  );
}

function ToolActivity({
  id,
  rows,
  expanded,
  ...props
}: {
  id: string;
  rows: MessageData[];
  api: DesktopApi;
  expanded: Map<string, boolean>;
  conversationId?: string;
}) {
  const [, render] = useState(0);
  const needsAttention = rows.some(
    (row) => row.waiting || row.approvalExpired || row.text !== "completed",
  );
  const open =
    expanded.get(id) ?? (needsAttention || rows.some((row) => expanded.get(row.id) === true));
  const completed = rows.filter((row) => row.text === "completed" && !row.waiting).length;
  const waiting = rows.filter((row) => row.waiting).length;
  const failed = rows.filter((row) => row.text === "failed").length;
  const expired = rows.filter((row) => row.approvalExpired).length;
  return (
    <section className="tool-activity" aria-label="工具调用记录">
      <button
        type="button"
        className="activity-heading"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          expanded.set(id, !open);
          render((n) => n + 1);
        }}
      >
        <ToolIcon kind="execute" />
        <span>
          {completed === rows.length
            ? `已完成 ${rows.length} 项工具调用`
            : `工具调用 ${rows.length} 项 · 已完成 ${completed} 项`}
        </span>
        {waiting > 0 && <small className="tool-status waiting">{waiting} 项等待审批</small>}
        {failed > 0 && <small className="tool-status failed">{failed} 项失败</small>}
        {expired > 0 && <small className="tool-status waiting">{expired} 项审批已过期</small>}
        {rows.some((row) => row.text === "in_progress" && !row.waiting && !row.approvalExpired) && (
          <small className="tool-status">运行中</small>
        )}
        <span className="activity-chevron" aria-hidden="true">
          {open ? "⌄" : "›"}
        </span>
      </button>
      <div id={id} hidden={!open}>
        {open &&
          rows.map((row) => <MessageView key={row.id} row={row} expanded={expanded} {...props} />)}
      </div>
    </section>
  );
}

export const MessageView = memo(function MessageView({
  row,
  api,
  expanded,
  conversationId,
}: {
  conversationId?: string;
  row: MessageData;
  api: DesktopApi;
  expanded: Map<string, boolean>;
}) {
  const [, render] = useState(0);
  const open = expanded.get(row.id) ?? (row.tool ? row.waiting || row.text !== "completed" : false);
  const toggle = () => {
    expanded.set(row.id, !open);
    render((n) => n + 1);
  };
  return (
    <article
      className={`message ${row.role === "You" ? "user-message" : "agent-message"} ${row.kind}`}
    >
      {row.tool ? (
        <div className="tool-card">
          <button
            type="button"
            className="tool-heading"
            aria-expanded={!!open}
            onClick={toggle}
            title={row.role}
          >
            <ToolIcon kind={row.tool.kind} />
            <span className="tool-title">{row.role}</span>
            <small className={`tool-status ${row.waiting ? "waiting" : row.text}`}>
              {row.waiting
                ? "等待审批"
                : row.approvalExpired
                  ? `审批已过期 · ${toolStatuses.get(row.text) ?? row.text}`
                  : (toolStatuses.get(row.text) ?? row.text)}
            </small>
            <span className="activity-chevron" aria-hidden="true">
              {open ? "⌄" : "›"}
            </span>
          </button>
          {open && (
            <div className="tool-body">
              <Copy text={pretty(row.tool)} api={api} />
              {row.tool.rawInput !== undefined && (
                <>
                  <h4>原生参数</h4>
                  <pre>{pretty(row.tool.rawInput)}</pre>
                </>
              )}
              {row.tool.rawOutput !== undefined && (
                <>
                  <h4>原生输出</h4>
                  <pre>{pretty(row.tool.rawOutput)}</pre>
                </>
              )}
              {Array.isArray(row.tool.content) &&
                row.tool.content.map((raw, index) => {
                  const content = object(raw);
                  return (
                    <div key={pretty(raw)}>
                      {content.type === "diff" ? (
                        <>
                          <NativeDiff content={content} api={api} />
                          {conversationId &&
                            row.toolSources?.content &&
                            typeof content.path === "string" && (
                              <PathActions
                                api={api}
                                conversationId={conversationId}
                                path={content.path}
                                location={{
                                  kind: "tool",
                                  seq: row.toolSources.content,
                                  collection: "content",
                                  index,
                                }}
                              />
                            )}
                        </>
                      ) : content.type === "content" && object(content.content).type === "text" ? (
                        <Markdown text={String(object(content.content).text)} api={api} />
                      ) : (
                        <>
                          <small>
                            {content.type === "diff" ? "原生 ACP Diff（Agent 提供）" : "原生内容"}
                          </small>
                          <pre>{pretty(content)}</pre>
                        </>
                      )}
                    </div>
                  );
                })}
              {conversationId &&
                row.toolSources?.locations &&
                Array.isArray(row.tool.locations) &&
                row.tool.locations.map((raw, index) => {
                  const location = object(raw);
                  return (
                    typeof location.path === "string" && (
                      <div key={String(index)} className="file-path">
                        {location.path}
                        <PathActions
                          api={api}
                          conversationId={conversationId}
                          path={location.path}
                          location={{
                            kind: "tool",
                            seq: row.toolSources?.locations ?? 0,
                            collection: "locations",
                            index,
                          }}
                        />
                      </div>
                    )
                  );
                })}
              {row.tool.terminalOutput != null && <pre>{String(row.tool.terminalOutput)}</pre>}
              <details>
                <summary>完整原生工具内容</summary>
                <pre>{pretty(row.tool)}</pre>
              </details>
            </div>
          )}
        </div>
      ) : row.handoff ? (
        <div>
          <div className="message-label">
            Handoff · {row.handoff.source} → {row.handoff.target}
          </div>
          <p>{row.text}</p>
          {row.handoff.incomplete && <p>交接材料可能不完整；降级发送需要明确确认。</p>}
          {row.handoff.report && (
            <details>
              <summary>查看交接报告</summary>
              <Markdown text={row.handoff.report} api={api} />
              <Copy text={row.handoff.report} api={api} />
            </details>
          )}
        </div>
      ) : row.role === "Thinking" ? (
        <details>
          <summary>Thinking · 公开思考</summary>
          <Markdown text={row.text} api={api} />
          <Copy text={row.text} api={api} />
        </details>
      ) : (
        <>
          <div className="message-label">
            {row.role}
            <Copy text={row.text} api={api} />
          </div>
          <div className="message-body">
            <ImagePreviews images={row.images ?? []} />
            {row.role === "You" || row.role === "Plan" ? (
              row.text
            ) : (
              <Markdown text={row.text} api={api} />
            )}
          </div>
        </>
      )}
    </article>
  );
});
