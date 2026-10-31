import type { Approval, Conversation, NativeSession, Shortcuts, Turn } from "@harnesshub/shared";
import { connect, HttpError, watchConversation } from "@harnesshub/shared/client";
import type { TextareaRenderable } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/solid";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { ChangesPane } from "./changes-pane";
import { DraftSession } from "./draft-session";
import { NativeEvents } from "./native-events";
import { binding, matches, shortcuts } from "./shortcuts";
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
}) {
  const transcript = new Transcript(),
    renderer = useRenderer();
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
  let disposed = false,
    textarea: TextareaRenderable | undefined;
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
    if (!disposed) setSessions(result);
  };
  onMount(() => {
    void run(async () => {
      await draft.load();
      if (disposed) {
        await draft.dispose();
        return;
      }
      setDraftReady(true);
      setProfiles(await request("/v1/harness-profiles"));
      await refreshSessions();
      if (sessions().length) setHarness(sessions().at(-1)?.harnessId ?? "codex");
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
          if (event.kind === "runtime.turn_finished" || event.kind === "runtime.interrupted")
            setTurnId(null);
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
  const nextHarness = () => {
    if (sessions().length) {
      setError(
        "This Conversation is bound to its native Harness. Create a new Conversation; Handoff is Phase 5.",
      );
      return;
    }
    const list = profiles(),
      index = list.findIndex((p) => p.id === harness());
    setHarness(list[(index + 1) % list.length]?.id ?? "codex");
  };
  let lastAction = props.action?.id ?? 0;
  createEffect(() => {
    const action = props.action;
    if (!action || action.id === lastAction) return;
    lastAction = action.id;
    if (action.name === "cancel") cancel();
    if (action.name === "harness") nextHarness();
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
        setError(
          renderer.copyToClipboardOSC52(text)
            ? "Selection copy sent to terminal clipboard"
            : "Terminal clipboard unavailable; use source view (y)",
        );
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
  });
  const send = () =>
    run(async () => {
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
    const native = object(object(sessions().at(-1)?.capabilities).session);
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
    <box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
      <text fg="#80cbc4">{`ACP · ${harness()} · Model (ACP): ${actualModel(sessions().at(-1))} · ${props.conversation.runtimeStatus} · ${connection()}`}</text>
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
          height={props.form === "message" ? 6 : 4}
          flexShrink={0}
          borderColor={props.form === "message" ? "#80cbc4" : "#36404b"}
          title={`Enter send · Shift+Enter / ${keys().newline} newline · Esc navigate`}
        >
          <textarea
            id="message-draft"
            initialValue={draft.text}
            placeholder="m to write a message…"
            onContentChange={() => {
              draft.update(textarea?.plainText ?? draft.text);
            }}
            ref={(element) => {
              textarea = element;
            }}
            focused={props.form === "message" && !busy()}
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
          Unconfirmed request {draft.value.pendingSubmission?.requestId}. Enter explicitly retries
          this same request; reconnect never sends it.
        </text>
      </Show>
      <text fg="#8b949e">
        {busy() || !draftReady()
          ? "ACP operation pending"
          : "m Message · h Select Harness · a Native approval · c Cancel Turn"}
      </text>
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
