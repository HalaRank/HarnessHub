import type { Conversation, Handoff, NativeSession } from "@harnesshub/shared";
import { useRef, useState } from "react";
import type { DesktopApi } from "../contracts";
import { Confirm } from "./Confirm";
import { call } from "./drafts";
import { Copy, Markdown } from "./Markdown";
export function Handoffs({
  api,
  conversation,
  handoffs,
  sessions,
  connected,
}: {
  api: DesktopApi;
  conversation: Conversation;
  handoffs: Handoff[];
  sessions: NativeSession[];
  connected: boolean;
}) {
  const [confirmation, setConfirmation] = useState<Handoff | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const source = sessions.find((s) => s.id === conversation.activeNativeSessionId);
  const pending =
    source && conversation.selectedHarnessId && source.harnessId !== conversation.selectedHarnessId;
  const action = async (h: Handoff, action: "retry" | "confirm" | "cancel") => {
    if (lock.current || !connected || h.status !== "FAILED") return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await call(api, {
        type: "handoff.action",
        conversationId: conversation.id,
        input: { handoffId: h.id, action },
      });
    } catch (e) {
      setError(String(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <section className="handoff-flow" aria-label="Context Handoff">
      <div className="panel-section-heading">
        <h2>Context Handoff</h2>
        <span className="panel-count">{handoffs.length}</span>
      </div>
      {pending && !handoffs.some((h) => !["COMMITTED", "CANCELLED"].includes(h.status)) && (
        <p>
          PENDING_SWITCH · {source.harnessId} → {conversation.selectedHarnessId}
          。首条目标消息提交后才生成报告。
        </p>
      )}
      {source ? (
        <details className="handoff-session">
          <summary>当前 NativeSession · {source.harnessId}</summary>
          <code>{source.id}</code>
        </details>
      ) : (
        <p className="subtle">尚未创建原生会话</p>
      )}
      {!handoffs.length && <p className="subtle">暂无已提交交接。</p>}
      {error && <p role="alert">{error}</p>}
      {handoffs.map((h) => (
        <article className="handoff-record" key={h.id}>
          <strong>
            {h.sourceHarness} → {h.targetHarness} · {h.status}
          </strong>
          <p className="subtle">
            {h.degraded ? "降级交接 · 已确认" : "源 Harness 报告"} ·{" "}
            {new Date(h.updatedAt).toLocaleString()}
          </p>
          <details>
            <summary>追溯交接与原生会话</summary>
            <dl>
              <dt>源 NativeSession</dt>
              <dd>{h.sourceNativeSessionId}</dd>
              <dt>目标 NativeSession</dt>
              <dd>{h.targetNativeSessionId ?? "尚未创建"}</dd>
              <dt>源事件边界</dt>
              <dd>
                #{h.sourceEventStart} → #{h.sourceEventEnd}
              </dd>
            </dl>
            <pre>
              {JSON.stringify(
                {
                  handoffId: h.id,
                  firstTargetRequestId: h.firstTargetRequestId,
                  userTurnId: h.userTurnId,
                  internalTurnId: h.internalTurnId,
                  sessions: sessions
                    .filter((s) =>
                      [h.sourceNativeSessionId, h.targetNativeSessionId].includes(s.id),
                    )
                    .map((s) => ({
                      id: s.id,
                      agentSessionId: s.agentSessionId,
                      harnessId: s.harnessId,
                      cwd: s.cwd,
                      status: s.status,
                    })),
                },
                null,
                2,
              )}
            </pre>
          </details>
          {h.reportText && (
            <details>
              <summary>完整交接报告</summary>
              <Copy text={h.reportText} api={api} />
              <Markdown text={h.reportText} api={api} />
            </details>
          )}
          {h.error && <p role="status">{h.error}</p>}
          {h.fallbackText && (
            <details>
              <summary>降级材料 · 上下文可能不完整</summary>
              <Copy text={h.fallbackText} api={api} />
              <pre>{h.fallbackText}</pre>
              <pre>{JSON.stringify(h.fallbackSources, null, 2)}</pre>
            </details>
          )}
          {h.status === "FAILED" && (
            <div className="handoff-actions">
              <button
                type="button"
                disabled={busy || !connected}
                onClick={() => void action(h, "retry")}
              >
                重试报告
              </button>
              <button
                type="button"
                disabled={busy || !connected}
                onClick={() => setConfirmation(h)}
              >
                检查并确认降级
              </button>
              <button
                type="button"
                disabled={busy || !connected}
                onClick={() => void action(h, "cancel")}
              >
                取消交接
              </button>
            </div>
          )}
          {h.status === "UNCERTAIN" && (
            <p>结果不确定。请检查源事件与 Workspace；不能重发或伪装取消。</p>
          )}
        </article>
      ))}
      {confirmation && (
        <Confirm
          title="确认使用降级材料？"
          label="确认发送目标消息"
          cancel={() => setConfirmation(null)}
          disabled={
            !connected ||
            busy ||
            handoffs.find((h) => h.id === confirmation.id)?.status !== "FAILED"
          }
          confirm={() => {
            setConfirmation(null);
            void action(confirmation, "confirm");
          }}
        >
          <p>
            上下文可能不完整。此操作会使用已有材料向 {confirmation.targetHarness}{" "}
            发送已保留的目标消息。
          </p>
          <pre>{confirmation.fallbackText}</pre>
        </Confirm>
      )}
    </section>
  );
}
