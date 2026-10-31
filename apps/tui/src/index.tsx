import type { Conversation, Project, Snapshot } from "@harnesshub/shared";
import { connect, watchSnapshot } from "@harnesshub/shared/client";
import { createCliRenderer } from "@opentui/core";
import { render, useKeyboard } from "@opentui/solid";
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";

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
  });
  const [state, setState] = createSignal("Connecting");
  const [selected, setSelected] = createSignal(0);
  const [form, setForm] = createSignal<"project" | "conversation" | null>(null);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const rows = createMemo<Row[]>(() =>
    snapshot().projects.flatMap((project) => [
      { name: project.name, description: project.rootPath, value: { project } },
      ...snapshot()
        .conversations.filter((c) => c.projectId === project.id)
        .map((conversation) => ({
          name: `  └ ${conversation.title}`,
          description: "IDLE · Agent unavailable",
          value: { project, conversation },
        })),
    ]),
  );
  const row = () => rows()[selected()];
  let initial = true;
  onMount(() => {
    const stop = watchSnapshot((next) => {
      const previous = row()?.value;
      setSnapshot(next);
      const index = rows().findIndex((r) =>
        initial && props.initialProjectId
          ? r.value.project.id === props.initialProjectId
          : previous?.conversation
            ? r.value.conversation?.id === previous.conversation.id
            : previous
              ? r.value.project.id === previous.project.id && !r.value.conversation
              : false,
      );
      setSelected(Math.max(0, index));
      initial = false;
    }, setState);
    onCleanup(stop);
  });
  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      props.onExit();
      return;
    }
    if (key.name === "escape") {
      setForm(null);
      setError("");
      return;
    }
    if (form()) return;
    if (key.name === "up" || key.name === "down") {
      key.preventDefault();
      setSelected((index) =>
        Math.max(0, Math.min(rows().length - 1, index + (key.name === "up" ? -1 : 1))),
      );
    }
    if (key.name === "q") props.onExit();
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
      if (form() === "project") await client.request("/v1/projects", "POST", { rootPath: value });
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
      <text fg="#80cbc4">HarnessHub · Phase 1 · {state()}</text>
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
                ? "Empty conversation · IDLE"
                : "Press n to create a conversation in this project."}
            </text>
          </Show>
          <text fg="#ffcc80">ACP Agents and message sending are not implemented in phase 1.</text>
          <text>
            Projects and conversations are stored in SQLite. Closing this TUI keeps the Daemon
            running.
          </text>
        </box>
      </box>
      <Show when={form()}>
        <box
          border
          title={
            form() === "project"
              ? "Existing project: absolute Linux directory"
              : "New conversation title"
          }
          height={3}
        >
          <input
            focused={!busy()}
            placeholder={
              form() === "project" ? "/home/user/projects/example" : "Conversation title"
            }
            onSubmit={(value) => {
              if (typeof value === "string") void submit(value);
            }}
            width="100%"
          />
        </box>
      </Show>
      <Show when={error()}>
        <text fg="#ef9a9a">{error()}</text>
      </Show>
      <text>↑/↓ Select · p Add project · n New conversation · Esc Cancel · q / Ctrl+C Quit</text>
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
