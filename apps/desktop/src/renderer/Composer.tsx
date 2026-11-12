import {
  activeStates,
  attachmentInputError,
  type Conversation,
  type NativeCommand,
  sessionCommands,
} from "@harnesshub/shared";
import { object } from "@harnesshub/shared/event-projection";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopApi, DesktopRequest, DesktopState } from "../contracts";
import { Confirm } from "./Confirm";
import { call, type DesktopDraft } from "./drafts";
import { ImagePreviews, useImageInput } from "./Images";
import { Copy } from "./Markdown";
import { Select } from "./Select";

export function inputAction(
  event: { key: string; shiftKey: boolean; isComposing?: boolean; keyCode?: number },
  composing: boolean,
  menu: boolean,
  running = false,
): "send" | "queue" | "complete" | "none" {
  if (composing || event.isComposing || event.keyCode === 229) return "none";
  if (menu && !event.shiftKey && (event.key === "Enter" || event.key === "Tab")) return "complete";
  if (running && event.key === "Tab" && !event.shiftKey) return "queue";
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
  const [plain, setPlain] = useState<{
    text: string;
    harness: string;
    delivery?: "steer" | "queue" | undefined;
  } | null>(null);
  const [recover, setRecover] = useState(false);
  const [externalStopped, setExternalStopped] = useState(false);
  const actionLock = useRef(false);
  const prepareAttempt = useRef("");
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
  const running = ["PREPARING", "RUNNING", "WAITING_APPROVAL"].includes(conversation.runtimeStatus);
  const inputDelivery =
    state.snapshot?.pendingInputs?.filter((i) => i.conversationId === conversation.id) ?? [];
  const uncertainInput = inputDelivery.some((i) => i.state === "UNCERTAIN");
  const uncertain = conversation.runtimeStatus === "UNCERTAIN" || uncertainInput;
  const disconnected = !switching && !!source && (source.status === "INTERRUPTED" || uncertain);
  const sending = inputDelivery.some((i) => i.state === "SENDING");
  const steering = object(object(object(source?.capabilities).initialize)._meta).steering;
  const canSteer = object(steering).supported === true && draft.images.length === 0;
  const connected = state.status === "connected";
  const handoff = context?.handoffs.find((h) => !["COMMITTED", "CANCELLED"].includes(h.status));
  const disabled =
    !connected ||
    !draft.loaded ||
    acting ||
    draft.busy ||
    conversation.runtimeStatus === "CANCELLING" ||
    uncertain ||
    !!draft.value.pendingSubmission ||
    !!handoff ||
    (!switching && source?.status === "INTERRUPTED");
  const imageInput = useImageInput(
    draft,
    !draft.loaded || draft.busy || !!draft.value.pendingSubmission,
  );
  const imageSupported = session
    ? object(object(object(session.capabilities).initialize).agentCapabilities).promptCapabilities
    : null;
  const attachmentError = session ? attachmentInputError(draft.images, object(imageSupported)) : "";
  const imageUnsupported = !!attachmentError;
  useEffect(() => {
    if (
      draft.busy ||
      !draft.result ||
      draft.result.includes("不确定") ||
      draft.result.includes("requestId")
    )
      return;
    const timeout = setTimeout(() => draft.clearResult(), 4000);
    return () => clearTimeout(timeout);
  }, [draft, draft.result, draft.busy]);
  const act = useCallback(
    async (request: DesktopRequest) => {
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
    },
    [api],
  );
  useEffect(() => {
    if (!connected) {
      prepareAttempt.current = "";
      return;
    }
    // The first Turn prepares its own session before activeNativeSessionId is bound.
    if (!context || !harness || conversation.activeNativeSessionId || disabled || busy) return;
    const key = `${conversation.id}:${harness}`;
    if (prepareAttempt.current === key) return;
    prepareAttempt.current = key;
    void act({ type: "session.prepare", conversationId: conversation.id, harnessId: harness });
  }, [
    act,
    connected,
    context,
    harness,
    disabled,
    busy,
    conversation.id,
    conversation.activeNativeSessionId,
  ]);
  const choose = (command: NativeCommand) => {
    draft.update(`/${command.name} ${draft.text.replace(/^\/\S*\s*/, "")}`);
    setMenuDismissed(true);
    setSelected(0);
    textarea.current?.focus();
  };
  const send = (delivery?: "steer" | "queue") => {
    if (
      disabled ||
      imageInput.reading ||
      (draft.images.length > 0 && imageUnsupported) ||
      !draft.hasContent ||
      !harness
    )
      return;
    delivery ??= running
      ? "steer"
      : inputDelivery.some((i) => ["QUEUED", "HELD", "SENDING"].includes(i.state))
        ? "queue"
        : undefined;
    const { name, confirmText } = slashIntent(draft.text, commands);
    if (confirmText) {
      setMenuDismissed(true);
      setPlain({
        text: draft.text,
        harness,
        delivery,
      });
      return;
    }
    void draft.submit(
      harness,
      name && session ? { nativeSessionId: session.id, name } : undefined,
      delivery,
    );
  };
  const native = object(object(session?.capabilities).session);
  const config = Array.isArray(native.configOptions) ? native.configOptions.map(object) : [];
  const modelOption = config.find(
    (option) => option.type === "select" && (option.category === "model" || option.id === "model"),
  );
  const modeOption = config.find(
    (option) => option.type === "select" && (option.category === "mode" || option.id === "mode"),
  );
  const settings = [modelOption, modeOption].filter((option) => option !== undefined);
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
            void draft.submit(plain.harness, undefined, plain.delivery);
          }}
        >
          <p>
            当前 NativeSession 未发布此 ACP 命令。确认后将原文作为普通 Prompt 交给
            Agent，不作为已发布 ACP 命令调用。
          </p>
          <pre>{plain.text}</pre>
        </Confirm>
      )}
      {(disconnected || (uncertain && !uncertainInput)) && (
        <section className="context-notice" aria-label="会话状态提示">
          <svg className="context-notice-icon" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v6m0 3v1" />
          </svg>
          <div className="context-notice-body">
            <div className="context-notice-heading">
              <strong role="status">{uncertain ? "执行结果不确定" : "原生上下文已断开"}</strong>
              {disconnected && (
                <button
                  type="button"
                  className="context-notice-action"
                  disabled={
                    busy || !connected || !!handoff || !!context?.approvals.length || sending
                  }
                  onClick={() => {
                    setExternalStopped(false);
                    setRecover(true);
                  }}
                >
                  使用新原生上下文继续 <span aria-hidden="true">→</span>
                </button>
              )}
            </div>
            <p>
              {disconnected ? "聊天和工具历史已保留。" : "请检查历史和工作区。"}
              {uncertain ? "消息不会自动重发。" : "继续前请先检查历史和工作区。"}
            </p>
            <details className="context-notice-details">
              <summary>
                {disconnected && source && !source.exitConfirmed
                  ? "后台任务退出待确认 · 查看说明"
                  : "查看说明"}
              </summary>
              {disconnected && source && !source.exitConfirmed && (
                <p>Worker 退出尚未确认，请先检查并结束旧任务。</p>
              )}
              {disconnected && <p>旧原生上下文已断开；继续时将创建新上下文，保留历史和草稿。</p>}
              {uncertain && <p>状态：UNCERTAIN。请核对已有执行结果，避免重复操作。</p>}
            </details>
          </div>
        </section>
      )}
      {recover && source && (
        <Confirm
          title="使用新原生上下文继续"
          disabled={busy || !connected || switching || (!source.exitConfirmed && !externalStopped)}
          cancel={() => setRecover(false)}
          confirm={() => {
            setRecover(false);
            void act({
              type: "session.recover",
              conversationId: conversation.id,
              nativeSessionId: source.id,
              confirmed: true,
              acknowledgeUncertain: true,
              ...(externalStopped ? { externalWorkerStopped: true as const } : {}),
            });
          }}
        >
          <p>
            请检查聊天历史和工作区。确认后创建新原生上下文，保留历史和草稿。旧任务执行结果继续记录为不确定，待发队列保持暂停。
          </p>
          {!source.exitConfirmed && (
            <label className="recovery-check">
              <input
                type="checkbox"
                checked={externalStopped}
                onChange={(e) => setExternalStopped(e.target.checked)}
              />
              我已检查并结束旧 Worker 及其后台任务
            </label>
          )}
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
      {(uncertainInput || sending) && (
        <div className={uncertainInput ? "banner error" : "banner"} role="status">
          {uncertainInput ? "输入投递结果不确定（UNCERTAIN）" : "输入投递等待确认（SENDING）"}。原
          Turn 的结果独立保留；请检查历史，不会自动重发。
          {inputDelivery
            .filter((i) => ["SENDING", "UNCERTAIN"].includes(i.state))
            .map((i) => (
              <div key={i.requestId}>requestId · {i.requestId}</div>
            ))}
        </div>
      )}
      {inputDelivery.some((i) => ["QUEUED", "HELD", "ERROR"].includes(i.state)) && (
        <section className="input-queue" aria-label="待发消息">
          {inputDelivery.some((i) => i.state === "HELD") && (
            <button
              type="button"
              disabled={acting || !connected || uncertain || sending}
              onClick={() => void act({ type: "inputs.resume", conversationId: conversation.id })}
            >
              恢复暂停队列
            </button>
          )}
          {inputDelivery
            .filter((i) => ["QUEUED", "HELD", "ERROR"].includes(i.state))
            .map((input) => (
              <div className="queued-input" key={input.requestId}>
                <span title={input.reason}>
                  {input.state === "HELD"
                    ? "已暂停"
                    : input.state === "ERROR"
                      ? "发送失败"
                      : "排队中"}
                </span>
                <p>{input.input.message || `${input.input.images?.length ?? 0} 个附件`}</p>
                <button
                  type="button"
                  disabled={acting || !connected}
                  onClick={() =>
                    void act({
                      type: "inputs.remove",
                      conversationId: conversation.id,
                      requestId: input.requestId,
                    })
                  }
                >
                  移除
                </button>
              </div>
            ))}
        </section>
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
          <button
            type="button"
            disabled={!connected || draft.busy || uncertain}
            onClick={() => void draft.retry()}
          >
            检查后重试原请求
          </button>
        </div>
      )}
      <div className="composer">
        <ImagePreviews
          images={draft.images}
          disabled={draft.busy || imageInput.reading || !!draft.value.pendingSubmission}
          remove={(index) => draft.updateImages(draft.images.filter((_, i) => i !== index))}
        />
        {(imageInput.error || (draft.images.length > 0 && imageUnsupported)) && (
          <p className="composer-note error" role="alert">
            {imageInput.error || attachmentError}
          </p>
        )}
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
          placeholder={
            running
              ? `Enter ${canSteer ? "追加指令" : "排队"} · Tab 排队 · Shift+Enter 换行`
              : "发送消息 · Enter 发送，Shift+Enter 换行"
          }
          rows={2}
          maxLength={100000}
          disabled={!draft.loaded}
          readOnly={draft.busy || !!draft.value.pendingSubmission}
          value={draft.text}
          onPaste={imageInput.paste}
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
              running && draft.hasContent,
            );
            if (action !== "none") event.preventDefault();
            if (action === "complete") {
              const command = matches[selected] ?? matches[0];
              if (command) choose(command);
            }
            if (action === "send") send();
            if (action === "queue") send("queue");
          }}
        />
        <div className="composer-footer">
          <div className="composer-options">
            {imageInput.picker}
            <Select
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
            </Select>
            {!session && !switching && harness && acting && (
              <span className="composer-connection" role="status">
                正在连接…
              </span>
            )}
            {!session && !switching && harness && !acting && (
              <button
                type="button"
                className="composer-connect"
                disabled={busy || !connected || !harness || uncertain}
                onClick={() =>
                  void act({
                    type: "session.prepare",
                    conversationId: conversation.id,
                    harnessId: harness,
                  })
                }
              >
                重试连接
              </button>
            )}
            {!modelOption && currentModel != null && (
              <span className="composer-model" title={String(currentModel)}>
                模型 · {String(currentModel)}
              </span>
            )}
            {settings.map((option) => (
              <label key={String(option.id)} htmlFor={`config-${String(option.id)}`}>
                <span>{option === modelOption ? "模型" : "审批模式"}</span>
                <Select
                  id={`config-${String(option.id)}`}
                  title={typeof option.description === "string" ? option.description : undefined}
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
                </Select>
              </label>
            ))}
            {!modeOption &&
              Array.isArray(modes.availableModes) &&
              modes.availableModes.length > 0 && (
                <label htmlFor="native-mode">
                  <span>审批模式</span>
                  <Select
                    id="native-mode"
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
                  </Select>
                </label>
              )}
          </div>
          <div className="composer-actions">
            {activeTurn && (
              <button
                type="button"
                className="composer-cancel"
                aria-label="取消任务"
                title="取消当前任务"
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
                <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <rect x="5" y="5" width="10" height="10" rx="2" />
                </svg>
              </button>
            )}
            {running && canSteer && (
              <button
                type="button"
                className="composer-queue"
                aria-label="加入队列"
                disabled={
                  disabled ||
                  !draft.hasContent ||
                  imageInput.reading ||
                  (draft.images.length > 0 && imageUnsupported)
                }
                title="当前任务结束后发送 · Tab"
                onClick={() => send("queue")}
              >
                <svg
                  viewBox="0 0 20 20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="M3 5h14M3 10h8M3 15h8m5-3v6m-3-3h6" />
                </svg>
                排队 <kbd>Tab</kbd>
              </button>
            )}
            <button
              type="button"
              className="send"
              aria-label={running ? (canSteer ? "追加指令" : "加入队列") : "发送"}
              title={`${running ? (canSteer ? "追加指令" : "加入队列") : "发送"} · Enter`}
              disabled={
                disabled ||
                imageInput.reading ||
                (draft.images.length > 0 && imageUnsupported) ||
                !draft.hasContent ||
                !harness
              }
              onClick={() => send()}
            >
              {draft.busy ? "提交中…" : running ? (canSteer ? "追加指令" : "加入队列") : "发送"}
              <svg
                viewBox="0 0 20 20"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M10 16V4m-5 5 5-5 5 5" />
              </svg>
            </button>
          </div>
        </div>
      </div>
      <div className="composer-meta">
        <p className="composer-note" title={conversation.workspacePath}>
          {conversation.workspacePath} · 关闭窗口不会停止后台任务
        </p>
        {draft.result && (
          <div
            className={`composer-feedback${draft.result.includes("不确定") ? " uncertain" : ""}`}
            role="status"
          >
            <svg
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d={draft.result.includes("不确定") ? "M10 4v7m0 4h.01" : "m4 10 4 4 8-8"} />
            </svg>
            <span>{draft.result}</span>
            <button type="button" aria-label="关闭发送提示" onClick={() => draft.clearResult()}>
              ×
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
