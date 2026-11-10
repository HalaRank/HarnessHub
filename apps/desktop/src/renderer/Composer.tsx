import {
  activeStates,
  type Conversation,
  type NativeCommand,
  sessionCommands,
} from "@harnesshub/shared";
import { object } from "@harnesshub/shared/event-projection";
import { useEffect, useRef, useState } from "react";
import type { DesktopApi, DesktopRequest, DesktopState } from "../contracts";
import { Confirm } from "./Confirm";
import { call, type DesktopDraft } from "./drafts";
import { Copy } from "./Markdown";

export function inputAction(
  event: { key: string; shiftKey: boolean; isComposing?: boolean; keyCode?: number },
  composing: boolean,
  menu: boolean,
): "send" | "complete" | "none" {
  if (composing || event.isComposing || event.keyCode === 229) return "none";
  if (menu && !event.shiftKey && (event.key === "Enter" || event.key === "Tab")) return "complete";
  return event.key === "Enter" && !event.shiftKey ? "send" : "none";
}
export function slashIntent(text: string, commands: NativeCommand[] | undefined) {
  const name = /^\/([^\s]+)/.exec(text)?.[1];
  return { name, confirmText: !!name && !commands?.some((c) => c.name === name) };
}
export function Composer({
  api,
  state,
  conversation,
  draft,
}: {
  api: DesktopApi;
  state: DesktopState;
  conversation: Conversation;
  draft: DesktopDraft;
}) {
  const [, render] = useState(0);
  const [plain, setPlain] = useState<{ text: string; harness: string } | null>(null);
  const [recover, setRecover] = useState(false);
  const actionLock = useRef(false);
  const [error, setError] = useState("");
  const [acting, setActing] = useState(false);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState(0);
  const composing = useRef(false);
  const compositionEnd = useRef(0);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const slashMenu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const unsubscribe = draft.subscribe(() => render((n) => n + 1));
    let mounted = true;
    void draft.load().catch((e) => {
      if (mounted) setError(String(e));
    });
    return () => {
      mounted = false;
      unsubscribe();
      draft.invalidateLoads();
    };
  }, [draft]);
  useEffect(() => {
    if (textarea.current && textarea.current.value === draft.text) {
      textarea.current.style.height = "auto";
      textarea.current.style.height = `${Math.min(240, textarea.current.scrollHeight)}px`;
    }
  }, [draft.text]);
  const context = state.interaction?.conversationId === conversation.id ? state.interaction : null;
  const source = context?.sessions.find((s) => s.id === conversation.activeNativeSessionId);
  const harness = conversation.selectedHarnessId ?? source?.harnessId ?? "";
  const switching = !!source && source.harnessId !== harness;
  const session =
    switching || source?.status !== "READY" || source.endedAt !== null ? undefined : source;
  const commands = sessionCommands(session);
  const prefix = draft.text.slice(0, cursor);
  const query = /^\/[^\s/\\`]*$/.test(prefix) ? prefix.slice(1).toLowerCase() : null;
  const menu = query !== null && !menuDismissed;
  const matches = (commands ?? []).filter((c) =>
    `${c.name} ${c.description}`.toLowerCase().includes(query ?? ""),
  );
  useEffect(() => {
    if (menu && selected >= 0)
      slashMenu.current
        ?.querySelector('[aria-selected="true"]')
        ?.scrollIntoView({ block: "nearest" });
  }, [menu, selected]);
  const busy = acting || draft.busy || activeStates.has(conversation.runtimeStatus);
  const inputDelivery =
    state.snapshot?.pendingInputs?.filter((i) => i.conversationId === conversation.id) ?? [];
  const uncertainInput = inputDelivery.some((i) => i.state === "UNCERTAIN");
  const uncertain = conversation.runtimeStatus === "UNCERTAIN" || uncertainInput;
  const connected = state.status === "connected";
  const handoff = context?.handoffs.find((h) => !["COMMITTED", "CANCELLED"].includes(h.status));
  const disabled =
    !connected ||
    !draft.loaded ||
    busy ||
    uncertain ||
    !!draft.value.pendingSubmission ||
    !!context?.approvals.length ||
    !!handoff ||
    inputDelivery.length > 0 ||
    (!switching && source?.status === "INTERRUPTED");
  const act = async (request: DesktopRequest) => {
    if (actionLock.current) return;
    actionLock.current = true;
    setActing(true);
    setError("");
    try {
      await call(api, request);
    } catch (e) {
      setError(String(e));
    } finally {
      actionLock.current = false;
      setActing(false);
    }
  };
  const choose = (command: NativeCommand) => {
    draft.update(`/${command.name} ${draft.text.replace(/^\/\S*\s*/, "")}`);
    setMenuDismissed(true);
    setSelected(0);
    textarea.current?.focus();
  };
  const send = () => {
    if (disabled || !draft.text.trim() || !harness) return;
    const { name, confirmText } = slashIntent(draft.text, commands);
    if (confirmText) {
      setMenuDismissed(true);
      setPlain({ text: draft.text, harness });
      return;
    }
    void draft.submit(harness, name && session ? { nativeSessionId: session.id, name } : undefined);
  };
  const native = object(object(session?.capabilities).session);
  const config = Array.isArray(native.configOptions) ? native.configOptions.map(object) : [];
  const modes = object(native.modes);
  const currentModel = object(native.models).currentModelId;
  const activeTurn = state.snapshot?.activity.items.find(
    (i) => i.conversationId === conversation.id,
  )?.activeTurnId;
  return (
    <div className="composer-area">
      {plain && (
        <Confirm
          title="作为普通文本发送？"
          label="作为普通文本发送"
          disabled={disabled || draft.text !== plain.text || harness !== plain.harness}
          cancel={() => setPlain(null)}
          confirm={() => {
            if (disabled || draft.text !== plain.text || harness !== plain.harness) return;
            setPlain(null);
            void draft.submit(plain.harness);
          }}
        >
          <p>
            当前 NativeSession 未发布此 ACP 命令。确认后将原文作为普通 Prompt 交给
            Agent，不作为已发布 ACP 命令调用。
          </p>
          <pre>{plain.text}</pre>
        </Confirm>
      )}
      {!switching && source?.status === "INTERRUPTED" && (
        <div className="banner" role="status">
          旧原生上下文已断开；原始聊天和工具历史仍保留。
          {source.endedAt !== null && source.exitConfirmed ? (
            <button
              type="button"
              disabled={busy || uncertain || !connected || !!handoff || !!context?.approvals.length}
              onClick={() => setRecover(true)}
            >
              使用新原生上下文继续
            </button>
          ) : (
            <p>Worker 退出尚未确认，暂不能继续。</p>
          )}
        </div>
      )}
      {recover && source && (
        <Confirm
          title="使用新原生上下文继续"
          disabled={
            busy ||
            uncertain ||
            !connected ||
            switching ||
            !source.exitConfirmed ||
            source.endedAt === null
          }
          cancel={() => setRecover(false)}
          confirm={() => {
            setRecover(false);
            void act({
              type: "session.recover",
              conversationId: conversation.id,
              nativeSessionId: source.id,
              confirmed: true,
            });
          }}
        >
          <p>将创建新的 NativeSession。旧原生上下文不会恢复，历史记录保留；不会自动发送草稿。</p>
        </Confirm>
      )}
      {switching && (
        <div className="banner">
          PENDING_SWITCH · {source.harnessId} → {harness}。发送第一条消息时才开始交接。
        </div>
      )}
      {handoff && (
        <div className="banner" role="status">
          Handoff · {handoff.status}
          {handoff.error && <p>{handoff.error}</p>}
          {handoff.status === "FAILED" && (
            <>
              <p>降级材料可能不完整，确认后才发送目标消息。</p>
              <details>
                <summary>检查已有报告与降级材料</summary>
                <pre>{handoff.reportText ?? "暂无完整报告"}</pre>
                <pre>{handoff.fallbackText ?? "暂无降级材料"}</pre>
              </details>
              {(["retry", "confirm", "cancel"] as const).map((action) => (
                <button
                  type="button"
                  key={action}
                  disabled={acting || !connected}
                  onClick={() =>
                    void act({
                      type: "handoff.action",
                      conversationId: conversation.id,
                      input: { handoffId: handoff.id, action },
                    })
                  }
                >
                  {action === "retry"
                    ? "重试报告"
                    : action === "confirm"
                      ? "确认使用降级材料"
                      : "取消交接"}
                </button>
              ))}
            </>
          )}
          {handoff.status === "UNCERTAIN" && <p>目标执行结果不确定，不能安全重发或伪装取消。</p>}
        </div>
      )}
      {context?.approvals.map((approval) => {
        const request = object(approval.request);
        const options = Array.isArray(request.options) ? request.options.map(object) : [];
        return (
          <section className="approval" key={approval.id} aria-label="原生权限审批">
            <strong>Agent 请求权限 · 等待你的选择</strong>
            <pre>{JSON.stringify(request.toolCall ?? request, null, 2)}</pre>
            {options.map((option) => (
              <button
                key={String(option.optionId)}
                type="button"
                disabled={acting || !connected}
                title={String(option.optionId)}
                onClick={() =>
                  void act({
                    type: "approval.decide",
                    conversationId: conversation.id,
                    approvalId: approval.id,
                    optionId: String(option.optionId),
                  })
                }
              >
                {String(option.name ?? option.optionId)}
              </button>
            ))}
          </section>
        );
      })}
      {inputDelivery.length > 0 && (
        <div className="banner error" role="status">
          {uncertainInput ? "输入投递结果不确定（UNCERTAIN）" : "输入投递等待确认（SENDING）"}。原
          Turn 的结果独立保留；请检查历史，不会自动重发。
          {inputDelivery.map((i) => (
            <div key={i.requestId}>requestId · {i.requestId}</div>
          ))}
        </div>
      )}
      {uncertain && !uncertainInput && (
        <div className="banner error">
          UNCERTAIN · 执行结果不确定。请检查历史和工作区；此会话不会自动重发。
        </div>
      )}
      {(error || draft.error) && (
        <div className="banner error" role="alert">
          {error || draft.error}
        </div>
      )}
      {draft.error && !draft.value.pendingSubmission && (
        <div className="draft-recovery">
          <Copy text={draft.text} api={api} />
          <button
            type="button"
            disabled={draft.busy}
            onClick={() => void draft.flush().catch(() => {})}
          >
            重试保存
          </button>
          <button
            type="button"
            disabled={draft.busy}
            onClick={() => {
              if (window.confirm("放弃本地未保存文字并载入 SQLite 草稿？可先复制本地文字。"))
                void draft.reload().catch((e) => setError(String(e)));
            }}
          >
            载入服务器草稿
          </button>
        </div>
      )}
      {draft.value.pendingSubmission && (
        <div className="banner">
          未确认请求 · {draft.value.pendingSubmission.requestId}
          <button
            type="button"
            disabled={!connected || draft.busy}
            onClick={() => void draft.lookup()}
          >
            查询请求状态
          </button>
          <Copy text={draft.text} api={api} />
        </div>
      )}
      {draft.result && (
        <div className="subtle" role="status">
          {draft.result}
        </div>
      )}
      <div className="composer">
        {menu && (
          <div ref={slashMenu} className="slash-menu" role="listbox" aria-label="当前 ACP 命令">
            {matches.length ? (
              matches.map((command, index) => (
                <button
                  role="option"
                  aria-selected={index === selected}
                  type="button"
                  key={command.name}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(command)}
                >
                  <strong>/{command.name}</strong> {command.input?.hint}
                  <small>{command.description}</small>
                </button>
              ))
            ) : (
              <p>
                {switching
                  ? "目标 Harness 尚无 NativeSession；交接后才有目标命令。"
                  : commands === undefined
                    ? "当前 NativeSession 尚未发布 ACP 命令。"
                    : commands.length
                      ? "没有匹配的 ACP 命令。"
                      : "Agent 已发布空命令列表。"}
              </p>
            )}
            <small>↑↓ 选择 · Tab / Enter 补全 · 再次发送才执行 · Esc 关闭</small>
          </div>
        )}
        <textarea
          ref={textarea}
          aria-label="消息输入"
          placeholder="发送消息 · Enter 发送，Shift+Enter 换行"
          rows={2}
          maxLength={100000}
          disabled={!draft.loaded}
          readOnly={draft.busy || !!draft.value.pendingSubmission}
          value={draft.text}
          onChange={(event) => {
            draft.update(event.target.value);
            setCursor(event.target.selectionStart);
            setSelected(0);
            setMenuDismissed(false);
          }}
          onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
            compositionEnd.current = Date.now();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setMenuDismissed(true);
              return;
            }
            if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (menu && ["ArrowDown", "ArrowUp"].includes(event.key)) {
              event.preventDefault();
              setSelected(
                (n) =>
                  (n + (event.key === "ArrowDown" ? 1 : -1) + Math.max(matches.length, 1)) %
                  Math.max(matches.length, 1),
              );
              return;
            }
            const action = inputAction(
              {
                key: event.key,
                shiftKey: event.shiftKey,
                isComposing: event.nativeEvent.isComposing,
                keyCode: event.keyCode,
              },
              Date.now() - compositionEnd.current < 80,
              menu && matches.length > 0,
            );
            if (action !== "none") event.preventDefault();
            if (action === "complete") {
              const command = matches[selected] ?? matches[0];
              if (command) choose(command);
            }
            if (action === "send") send();
          }}
        />
        <div className="composer-footer">
          <select
            aria-label="Harness"
            value={harness}
            disabled={
              busy || !connected || !!draft.value.pendingSubmission || uncertain || !!handoff
            }
            onChange={(e) => {
              setMenuDismissed(true);
              void act({
                type: "harness.select",
                conversationId: conversation.id,
                harnessId: e.target.value,
              });
            }}
          >
            <option value="" disabled>
              选择 Harness
            </option>
            {state.profiles?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          {!session && !switching && (
            <button
              type="button"
              disabled={busy || !connected || !harness || uncertain}
              onClick={() =>
                void act({
                  type: "session.prepare",
                  conversationId: conversation.id,
                  harnessId: harness,
                })
              }
            >
              连接 Agent 获取选项
            </button>
          )}
          {currentModel != null && <span>模型：{String(currentModel)}</span>}
          {config.map((option) => (
            <label key={String(option.id)} htmlFor={`config-${String(option.id)}`}>
              {String(option.name ?? option.id)}
              {option.type === "boolean" ? (
                <input
                  id={`config-${String(option.id)}`}
                  type="checkbox"
                  checked={option.currentValue === true}
                  disabled={busy || !connected || switching}
                  onChange={(e) =>
                    void act({
                      type: "session.settings",
                      conversationId: conversation.id,
                      setting: {
                        kind: "config",
                        configId: String(option.id),
                        value: e.target.checked,
                      },
                    })
                  }
                />
              ) : (
                <select
                  id={`config-${String(option.id)}`}
                  aria-label={String(option.name)}
                  value={String(option.currentValue)}
                  disabled={busy || !connected || switching}
                  onChange={(e) =>
                    void act({
                      type: "session.settings",
                      conversationId: conversation.id,
                      setting: {
                        kind: "config",
                        configId: String(option.id),
                        value: e.target.value,
                      },
                    })
                  }
                >
                  {(Array.isArray(option.options) ? option.options : [])
                    .flatMap((entry) => {
                      const o = object(entry);
                      return Array.isArray(o.options) ? o.options.map(object) : [o];
                    })
                    .map((o) => (
                      <option key={String(o.value)} value={String(o.value)}>
                        {String(o.name ?? o.value)}
                      </option>
                    ))}
                </select>
              )}
            </label>
          ))}
          {Array.isArray(modes.availableModes) && (
            <label>
              模式
              <select
                value={String(modes.currentModeId)}
                disabled={busy || !connected || switching}
                onChange={(e) =>
                  void act({
                    type: "session.settings",
                    conversationId: conversation.id,
                    setting: { kind: "mode", modeId: e.target.value },
                  })
                }
              >
                {modes.availableModes.map((m) => {
                  const mode = object(m);
                  return (
                    <option key={String(mode.id)} value={String(mode.id)}>
                      {String(mode.name)}
                    </option>
                  );
                })}
              </select>
            </label>
          )}
          {session && !config.length && currentModel == null && <span>ACP 未发布模型选项</span>}
          {activeTurn && (
            <button
              type="button"
              disabled={
                !connected || acting || uncertain || conversation.runtimeStatus === "CANCELLING"
              }
              onClick={() =>
                void act({
                  type: "turn.cancel",
                  conversationId: conversation.id,
                  turnId: activeTurn,
                })
              }
            >
              取消任务
            </button>
          )}
          <button
            type="button"
            className="send"
            aria-label="发送"
            disabled={disabled || !draft.text.trim() || !harness}
            onClick={send}
          >
            {draft.busy ? "提交中…" : "↑ 发送"}
          </button>
        </div>
      </div>
      <p className="composer-note">{conversation.workspacePath} · 关闭窗口不会停止后台任务</p>
    </div>
  );
}
