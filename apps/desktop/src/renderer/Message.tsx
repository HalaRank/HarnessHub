import { object, pretty } from "@harnesshub/shared/event-projection";
import { memo, useState } from "react";
import type { DesktopApi } from "../contracts";
import { NativeDiff } from "./Diff";
import type { Message as MessageData } from "./history";
import { Copy, Markdown } from "./Markdown";
import { PathActions } from "./PathActions";

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
          <button type="button" className="tool-heading" aria-expanded={!!open} onClick={toggle}>
            <span>
              {open ? "⌄" : "›"} {row.role}
            </span>
            <small>
              {row.waiting
                ? "等待审批"
                : row.approvalExpired
                  ? `审批已过期 · ${row.text}`
                  : row.text}
            </small>
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
