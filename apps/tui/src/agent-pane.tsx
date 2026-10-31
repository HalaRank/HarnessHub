import { randomUUID } from "node:crypto";
import type { Approval, Conversation, ConversationEvent, Turn } from "@harnesshub/shared";
import { connect, HttpError, watchConversation } from "@harnesshub/shared/client";
import type { TextareaRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { NativeEvents } from "./native-events";

type Permission = {
  options: { optionId: string; name: string; kind: string }[];
  toolCall: unknown;
};
export function AgentPane(props: {
  conversation: Conversation;
  form: string | null;
  setForm: (value: "message" | "approval" | null) => void;
}) {
  const [events, setEvents] = createSignal<ConversationEvent[]>([]);
  const [profiles, setProfiles] = createSignal<{ id: string; name: string }[]>([]);
  const [harness, setHarness] = createSignal("codex");
  const [approvals, setApprovals] = createSignal<Approval[]>([]);
  const [turnId, setTurnId] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [connection, setConnection] = createSignal("Connecting");
  let draft = "";
  let textarea: TextareaRenderable | undefined;
  let submission: { requestId: string; message: string; harnessId: string } | undefined;
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
    setApprovals(await request<Approval[]>(`/v1/conversations/${props.conversation.id}/approvals`));
  };
  onMount(() => {
    void run(async () => {
      setProfiles(await request("/v1/harness-profiles"));
      const sessions = await request<{ harnessId: string }[]>(
        `/v1/conversations/${props.conversation.id}/sessions`,
      );
      if (sessions.length) setHarness(sessions[sessions.length - 1]?.harnessId ?? "codex");
      await refreshApprovals();
    });
    const stop = watchConversation(
      props.conversation.id,
      (event) => {
        setEvents((previous) => [...previous, event]);
        if (event.kind === "user.message") setTurnId(event.turnId);
        if (event.kind === "runtime.turn_finished" || event.kind === "runtime.interrupted")
          setTurnId(null);
        if (event.kind.startsWith("approval.") || event.kind === "runtime.turn_finished")
          void refreshApprovals().catch(() => {});
      },
      setConnection,
    );
    onCleanup(stop);
  });
  useKeyboard((key) => {
    if (props.form || busy()) return;
    if (key.name === "m") {
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
      if (submission && (submission.message !== message || submission.harnessId !== harness()))
        throw new Error(
          `Unconfirmed request ${submission.requestId}; retry its original message before submitting another`,
        );
      submission ??= { requestId: randomUUID(), message, harnessId: harness() };
      try {
        const turn = await request<Turn>(
          `/v1/conversations/${props.conversation.id}/turns`,
          "POST",
          submission,
        );
        submission = undefined;
        draft = "";
        setTurnId(turn.endedAt ? null : turn.id);
      } catch (error) {
        if (error instanceof HttpError && [400, 404, 409].includes(error.status))
          submission = undefined;
        throw error;
      }
      props.setForm(null);
    });
  return (
    <box flexDirection="column" flexGrow={1} gap={1}>
      <text>
        ACP · {harness()} · {props.conversation.runtimeStatus} · {connection()}
      </text>
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
                    props.setForm(null);
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
            initialValue={draft}
            onContentChange={() => {
              draft = textarea?.plainText ?? draft;
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
      <text>
        {busy()
          ? "ACP operation pending"
          : "m Message · h Select Harness · a Native approval · c Cancel Turn"}
      </text>
    </box>
  );
}
