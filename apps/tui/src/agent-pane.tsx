import type {
  Approval,
  Conversation,
  Handoff,
  NativeSession,
  Shortcuts,
  Turn,
} from "@harnesshub/shared";
import { connect, HttpError, watchConversation } from "@harnesshub/shared/client";
import type { TextareaRenderable } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/solid";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { ChangesPane } from "./changes-pane";
import { useClipboard } from "./clipboard";
import { DraftSession } from "./draft-session";
import { NativeEvents } from "./native-events";
import { RawEvents } from "./raw-events";
import { binding, matches, shortcuts } from "./shortcuts";
import { SourceViewer } from "./source-viewer";
import { object, Transcript, type ViewState } from "./transcript";

type Permission = {
  options: { optionId: string; name: string; kind: string }[];
  toolCall: unknown;
};
export type AgentAction = { id: number; name: string };
export function actualModel(session: NativeSession | undefined) {
  const native = object(object(session?.capabilities).session);
  const options = Array.isArray(native.configOptions) ? native.configOptions : [];
  const model = options.map(object).find((o) => o.category === "model");
  return typeof model?.currentValue === "string"
    ? model.currentValue
    : typeof object(native.models).currentModelId === "string"
      ? String(object(native.models).currentModelId)
      : "not exposed by ACP";
}
export function AgentPane(props: {
  conversation: Conversation;
  form: string | null;
  setForm: (value: "message" | "approval" | "details" | "settings" | null) => void;
  onDraftError: (message: string) => void;
  view?: ViewState;
  shortcuts?: Shortcuts;
  action?: AgentAction;
  onChangesChange?: (value: boolean) => void;
  registerClearInput?: (clear: (() => boolean) | undefined) => void;
}) {
  const transcript = new Transcript(),
    renderer = useRenderer();
  const [handoffs, setHandoffs] = createSignal<Handoff[]>([]);
  const [handoffMenu, setHandoffMenu] = createSignal(false),
    [materials, setMaterials] = createSignal<Handoff | null>(null);
  const [activeSessionId, setActiveSessionId] = createSignal<string | null>(
    props.conversation.activeNativeSessionId ?? null,
  );
  const activeSession = () => sessions().find((s) => s.id === activeSessionId());
  const openHandoffRecord = () =>
    handoffs().find((h) => !["COMMITTED", "CANCELLED"].includes(h.status));
  const executionSession = () =>
    openHandoffRecord()?.status === "DELIVERING"
      ? (sessions().find((s) => s.id === openHandoffRecord()?.targetNativeSessionId) ??
        activeSession())
      : activeSession();
  const failedHandoff = () => handoffs().find((h) => h.status === "FAILED");
  const [debug, setDebug] = createSignal(false);
  const [profiles, setProfiles] = createSignal<{ id: string; name: string }[]>([]);
  const [harness, setHarness] = createSignal("codex"),
    [sessions, setSessions] = createSignal<NativeSession[]>([]);
  const [approvals, setApprovals] = createSignal<Approval[]>([]),
    [turnId, setTurnId] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false),
    [error, setError] = createSignal(""),
    [connection, setConnection] = createSignal("Connecting"),
    [changes, setChanges] = createSignal(false);
  const conversationId = props.conversation.id;
  const [draftReady, setDraftReady] = createSignal(false),
    [draftState, setDraftState] = createSignal(0);
  const draft = new DraftSession(
    conversationId,
    () => setDraftState((n) => n + 1),
    (e) => props.onDraftError(e instanceof Error ? e.message : "Draft save failed"),
  );
  let selectionQueue = Promise.resolve(),
    selectionPending = 0,
    selectionFailure = "";
  let disposed = false,
    textarea: TextareaRenderable | undefined;
  const copyText = useClipboard();
  const [inputLines, setInputLines] = createSignal(1);
  props.registerClearInput?.(() => {
    if (!(textarea?.plainText ?? draft.text).length) return false;
    textarea?.setText("");
    draft.update("");
    setInputLines(1);
    return true;
  });
  onCleanup(() => props.registerClearInput?.(undefined));
  const keys = () => shortcuts(props.shortcuts);
  createEffect(() => props.onChangesChange?.(changes()));
  const request = async <T,>(path: string, method = "GET", body?: unknown) => {
    const client = await connect();
    if (!client) throw new Error("Daemon disconnected");
    return client.request<T>(path, method, body);
  };
  const run = async (action: () => Promise<void>) => {
    if (busy()) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      if (!disposed) setError(e instanceof Error ? e.message : "ACP operation failed");
    } finally {
      if (!disposed) setBusy(false);
    }
  };
  const refreshApprovals = async () => {
    const result = await request<Approval[]>(`/v1/conversations/${conversationId}/approvals`);
    if (!disposed) setApprovals(result);
  };
  const refreshSessions = async () => {
    const result = await request<NativeSession[]>(`/v1/conversations/${conversationId}/sessions`);
    const conversation = await request<Conversation>(`/v1/conversations/${conversationId}`);
    if (!disposed) {
      setSessions(result);
      setActiveSessionId(conversation.activeNativeSessionId ?? null);
      if (!selectionPending)
        setHarness(
          conversation.selectedHarnessId ??
            result.find((s) => s.id === conversation.activeNativeSessionId)?.harnessId ??
            "codex",
        );
    }
  };
  const refreshHandoffs = async () => {
    const result = await request<Handoff[]>(`/v1/conversations/${conversationId}/handoffs`);
    if (!disposed) setHandoffs(result);
  };
  onMount(() => {
    const measureInput = () => {
      if (textarea && !textarea.isDestroyed)
        setInputLines(Math.max(1, textarea.lineCount, textarea.virtualLineCount));
    };
    renderer.on("frame", measureInput);
    onCleanup(() => renderer.off("frame", measureInput));
    void run(async () => {
      await draft.load();
      if (disposed) {
        await draft.dispose();
        return;
      }
      setDraftReady(true);
      setProfiles(await request("/v1/harness-profiles"));
      await refreshSessions();
      await refreshHandoffs();
      if (draft.value.pendingSubmission) setHarness(draft.value.pendingSubmission.harnessId);
      await refreshApprovals();
    });
    const stop = watchConversation(
      conversationId,
      () => {},
      setConnection,
      0,
      (batch) => {
        if (!batch.length || disposed) return;
        transcript.append(batch);
        for (const event of batch) {
          if (event.kind === "user.message") setTurnId(event.turnId);
          if (
            (event.kind === "runtime.turn_finished" && event.purpose !== "handoff_internal") ||
            event.kind === "runtime.interrupted"
          )
            setTurnId(null);
        }
        if (batch.some((e) => e.kind.startsWith("handoff."))) {
          void refreshHandoffs().catch(() => {});
          void refreshSessions().catch(() => {});
        }
        if (
          batch.some(
            (e) =>
              e.kind.startsWith("approval.") ||
              ["runtime.turn_finished", "runtime.interrupted"].includes(e.kind),
          )
        )
          void refreshApprovals().catch(() => {});
        if (
          batch.some((e) =>
            [
              "runtime.session_ready",
              "config_option_update",
              "current_mode_update",
              "runtime.interrupted",
              "runtime.worker_lost",
            ].includes(e.kind),
          )
        )
          void refreshSessions().catch(() => {});
      },
    );
    onCleanup(() => {
      disposed = true;
      stop();
      void draft
        .dispose()
        .catch((e) => props.onDraftError(e instanceof Error ? e.message : "Draft save failed"));
      if (["message", "approval", "details", "settings"].includes(props.form ?? ""))
        props.setForm(null);
    });
  });
  const cancel = () => {
    if (turnId())
      void run(async () => {
        await request(`/v1/turns/${turnId()}/cancel`, "POST");
      });
  };
  const selectHarness = (id: string) => {
    setHarness(id);
    selectionPending++;
    selectionFailure = "";
    selectionQueue = selectionQueue.then(async () => {
      try {
        await request(`/v1/conversations/${conversationId}/harness`, "PUT", { harnessId: id });
      } catch (e) {
        selectionFailure = e instanceof Error ? e.message : "Harness selection failed";
        if (!disposed) setError(selectionFailure);
      } finally {
        selectionPending--;
        if (!disposed && !selectionPending && selectionFailure) await refreshSessions();
      }
    });
    return selectionQueue;
  };
  const cancelSwitch = () => {
    const source = activeSession();
    if (source) void selectHarness(source.harnessId);
  };
  const nextHarness = () => {
    const list = profiles(),
      index = list.findIndex((p) => p.id === harness());
    void selectHarness(list[(index + 1) % list.length]?.id ?? "codex");
  };
  const openHandoff = () => {
    setHandoffMenu(true);
    props.setForm("details");
  };
  let lastAction = props.action?.id ?? 0;
  createEffect(() => {
    const action = props.action;
    if (!action || action.id === lastAction) return;
    lastAction = action.id;
    if (action.name === "raw") {
      setHandoffMenu(false);
      setDebug(true);
      props.setForm("details");
    }
    if (action.name === "restore_pending" && draft.value.pendingSubmission) {
      textarea?.setText(draft.value.pendingSubmission.message);
      draft.update(draft.value.pendingSubmission.message);
      props.setForm("message");
    }
    if (action.name === "cancel") cancel();
    if (action.name === "harness") nextHarness();
    if (action.name === "cancel_switch") cancelSwitch();
    if (action.name === "handoff") openHandoff();
    if (action.name === "changes") setChanges((v) => !v);
  });
  useKeyboard((key) => {
    if (matches(key, keys().changes) && (!props.form || props.form === "message")) {
      key.preventDefault();
      props.setForm(null);
      setChanges((v) => !v);
      return;
    }
    if (matches(key, keys().copy)) {
      const text = renderer.getSelection()?.getSelectedText();
      if (text) {
        key.preventDefault();
        renderer.clearSelection();
        void copyText(text).then(setError);
      }
      return;
    }
    if (props.form) return;
    if (key.name === "m") {
      key.preventDefault();
      props.setForm("message");
      return;
    }
    if (busy()) return;
    if (key.name === "a" && approvals().length) {
      key.preventDefault();
      props.setForm("approval");
    }
    if (key.name === "h") nextHarness();
    if (key.name === "c") cancel();
    if (key.name === "x") cancelSwitch();
    if (key.name === "f" && failedHandoff()) openHandoff();
  });
  const send = () =>
    run(async () => {
      await selectionQueue;
      if (selectionFailure) throw new Error(selectionFailure);
      const message = textarea?.plainText ?? "";
      if (!message.trim()) return;
      draft.update(message);
      const submission = await draft.prepare(harness());
      try {
        const turn = await request<Turn>(
          `/v1/conversations/${conversationId}/turns`,
          "POST",
          submission,
        );
        setTurnId(turn.endedAt ? null : turn.id);
      } catch (error) {
        if (error instanceof HttpError && [400, 404, 409].includes(error.status))
          await draft.rejected();
        throw error;
      }
      await draft.accepted();
      if (!disposed) {
        textarea?.setText(draft.text);
        props.setForm(null);
      }
    });
  const sessionChoices = createMemo(() => {
    const native = object(object(activeSession()?.capabilities).session);
    const choices: { name: string; value: unknown; description: string }[] = [];
    for (const mode of Array.isArray(object(native.modes).availableModes)
      ? (object(native.modes).availableModes as unknown[])
      : []) {
      const m = object(mode);
      choices.push({
        name: `Mode · ${m.name} [${m.id}]`,
        description: "",
        value: { kind: "mode", modeId: m.id },
      });
    }
    for (const raw of Array.isArray(native.configOptions) ? native.configOptions : []) {
      const option = object(raw);
      if (option.type === "boolean")
        for (const value of [true, false])
          choices.push({
            name: `${option.name} · ${value}`,
            description: "",
            value: { kind: "config", configId: option.id, value },
          });
      for (const rawEntry of Array.isArray(option.options) ? option.options : []) {
        const entry = object(rawEntry);
        for (const rawValue of Array.isArray(entry.options) ? entry.options : [entry]) {
          const v = object(rawValue);
          choices.push({
            name: `${option.name} · ${v.name} [${v.value}]${v.value === option.currentValue ? " (current)" : ""}`,
            description: "",
            value: { kind: "config", configId: option.id, value: v.value },
          });
        }
      }
    }
    return choices;
  });
  return (
    <box flexDirection="column" flexGrow={1} minHeight={0} gap={0}>
      <text
        fg="#80cbc4"
        height={1}
        flexShrink={0}
      >{`ACP · ${executionSession()?.harnessId ?? harness()}${openHandoffRecord() ? ` · Handoff ${openHandoffRecord()?.sourceHarness} → ${openHandoffRecord()?.targetHarness} · ${openHandoffRecord()?.status}` : activeSession() && activeSession()?.harnessId !== harness() ? ` → ${harness()} (PENDING_SWITCH; x cancel)` : ""} · ${props.conversation.runtimeStatus} · Model (ACP): ${actualModel(executionSession())} · ${connection()}`}</text>
      <Show when={activeSession() && activeSession()?.harnessId !== harness()}>
        <text fg="#ffcc80">
          First target message starts Handoff. Wait for source execution/approval/cancellation to
          finish before sending.
        </text>
      </Show>
      <Show when={failedHandoff()}>
        <text fg="#ffcc80">
          Context may be incomplete / 上下文可能不完整 · f: materials / confirm degraded / retry /
          cancel. Target task has NOT been sent.
        </text>
      </Show>
      <Show when={["INTERRUPTED", "UNCERTAIN"].includes(props.conversation.runtimeStatus)}>
        <text fg="#ffcc80">
          {props.conversation.runtimeStatus === "UNCERTAIN"
            ? "Execution result unknown. Inspect history and workspace; no task will be replayed."
            : "Previous native session interrupted. The next message starts a new native session."}
        </text>
      </Show>
      <Show
        when={changes()}
        fallback={
          <NativeEvents
            model={transcript}
            disabled={!!props.form}
            {...(props.view ? { view: props.view } : {})}
            onModalChange={(open) => props.setForm(open ? "details" : null)}
          />
        }
      >
        <ChangesPane
          conversationId={conversationId}
          disabled={!!props.form}
          onModalChange={(open) => props.setForm(open ? "details" : null)}
        />
      </Show>
      <Show when={approvals()[0]}>
        {(approval) => (
          <box
            border
            flexDirection="column"
            flexShrink={0}
            height={Math.min(12, (approval().request as Permission).options.length + 7)}
            title="Native permission — user decision required"
          >
            <scrollbox height={2} flexShrink={0}>
              <text selectable>{JSON.stringify((approval().request as Permission).toolCall)}</text>
            </scrollbox>
            <For each={(approval().request as Permission).options}>
              {(option, index) => (
                <text>
                  {index() + 1}. {option.name} [{option.kind}]
                </text>
              )}
            </For>
            <Show
              when={props.form === "approval"}
              fallback={<text>Press a to choose an Agent option.</text>}
            >
              <input
                focused={!busy()}
                placeholder="Option number; Enter to decide"
                onSubmit={(value) => {
                  void run(async () => {
                    const option = (approval().request as Permission).options[Number(value) - 1];
                    if (!option) throw new Error("Choose one of the native options above");
                    await request(`/v1/approvals/${approval().id}/decision`, "POST", {
                      optionId: option.optionId,
                    });
                    if (!disposed) props.setForm(null);
                    await refreshApprovals();
                  });
                }}
              />
            </Show>
          </box>
        )}
      </Show>
      <Show when={draftReady()}>
        <box
          border
          height={Math.min(8, inputLines()) + 2}
          flexShrink={0}
          borderColor={props.form === "message" ? "#80cbc4" : "#36404b"}
          title={`Enter send · Shift+Enter / ${keys().newline} newline · Esc navigate`}
        >
          <textarea
            id="message-draft"
            initialValue={draft.text}
            placeholder="m to write a message…"
            onContentChange={() => {
              const text = textarea?.plainText ?? draft.text;
              draft.update(text);
              setInputLines(Math.max(1, text.split("\n").length));
            }}
            ref={(element) => {
              textarea = element;
              setInputLines(Math.max(1, draft.text.split("\n").length));
            }}
            onSizeChange={() => {
              if (textarea && !textarea.isDestroyed)
                setInputLines(
                  Math.max(1, textarea.virtualLineCount, textarea.plainText.split("\n").length),
                );
            }}
            focused={props.form === "message" && !busy()}
            minHeight={1}
            keyBindings={[
              { name: "return", action: "submit" },
              { name: "return", shift: true, action: "newline" },
              { ...binding(keys().newline), action: "newline" },
            ]}
            onSubmit={() => {
              void send();
            }}
            flexGrow={1}
          />
        </box>
      </Show>
      <Show when={error()}>
        <text fg="#ef9a9a">{error()}</text>
      </Show>
      <Show when={draftState() >= 0 && draft.value.pendingSubmission}>
        <text fg="#ffcc80">
          Unconfirmed request {draft.value.pendingSubmission?.requestId}. Restore Unconfirmed
          Message to inspect/retry the original; reconnect never sends it.
        </text>
      </Show>
      <text fg="#8b949e" height={1}>
        {busy() || !draftReady()
          ? "ACP operation pending"
          : "m Message · a Approval · c Cancel Turn"}
      </text>
      <Show when={handoffMenu() && props.form === "details"}>
        <box
          position="absolute"
          top={1}
          left={1}
          width="94%"
          height="70%"
          border
          backgroundColor="#10151c"
          padding={1}
          flexDirection="column"
          title="Handoff failed · Context may be incomplete · Esc close"
        >
          <text>
            Report generation may use native tools; HarnessHub cannot sandbox Agent-owned tools.
            Native permissions always require your choice.
          </text>
          <Show
            when={failedHandoff()}
            fallback={
              <text>
                No settled failed Handoff. Inspect the history; UNCERTAIN tasks cannot be resent.
              </text>
            }
          >
            {(h) => (
              <select
                focused={!busy()}
                flexGrow={1}
                showDescription={false}
                options={[
                  {
                    name: "View saved context and source evidence",
                    description: "",
                    value: "view",
                  },
                  {
                    name: "Confirm degraded context and send reserved target task",
                    description: "",
                    value: "confirm",
                  },
                  {
                    name: "Retry report / target preparation (no duplicate user message)",
                    description: "",
                    value: "retry",
                  },
                  {
                    name: "Cancel switch; do not send target task",
                    description: "",
                    value: "cancel",
                  },
                ]}
                onSelect={(_index, option) => {
                  if (!option) return;
                  if (option.value === "view") {
                    setMaterials(h());
                    return;
                  }
                  void run(async () => {
                    await request(`/v1/conversations/${conversationId}/handoff/action`, "POST", {
                      handoffId: h().id,
                      action: option.value,
                    });
                    await refreshHandoffs();
                    await refreshSessions();
                    if (!disposed) {
                      setHandoffMenu(false);
                      props.setForm(null);
                    }
                  });
                }}
              />
            )}
          </Show>
        </box>
      </Show>
      <Show when={materials() && props.form === "details"}>
        <SourceViewer
          parts={[
            {
              name: "Saved Handoff materials (may be incomplete)",
              text: `${materials()?.reportText ?? "No generated report"}\n\n${materials()?.fallbackText ?? "No fallback"}\n\n${JSON.stringify(materials(), null, 2)}`,
            },
          ]}
          onClose={() => setMaterials(null)}
        />
      </Show>
      <Show when={debug() && props.form === "details" && !handoffMenu()}>
        <RawEvents
          events={transcript.events}
          count={transcript.eventCount()}
          onClose={() => {
            setDebug(false);
            props.setForm(null);
          }}
        />
      </Show>
      <Show when={props.form === "settings"}>
        <box
          position="absolute"
          top={1}
          left={1}
          width="94%"
          height="80%"
          border
          backgroundColor="#10151c"
          padding={1}
          flexDirection="column"
          title="ACP native options · Enter apply · Esc close"
        >
          <Show
            when={sessionChoices().length}
            fallback={<text>No session options exposed by ACP. Start a native session first.</text>}
          >
            <select
              focused={!busy()}
              flexGrow={1}
              options={sessionChoices()}
              showDescription={false}
              onSelect={(_index, option) => {
                if (option)
                  void run(async () => {
                    await request(
                      `/v1/conversations/${conversationId}/settings`,
                      "POST",
                      option.value,
                    );
                    await refreshSessions();
                    if (!disposed) props.setForm(null);
                  });
              }}
            />
          </Show>
        </box>
      </Show>
    </box>
  );
}
