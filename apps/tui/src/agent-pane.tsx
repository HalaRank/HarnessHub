import type { Approval, Conversation, ConversationEvent, Turn } from "@harnesshub/shared";
import { connect, HttpError, watchConversation } from "@harnesshub/shared/client";
import type { TextareaRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { DraftSession } from "./draft-session";
import { NativeEvents } from "./native-events";

type Permission = {
  options: { optionId: string; name: string; kind: string }[];
  toolCall: unknown;
};
export function AgentPane(props: {
  conversation: Conversation;
  form: string | null;
  setForm: (value: "message" | "approval" | null) => void;
  onDraftError: (message: string) => void;
}) {
  const [events, setEvents] = createSignal<ConversationEvent[]>([]);
  const [profiles, setProfiles] = createSignal<{ id: string; name: string }[]>([]);
  const [harness, setHarness] = createSignal("codex");
  const [approvals, setApprovals] = createSignal<Approval[]>([]);
  const [turnId, setTurnId] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [connection, setConnection] = createSignal("Connecting");
  const conversationId = props.conversation.id;
  const [draftReady, setDraftReady] = createSignal(false);
  const [draftState, setDraftState] = createSignal(0);
  const draft = new DraftSession(
    conversationId,
    () => setDraftState((n) => n + 1),
    (e) => props.onDraftError(e instanceof Error ? e.message : "Draft save failed"),
  );
  let disposed = false;
  let textarea: TextareaRenderable | undefined;
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
      setError(e instanceof Error ? e.message : "ACP operation failed");
    } finally {
      setBusy(false);
    }
  };
  const refreshApprovals = async () => {
    setApprovals(await request<Approval[]>(`/v1/conversations/${conversationId}/approvals`));
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
      const sessions = await request<{ harnessId: string }[]>(
        `/v1/conversations/${conversationId}/sessions`,
      );
      if (sessions.length) setHarness(sessions[sessions.length - 1]?.harnessId ?? "codex");
      if (draft.value.pendingSubmission) setHarness(draft.value.pendingSubmission.harnessId);
      await refreshApprovals();
    });
    const stop = watchConversation(
      props.conversation.id,
      () => {},
      setConnection,
      0,
      (batch) => {
        if (!batch.length) return;
        setEvents((previous) => [...previous, ...batch]);
        for (const event of batch) {
          if (event.kind === "user.message") setTurnId(event.turnId);
          if (event.kind === "runtime.turn_finished" || event.kind === "runtime.interrupted")
            setTurnId(null);
        }
        if (
          batch.some(
            (e) =>
              e.kind.startsWith("approval.") ||
              e.kind === "runtime.turn_finished" ||
              e.kind === "runtime.interrupted",
          )
        )
          void refreshApprovals().catch(() => {});
      },
    );
    onCleanup(() => {
      disposed = true;
      stop();
      void draft
        .dispose()
        .catch((e) => props.onDraftError(e instanceof Error ? e.message : "Draft save failed"));
      if (props.form === "message" || props.form === "approval") props.setForm(null);
    });
  });
  useKeyboard((key) => {
    if (props.form || busy()) return;
    if (key.name === "m" && draftReady()) {
      key.preventDefault();
      props.setForm("message");
    }
    if (key.name === "a" && approvals().length) {
      key.preventDefault();
      props.setForm("approval");
    }
    if (key.name === "h") {
      const list = profiles();
      const index = list.findIndex((p) => p.id === harness());
      setHarness(list[(index + 1) % list.length]?.id ?? "codex");
    }
    if (key.name === "c" && turnId())
      void run(async () => {
        await request(`/v1/turns/${turnId()}/cancel`, "POST");
      });
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
      if (!disposed) props.setForm(null);
    });
  return (
    <box flexDirection="column" flexGrow={1} gap={1}>
      <text>
        ACP · {harness()} · {props.conversation.runtimeStatus} · {connection()}
      </text>
      <Show
        when={
          props.conversation.runtimeStatus === "INTERRUPTED" ||
          props.conversation.runtimeStatus === "UNCERTAIN"
        }
      >
        <text fg="#ffcc80">
          {props.conversation.runtimeStatus === "UNCERTAIN"
            ? "Execution result unknown. Inspect history and workspace; no task will be replayed."
            : "Previous native session interrupted. The next message starts a new native session."}
        </text>
      </Show>
      <scrollbox flexGrow={1} minHeight={3} border title="Native ACP output">
        <NativeEvents events={events()} disabled={!!props.form} />
      </scrollbox>
      <Show when={approvals()[0]}>
        {(approval) => (
          <box
            border
            flexDirection="column"
            flexShrink={0}
            height={(approval().request as Permission).options.length + 8}
            title="Native permission — user decision required"
          >
            <scrollbox height={3} flexShrink={0}>
              <text>{JSON.stringify((approval().request as Permission).toolCall)}</text>
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
      <Show when={props.form === "message"}>
        <box
          border
          height={5}
          flexShrink={0}
          title="Enter send · Shift+Enter / Ctrl+J newline · Esc close"
        >
          <textarea
            id="message-draft"
            initialValue={draft.text}
            onContentChange={() => {
              draft.update(textarea?.plainText ?? draft.text);
            }}
            ref={(element) => {
              textarea = element;
            }}
            focused={!busy()}
            keyBindings={[
              { name: "return", action: "submit" },
              { name: "return", shift: true, action: "newline" },
              { name: "j", ctrl: true, action: "newline" },
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
      <text>
        {busy() || !draftReady()
          ? "ACP operation pending"
          : "m Message · h Select Harness · a Native approval · c Cancel Turn"}
      </text>
    </box>
  );
}
