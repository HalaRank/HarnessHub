import {
  activeStates,
  type Conversation,
  type ManagedWorktree,
  type Preferences,
  type Project,
  type Shortcuts,
  type Snapshot,
  shortcutInput,
} from "@harnesshub/shared";
import { connect, watchSnapshot } from "@harnesshub/shared/client";
import { createCliRenderer } from "@opentui/core";
import { render, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";
import { batch, createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { type AgentAction, AgentPane } from "./agent-pane";
import { interruptTui, useClipboard } from "./clipboard";
import { type Command, CommandPalette } from "./command-palette";
import { flushDrafts } from "./draft-session";
import { expandProjectPath } from "./project-path";
import { ProjectPathInput } from "./project-path-input";
import { matches, shortcuts } from "./shortcuts";
import { newViewState, type ViewState } from "./transcript";

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
  const [form, setForm] = createSignal<
    | "project"
    | "conversation"
    | "message"
    | "approval"
    | "palette"
    | "shortcuts"
    | "details"
    | "settings"
    | "delete"
    | "worktrees"
    | "cleanup"
    | null
  >(null);
  const renderer = useRenderer();
  const copyText = useClipboard();
  const [workspaceMode, setWorkspaceMode] = createSignal<"shared" | "worktree">("shared");
  const [worktrees, setWorktrees] = createSignal<ManagedWorktree[]>([]);
  const [cleanupTarget, setCleanupTarget] = createSignal<ManagedWorktree | null>(null);
  const [notice, setNotice] = createSignal("");
  const [showArchived, setShowArchived] = createSignal(false);
  let clearInput: (() => boolean) | undefined;
  const [deleteTarget, setDeleteTarget] = createSignal<Conversation | null>(null);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [showActivity, setShowActivity] = createSignal(true);
  const dimensions = useTerminalDimensions();
  const [showSidebar, setShowSidebar] = createSignal(true);
  const [keyOverrides, setKeyOverrides] = createSignal<Shortcuts>({});
  const keys = () => shortcuts(keyOverrides());
  const sidebarVisible = () => showSidebar() && dimensions().width >= 90;
  const [action, setAction] = createSignal<AgentAction>({ id: 0, name: "" });
  const [changesView, setChangesView] = createSignal(false);
  const views = new Map<string, ViewState>();
  const view = (id: string) => {
    let value = views.get(id);
    if (!value) {
      value = newViewState();
      views.set(id, value);
    }
    return value;
  };
  const [ready, setReady] = createSignal(false);
  const rows = createMemo<Row[]>(() =>
    snapshot().projects.flatMap((project) => [
      { name: project.name, description: project.rootPath, value: { project } },
      ...snapshot()
        .conversations.filter(
          (c) => c.projectId === project.id && (showArchived() || c.archivedAt === null),
        )
        .map((conversation) => ({
          name: `  └ ${conversation.title}${conversation.archivedAt !== null ? " [archived]" : ""}`,
          description: conversation.runtimeStatus,
          value: { project, conversation },
        })),
    ]),
  );
  const row = () => rows()[selected()];
  let initial = true;
  let recent: Preferences | undefined;
  let exiting = false;
  const exit = async () => {
    if (exiting) return;
    exiting = true;
    try {
      await flushDrafts();
      await preferenceSave;
      props.onExit();
    } catch (e) {
      exiting = false;
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
      showSidebar: showSidebar(),
      shortcuts: keyOverrides(),
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
        if (recent) {
          setShowActivity(recent.showActivity);
          setShowSidebar(recent.showSidebar);
          setKeyOverrides(recent.shortcuts);
        }
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
  const interrupt = () =>
    interruptTui(
      renderer,
      (text) => {
        void copyText(text).then(setNotice);
      },
      () => {
        const editor = renderer.currentFocusedEditor;
        if (editor && editor.id !== "message-draft" && editor.plainText.length) {
          editor.setText("");
          return true;
        }
        return clearInput?.() ?? false;
      },
      () => {
        void exit();
      },
    );
  onMount(() => {
    const selection = () => {
      const text = renderer.getSelection()?.getSelectedText();
      if (text) void copyText(text).then(setNotice);
    };
    renderer.on("selection", selection);
    process.on("SIGINT", interrupt);
    onCleanup(() => {
      renderer.off("selection", selection);
      process.off("SIGINT", interrupt);
    });
  });
  useKeyboard((key) => {
    if (key.ctrl && key.name === "q" && error()) {
      props.onExit();
      return;
    }
    if (key.ctrl && key.name === "c") {
      key.preventDefault();
      key.stopPropagation();
      interrupt();
      return;
    }
    if (
      matches(key, keys().palette) &&
      !["details", "settings", "shortcuts"].includes(form() ?? "")
    ) {
      key.preventDefault();
      setForm((current) => (current === "palette" ? null : "palette"));
      return;
    }
    if (matches(key, keys().sidebar)) {
      key.preventDefault();
      setShowSidebar((value) => !value);
      return;
    }
    if (key.name === "escape") {
      setForm(null);
      setError("");
      return;
    }
    if (form() === "conversation" && key.ctrl && key.name === "w") {
      key.preventDefault();
      key.stopPropagation();
      setWorkspaceMode((v) => (v === "shared" ? "worktree" : "shared"));
      return;
    }
    if (form()) return;
    if (key.ctrl && key.name === "g") {
      setShowActivity((value) => !value);
      return;
    }
    if (!changesView() && (key.name === "up" || key.name === "down")) {
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
      setWorkspaceMode("shared");
      setForm("conversation");
    }
  });
  const dispatch = (name: string) => {
    if (name === "changes") setChangesView((v) => !v);
    setAction((v) => ({ id: v.id + 1, name }));
  };
  const lifecycle = async (conversation: Conversation, operation: "archive" | "delete") => {
    if (busy()) return;
    setBusy(true);
    setError("");
    try {
      await flushDrafts();
      const client = await connect();
      if (!client) throw new Error("Daemon disconnected");
      await client.request(
        `/v1/conversations/${conversation.id}`,
        operation === "delete" ? "DELETE" : "PATCH",
        operation === "delete"
          ? { confirmed: true }
          : { archived: conversation.archivedAt === null },
      );
      if (operation === "delete") views.delete(conversation.id);
      setForm(null);
      setDeleteTarget(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Conversation operation failed");
    } finally {
      setBusy(false);
    }
  };
  const commands = createMemo<Command[]>(() => [
    ...rows().map((r) => ({
      id: r.value.conversation?.id ?? r.value.project.id,
      name: r.value.conversation
        ? `Conversation · ${r.value.project.name} / ${r.value.conversation.title} [${r.value.conversation.runtimeStatus}]`
        : `Project · ${r.value.project.name} · ${r.value.project.rootPath}`,
      run: () => {
        setSelected(
          rows().findIndex(
            (value) =>
              (value.value.conversation?.id ?? value.value.project.id) ===
              (r.value.conversation?.id ?? r.value.project.id),
          ),
        );
        setChangesView(false);
      },
    })),
    {
      id: "archives",
      name: showArchived() ? "Hide Archived Conversations" : "View Archived Conversations",
      run: () => {
        setShowArchived((v) => !v);
        setSelected(0);
      },
    },
    { id: "project", name: "Add Project", run: () => setForm("project") },
    {
      id: "new",
      name: "New Conversation",
      run: () => {
        if (row()) {
          setWorkspaceMode("shared");
          setForm("conversation");
        }
      },
    },
    {
      id: "worktrees",
      name: "Manage Worktrees / Safe Cleanup…",
      run: () => {
        void (async () => {
          try {
            const client = await connect();
            if (!client) throw new Error("Daemon disconnected");
            setWorktrees(await client.request<ManagedWorktree[]>("/v1/worktrees"));
            setForm("worktrees");
          } catch (e) {
            setError(e instanceof Error ? e.message : "Worktree query failed");
          }
        })();
      },
    },
    { id: "sidebar", name: "Toggle Sidebar", run: () => setShowSidebar((v) => !v) },
    { id: "activity", name: "Toggle Global Activity", run: () => setShowActivity((v) => !v) },
    { id: "keys", name: "Configure Shortcuts", run: () => setForm("shortcuts") },
    {
      id: "quit",
      name: "Quit TUI (keep Agents running)",
      run: () => {
        void exit();
      },
    },
    ...(row()?.value.conversation
      ? [
          {
            id: "raw",
            name: "Raw Events / Debug (complete ACP protocol)",
            run: () => dispatch("raw"),
          },
          {
            id: "archive",
            name:
              row()?.value.conversation?.archivedAt === null
                ? "Archive Conversation"
                : "Restore Archived Conversation",
            run: () => {
              const c = row()?.value.conversation;
              if (c) void lifecycle(c, "archive");
            },
          },
          {
            id: "delete",
            name: "Delete Conversation…",
            run: () => {
              const c = row()?.value.conversation;
              if (c) {
                setDeleteTarget(c);
                setForm("delete");
              }
            },
          },
          {
            id: "restore_pending",
            name: "Restore Unconfirmed Message (without sending)",
            run: () => dispatch("restore_pending"),
          },
          { id: "message", name: "Write Message", run: () => setForm("message") },
          { id: "changes", name: "Toggle Changes / Chat", run: () => dispatch("changes") },
          { id: "approval", name: "Choose Native Approval", run: () => setForm("approval") },
          { id: "cancel", name: "Cancel Current Turn (ACP)", run: () => dispatch("cancel") },
          {
            id: "harness",
            name: "Select Next Harness (Handoff on first message)",
            run: () => dispatch("harness"),
          },
          {
            id: "cancel_switch",
            name: "Cancel Pending Harness Switch",
            run: () => dispatch("cancel_switch"),
          },
          {
            id: "handoff",
            name: "Handoff Failure / Saved Context / Degraded Confirmation",
            run: () => dispatch("handoff"),
          },
          { id: "settings", name: "ACP Native Session Options", run: () => setForm("settings") },
        ]
      : []),
  ]);
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
          workspaceMode: workspaceMode(),
        });
      setForm(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <box flexDirection="column" width="100%" height="100%" paddingX={1} gap={0}>
      <text fg="#80cbc4" height={1} flexShrink={0}>
        {`HarnessHub · ${state()}${showActivity() ? ` · Global · Running ${snapshot().activity.running} · Approval ${snapshot().activity.pendingApprovals} · Problems ${snapshot().activity.problems}` : ""}${showArchived() ? " · Archives visible" : ""}`}
      </text>
      <box flexGrow={1} minHeight={0} flexDirection="row" gap={1}>
        <Show when={sidebarVisible()}>
          <box
            width={Math.min(34, Math.floor(dimensions().width * 0.28))}
            border
            borderColor="#36404b"
            title="Projects → Conversations"
            flexDirection="column"
          >
            <Show
              when={rows().length > 0}
              fallback={<text>No projects. Press p to register an existing directory.</text>}
            >
              <select
                focused={false}
                options={rows()}
                selectedIndex={selected()}
                onChange={(index) => setSelected(index)}
                flexGrow={1}
                showDescription={true}
              />
            </Show>
          </box>
        </Show>
        <box flexGrow={1} flexShrink={1} minWidth={0} flexDirection="column" minHeight={0} gap={0}>
          <Show
            when={row()}
            fallback={
              <text>Global project list. Startup shell cwd is not registered automatically.</text>
            }
          >
            <text height={1} flexShrink={0} fg="#8b949e">
              {row()?.value.conversation
                ? `Conversation · ${row()?.value.conversation?.title}${row()?.value.conversation?.archivedAt !== null ? " [archived]" : ""} · Workspace: ${row()?.value.conversation?.workspacePath}`
                : `${row()?.value.project.name} · Workspace: ${row()?.value.project.rootPath} · Press n to create a conversation`}
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
                view={view(conversationId)}
                shortcuts={keyOverrides()}
                action={action()}
                onChangesChange={setChangesView}
                registerClearInput={(clear) => {
                  clearInput = clear;
                }}
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
        </box>
      </box>
      <Show when={form() === "project"}>
        <ProjectPathInput busy={busy()} onSubmit={(value) => void submit(value)} />
      </Show>
      <Show when={form() === "conversation"}>
        <box
          border
          title={`New conversation title · ${workspaceMode()} · Ctrl+W choose shared / worktree`}
          height={3}
        >
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
      <Show when={form() === "worktrees"}>
        <box
          position="absolute"
          top={2}
          left={2}
          width="94%"
          height="80%"
          border
          backgroundColor="#10151c"
          flexDirection="column"
          padding={1}
          title="Managed Worktrees · Enter inspect cleanup · Esc cancel"
        >
          <text>
            Conversation deletion preserves worktrees. Cleanup requires no bound Conversation, clean
            files and matching ownership. Branches are preserved.
          </text>
          <select
            focused
            flexGrow={1}
            showDescription
            options={worktrees()
              .filter((w) => w.status !== "REMOVED")
              .map((w) => ({ name: `${w.status} · ${w.branch}`, description: w.path, value: w }))}
            onSelect={(_index, option) => {
              if (option) {
                setCleanupTarget(option.value as ManagedWorktree);
                setForm("cleanup");
              }
            }}
          />
        </box>
      </Show>
      <Show when={form() === "cleanup" && cleanupTarget()}>
        {(w) => (
          <box
            position="absolute"
            top={3}
            left={3}
            width="92%"
            height={10}
            border
            backgroundColor="#10151c"
            padding={1}
            flexDirection="column"
            title="Confirm safe Worktree cleanup · Esc cancel"
          >
            <text>{`Remove managed directory: ${(w() as ManagedWorktree).path}`}</text>
            <text>{`Preserve branch: ${(w() as ManagedWorktree).branch}`}</text>
            <text>
              Dirty, ignored, bound, locked or mismatched worktrees are refused. No force removal.
            </text>
            <input
              focused={!busy()}
              placeholder="Type CLEAN to confirm removal"
              onSubmit={(value) => {
                if (value !== "CLEAN") {
                  setError("Type CLEAN to confirm, or Esc to cancel");
                  return;
                }
                void (async () => {
                  setBusy(true);
                  try {
                    const client = await connect();
                    if (!client) throw new Error("Daemon disconnected");
                    await client.request(
                      `/v1/worktrees/${(w() as ManagedWorktree).id}/cleanup`,
                      "POST",
                      { confirmed: true },
                    );
                    setForm(null);
                    setNotice("Managed Worktree removed; branch preserved");
                  } catch (e) {
                    setError(e instanceof Error ? e.message : "Cleanup failed");
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
            />
          </box>
        )}
      </Show>
      <Show when={form() === "palette"}>
        <CommandPalette commands={commands()} onClose={() => setForm(null)} />
      </Show>
      <Show when={form() === "delete" && deleteTarget()}>
        {(target) => (
          <box
            position="absolute"
            top={3}
            left={3}
            width="88%"
            height={8}
            border
            backgroundColor="#10151c"
            padding={1}
            flexDirection="column"
            title="Confirm Conversation deletion · Esc cancel"
          >
            <text>{`Permanently delete “${(target() as Conversation).title}” and its application history?`}</text>
            <text>
              Project files, Git branches and workspaces are preserved. Active / pending approval /
              UNCERTAIN tasks cannot be deleted.
            </text>
            <input
              focused={!busy()}
              placeholder="Type DELETE then Enter to confirm"
              onSubmit={(value) => {
                if (value === "DELETE") void lifecycle(target() as Conversation, "delete");
                else setError("Type DELETE to confirm, or Esc to cancel");
              }}
            />
          </box>
        )}
      </Show>
      <Show when={form() === "shortcuts"}>
        <box
          position="absolute"
          top={2}
          left={2}
          width="92%"
          height={10}
          border
          backgroundColor="#10151c"
          padding={1}
          flexDirection="column"
          title="Shortcuts · JSON overrides · Esc close"
        >
          <text>
            Use Ctrl/Meta combinations. Enter send and Shift+Enter newline remain fixed. Empty
            object restores defaults.
          </text>
          <text>{JSON.stringify(keys())}</text>
          <input
            focused
            value={JSON.stringify(keyOverrides())}
            onSubmit={(value) => {
              try {
                const parsed = shortcutInput.parse(JSON.parse(String(value)));
                setKeyOverrides(parsed);
                setError("");
                setForm(null);
              } catch {
                setError(
                  "Invalid shortcuts: use distinct Ctrl/Meta keys; Enter, Shift+Enter, Esc and quit are reserved",
                );
              }
            }}
          />
        </box>
      </Show>
      <Show when={error()}>
        <text fg="#ef9a9a">{error()}</text>
        <text>Ctrl+Q closes this TUI without saving pending local edits.</text>
      </Show>
      <Show when={notice()}>
        <text height={1} fg="#8b949e">
          {notice()}
        </text>
      </Show>
      <text height={1} flexShrink={0} fg="#8b949e">
        {`${keys().palette} Commands · ${keys().sidebar} Sidebar · ${keys().changes} Changes · Ctrl+C Copy / Clear / Quit`}
      </text>
    </box>
  );
}
export async function openTui(initialProjectId?: string) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    exitSignals: ["SIGTERM", "SIGHUP"],
    useKittyKeyboard: { disambiguate: true, alternateKeys: true },
  });
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
