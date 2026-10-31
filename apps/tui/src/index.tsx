import {
  activeStates,
  type Conversation,
  type Preferences,
  type Project,
  type Snapshot,
} from "@harnesshub/shared";
import { connect, watchSnapshot } from "@harnesshub/shared/client";
import { createCliRenderer } from "@opentui/core";
import { render, useKeyboard } from "@opentui/solid";
import { batch, createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { AgentPane } from "./agent-pane";
import { flushDrafts } from "./draft-session";
import { expandProjectPath } from "./project-path";
import { ProjectPathInput } from "./project-path-input";

type Row = {
  name: string;
  description: string;
  value: { project: Project; conversation?: Conversation };
};
export function App(props: { initialProjectId?: string | undefined; onExit: () => void }) {
  const [snapshot, setSnapshot] = createSignal<Snapshot>({
    projects: [],
    conversations: [],
    cursor: 0,
    activity: { running: 0, waitingApproval: 0, pendingApprovals: 0, problems: 0, items: [] },
  });
  const [state, setState] = createSignal("Connecting");
  const [selected, setSelected] = createSignal(0);
  const [form, setForm] = createSignal<"project" | "conversation" | "message" | "approval" | null>(
    null,
  );
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [showActivity, setShowActivity] = createSignal(true);
  const [ready, setReady] = createSignal(false);
  const rows = createMemo<Row[]>(() =>
    snapshot().projects.flatMap((project) => [
      { name: project.name, description: project.rootPath, value: { project } },
      ...snapshot()
        .conversations.filter((c) => c.projectId === project.id)
        .map((conversation) => ({
          name: `  └ ${conversation.title} [${conversation.runtimeStatus}]`,
          description: conversation.runtimeStatus,
          value: { project, conversation },
        })),
    ]),
  );
  const row = () => rows()[selected()];
  let initial = true;
  let recent: Preferences | undefined;
  const exit = async () => {
    try {
      await flushDrafts();
      await preferenceSave;
      props.onExit();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save draft before exit");
    }
  };
  let preferenceSave = Promise.resolve();
  let preferenceKey = "";
  createEffect(() => {
    const value = row()?.value;
    const visible = showActivity();
    if (!ready()) return;
    const patch = {
      lastProjectId: value?.project.id ?? null,
      lastConversationId: value?.conversation?.id ?? null,
      showActivity: visible,
    };
    const nextKey = JSON.stringify(patch);
    if (preferenceKey === nextKey) return;
    preferenceKey = nextKey;
    preferenceSave = preferenceSave
      .catch(() => {})
      .then(async () => {
        const client = await connect();
        if (!client) throw new Error("Daemon disconnected; recent selection not saved");
        await client.request("/v1/preferences", "PATCH", patch);
      });
    void preferenceSave.catch((e) => {
      preferenceKey = "";
      setError(e instanceof Error ? e.message : "Preferences save failed");
    });
  });
  onMount(() => {
    let stop: (() => void) | undefined;
    let disposed = false;
    void (async () => {
      try {
        const client = await connect();
        recent = await client?.request<Preferences>("/v1/preferences");
        if (recent) setShowActivity(recent.showActivity);
      } catch {
        /* Global list remains available when preferences cannot be read. */
      }
      if (disposed) return;
      stop = watchSnapshot((next) => {
        const previous = row()?.value;
        batch(() => {
          setSnapshot(next);
          const index = rows().findIndex((r) =>
            initial && props.initialProjectId
              ? r.value.project.id === props.initialProjectId
              : initial && recent?.lastConversationId
                ? r.value.conversation?.id === recent.lastConversationId
                : initial && recent?.lastProjectId
                  ? r.value.project.id === recent.lastProjectId && !r.value.conversation
                  : previous?.conversation
                    ? r.value.conversation?.id === previous.conversation.id
                    : previous
                      ? r.value.project.id === previous.project.id && !r.value.conversation
                      : false,
          );
          setSelected(Math.max(0, index));
          initial = false;
          setReady(true);
        });
      }, setState);
    })();
    onCleanup(() => {
      disposed = true;
      stop?.();
    });
  });
  useKeyboard((key) => {
    if (key.ctrl && key.name === "q" && error()) {
      props.onExit();
      return;
    }
    if (key.ctrl && key.name === "c") {
      void exit();
      return;
    }
    if (key.name === "escape") {
      setForm(null);
      setError("");
      return;
    }
    if (form()) return;
    if (key.ctrl && key.name === "g") {
      setShowActivity((value) => !value);
      return;
    }
    if (key.name === "up" || key.name === "down") {
      key.preventDefault();
      setSelected((index) =>
        Math.max(0, Math.min(rows().length - 1, index + (key.name === "up" ? -1 : 1))),
      );
    }
    if (key.name === "q") void exit();
    if (key.name === "p") {
      key.preventDefault();
      setError("");
      setForm("project");
    }
    if (key.name === "n" && row()) {
      key.preventDefault();
      setError("");
      setForm("conversation");
    }
  });
  const submit = async (value: string) => {
    if (busy()) return;
    setBusy(true);
    setError("");
    try {
      const client = await connect();
      if (!client) throw new Error("Daemon disconnected; reconnect before saving");
      if (form() === "project")
        await client.request("/v1/projects", "POST", { rootPath: expandProjectPath(value) });
      else if (form() === "conversation" && row())
        await client.request(`/v1/projects/${row()?.value.project.id}/conversations`, "POST", {
          title: value,
        });
      setForm(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <box flexDirection="column" width="100%" height="100%" padding={1} gap={1}>
      <text fg="#80cbc4">HarnessHub · Phase 3 · {state()}</text>
      <Show when={showActivity()}>
        <text fg="#ffcc80">
          Global · Running {snapshot().activity.running} · Approval{" "}
          {snapshot().activity.waitingApproval} ({snapshot().activity.pendingApprovals} requests) ·
          Problems {snapshot().activity.problems}
        </text>
      </Show>
      <box flexGrow={1} flexDirection="row" gap={1}>
        <box width="40%" border title="Projects → Conversations" flexDirection="column">
          <Show
            when={rows().length > 0}
            fallback={<text>No projects. Press p to register an existing directory.</text>}
          >
            <select
              focused={!form()}
              options={rows()}
              selectedIndex={selected()}
              onChange={(index) => setSelected(index)}
              flexGrow={1}
              showDescription={false}
            />
          </Show>
        </box>
        <box
          flexGrow={1}
          flexShrink={1}
          border
          title="Workspace"
          flexDirection="column"
          padding={1}
          gap={1}
        >
          <Show
            when={row()}
            fallback={
              <text>Global project list. Startup shell cwd is not registered automatically.</text>
            }
          >
            <text>{row()?.value.conversation?.title ?? row()?.value.project.name}</text>
            <text>
              Workspace: {row()?.value.conversation?.workspacePath ?? row()?.value.project.rootPath}
            </text>
            <text>
              {row()?.value.conversation
                ? `Conversation · ${row()?.value.conversation?.runtimeStatus}`
                : "Press n to create a conversation in this project."}
            </text>
          </Show>
          <Show when={row()?.value.conversation?.id} keyed>
            {(conversationId) => (
              <AgentPane
                conversation={
                  snapshot().conversations.find((c) => c.id === conversationId) as Conversation
                }
                form={form()}
                setForm={setForm}
                onDraftError={setError}
              />
            )}
          </Show>
          <Show
            when={
              row()?.value.conversation &&
              snapshot().conversations.some(
                (c) =>
                  c.id !== row()?.value.conversation?.id &&
                  c.workspacePath === row()?.value.conversation?.workspacePath &&
                  activeStates.has(c.runtimeStatus),
              )
            }
          >
            <text fg="#ffcc80">
              Another Conversation is active in this shared workspace. Concurrent file edits can
              conflict.
            </text>
          </Show>
          <text>
            Projects and conversations are stored in SQLite. Closing this TUI keeps the Daemon
            running.
          </text>
        </box>
      </box>
      <Show when={form() === "project"}>
        <ProjectPathInput busy={busy()} onSubmit={(value) => void submit(value)} />
      </Show>
      <Show when={form() === "conversation"}>
        <box border title="New conversation title" height={3}>
          <input
            focused={!busy()}
            placeholder="Conversation title"
            onSubmit={(value) => {
              if (typeof value === "string") void submit(value);
            }}
            width="100%"
          />
        </box>
      </Show>
      <Show when={error()}>
        <text fg="#ef9a9a">{error()}</text>
        <text>Ctrl+Q closes this TUI without saving pending local edits.</text>
      </Show>
      <text>
        ↑/↓ Select · p Add project · n New conversation · Ctrl+G Activity · Esc Cancel · q / Ctrl+C
        Quit
      </text>
    </box>
  );
}
export async function openTui(initialProjectId?: string) {
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  renderer.once("destroy", finish);
  await render(
    () => <App initialProjectId={initialProjectId} onExit={() => renderer.destroy()} />,
    renderer,
  );
  await done;
  await renderer.closed;
}
