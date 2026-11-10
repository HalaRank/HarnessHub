import {
  activeStates,
  type Conversation,
  type ManagedWorktree,
  type Preferences,
  type Shortcuts,
  type Snapshot,
  shortcutInput,
} from "@harnesshub/shared";
import { connect, watchSnapshot } from "@harnesshub/shared/client";
import { createCliRenderer, type KeyEvent, type TextareaRenderable } from "@opentui/core";
import { render, useRenderer, useTerminalDimensions } from "@opentui/solid";
import { batch, createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { ActionButton } from "./action-button";
import { type AgentAction, AgentPane } from "./agent-pane";
import { interruptTui, useClipboard } from "./clipboard";
import { type Command, CommandPalette } from "./command-palette";
import { DeleteConfirmation } from "./delete-confirmation";
import { flushDrafts } from "./draft-session";
import { expandProjectPath } from "./project-path";
import { ProjectPathInput } from "./project-path-input";
import {
  ConversationActions,
  conversationKey,
  mouseClick,
  type ProjectRow,
  ProjectTree,
  projectKey,
} from "./project-tree";
import { matches, navigationShortcuts, shortcuts } from "./shortcuts";
import { newViewState, type ViewState } from "./transcript";
import { inputStyle, KeyHints, listStyle, Panel, statusColor, ui } from "./ui";
import { WorkspaceOverview } from "./workspace-overview";

export function App(props: {
  initialProjectId?: string | undefined;
  launchCwd?: string | undefined;
  onExit: () => void;
}) {
  const launchCwd = props.launchCwd ?? process.cwd();
  const [snapshot, setSnapshot] = createSignal<Snapshot>({
    projects: [],
    conversations: [],
    cursor: 0,
    activity: { running: 0, waitingApproval: 0, pendingApprovals: 0, problems: 0, items: [] },
  });
  const [state, setState] = createSignal("Connecting");
  const [selected, setSelected] = createSignal<string | null>(null);
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set());
  const [actionsTarget, setActionsTarget] = createSignal<Conversation | null>(null);
  const [form, setForm] = createSignal<
    | "project"
    | "rename"
    | "message"
    | "transcript"
    | "approval"
    | "palette"
    | "conversationActions"
    | "actions"
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
  const sidebarClick = mouseClick();
  const [renameTarget, setRenameTarget] = createSignal<Conversation | null>(null);
  const [worktrees, setWorktrees] = createSignal<ManagedWorktree[]>([]);
  const [cleanupTarget, setCleanupTarget] = createSignal<ManagedWorktree | null>(null);
  const [notice, setNotice] = createSignal("");
  createEffect(() => {
    if (!notice()) return;
    const timer = setTimeout(() => setNotice(""), 5000);
    onCleanup(() => clearTimeout(timer));
  });
  const [showArchived, setShowArchived] = createSignal(false);
  let clearInput: (() => boolean) | undefined;
  const [deleteTarget, setDeleteTarget] = createSignal<Omit<ProjectRow, "id"> | null>(null);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [showActivity, setShowActivity] = createSignal(true);
  const dimensions = useTerminalDimensions();
  const [showSidebar, setShowSidebar] = createSignal(true);
  const [keyOverrides, setKeyOverrides] = createSignal<Shortcuts>({});
  const keys = () => shortcuts(keyOverrides());
  const [narrowSidebar, setNarrowSidebar] = createSignal(false);
  const sidebarVisible = () => showSidebar() && (dimensions().width >= 90 || narrowSidebar());
  const toggleSidebar = () => {
    if (dimensions().width < 90) {
      const visible = sidebarVisible();
      setShowSidebar(true);
      setNarrowSidebar(!visible);
    } else setShowSidebar((value) => !value);
  };
  createEffect(() => {
    if (dimensions().width >= 90) setNarrowSidebar(false);
  });
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
  const allRows = createMemo<ProjectRow[]>(() => [
    ...snapshot()
      .conversations.filter(
        (c) =>
          c.projectId === null && (showArchived() ? c.archivedAt !== null : c.archivedAt === null),
      )
      .map((conversation) => ({
        id: conversationKey(conversation.id),
        project: null,
        conversation,
      })),
    ...snapshot().projects.flatMap((project) => [
      { id: projectKey(project.id), project },
      ...snapshot()
        .conversations.filter(
          (c) =>
            c.projectId === project.id &&
            (showArchived() ? c.archivedAt !== null : c.archivedAt === null),
        )
        .map((conversation) => ({ id: conversationKey(conversation.id), project, conversation })),
    ]),
  ]);
  const rows = createMemo(() =>
    allRows().filter((r) => !r.conversation || !r.project || !collapsed().has(r.project.id)),
  );
  // Selection survives collapse, sorting and metadata object replacement.
  const row = () => {
    const value = allRows().find((r) => r.id === selected());
    return value ? { value } : undefined;
  };
  const expand = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  const selectRow = (target: ProjectRow) => {
    renderer.clearSelection();
    batch(() => {
      if (target.project) expand(target.project.id);
      setSelected(target.id);
      setChangesView(false);
      setForm(null);
    });
  };
  const toggleProject = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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
      lastProjectId: value?.project?.id ?? null,
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
          const target =
            allRows().find((r) =>
              initial && props.initialProjectId
                ? r.project?.id === props.initialProjectId && !r.conversation
                : initial && recent?.lastConversationId
                  ? r.conversation?.id === recent.lastConversationId
                  : initial && recent?.lastProjectId
                    ? r.project?.id === recent.lastProjectId && !r.conversation
                    : r.id === selected(),
            ) ??
            allRows().find((r) => r.project?.id === previous?.project?.id && !r.conversation) ??
            allRows()[0];
          if (target?.id !== selected()) {
            if (["message", "transcript", "approval", "details", "settings"].includes(form() ?? ""))
              setForm(null);
            setChangesView(false);
          }
          setSelected(target?.id ?? null);
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
  let paletteReturn: "message" | null = null;
  let paletteCursor: number | undefined;
  const openPalette = () => {
    paletteReturn = form() === "message" ? "message" : null;
    paletteCursor = (
      renderer.root.findDescendantById("message-draft") as TextareaRenderable | undefined
    )?.cursorOffset;
    setForm("palette");
  };
  const closePalette = () => {
    setForm(paletteReturn);
    const editor = renderer.root.findDescendantById("message-draft") as
      | TextareaRenderable
      | undefined;
    if (editor && paletteReturn === "message" && paletteCursor !== undefined)
      editor.cursorOffset = paletteCursor;
  };
  const keyboard = (key: KeyEvent) => {
    if (key.defaultPrevented || key.propagationStopped) return;
    if (key.ctrl && key.name === "c") {
      key.preventDefault();
      key.stopPropagation();
      interrupt();
      return;
    }
    if (
      (!form() || form() === "message" || form() === "transcript") &&
      row()?.value.conversation &&
      matches(key, navigationShortcuts.harness)
    ) {
      key.preventDefault();
      key.stopPropagation();
      dispatch("harness");
      return;
    }
    if (
      (!form() || form() === "message" || form() === "transcript") &&
      matches(key, navigationShortcuts.standaloneConversation)
    ) {
      key.preventDefault();
      key.stopPropagation();
      void createConversation("shared", true);
      return;
    }
    if (form() && form() !== "message") {
      if (form() === "palette" && matches(key, keys().palette)) {
        key.preventDefault();
        key.stopPropagation();
        closePalette();
      } else if (key.name === "escape" && !["details", "settings"].includes(form() ?? "")) {
        key.preventDefault();
        key.stopPropagation();
        if (form() === "palette") closePalette();
        else setForm(null);
        setError("");
      }
      return; // The top modal owns its editor and navigation keys.
    }
    if (matches(key, keys().palette)) {
      key.preventDefault();
      key.stopPropagation();
      openPalette();
      return;
    }
    if (matches(key, keys().sidebar)) {
      key.preventDefault();
      key.stopPropagation();
      toggleSidebar();
      return;
    }
    if (form() === "message") return; // Slash/textarea owns Esc and editing.
    if (!changesView() && row() && matches(key, "delete")) {
      key.preventDefault();
      key.stopPropagation();
      requestDelete(row()?.value);
      return;
    }
    if (
      !form() &&
      !changesView() &&
      row()?.value.project &&
      (matches(key, navigationShortcuts.conversation) || matches(key, "shift+n"))
    ) {
      key.preventDefault();
      key.stopPropagation();
      void createConversation("shared");
      return;
    }
    if (key.sequence === "/" || key.sequence === "?") {
      key.preventDefault();
      key.stopPropagation();
      paletteReturn = null;
      setForm("palette");
      return;
    }
    if (key.name === "escape") {
      const conversation = row()?.value.conversation;
      if (conversation && activeStates.has(conversation.runtimeStatus)) {
        key.preventDefault();
        key.stopPropagation();
        dispatch("cancel");
        return;
      }
      setForm(null);
      setError("");
      return;
    }
    if (matches(key, navigationShortcuts.activity)) {
      key.preventDefault();
      key.stopPropagation();
      setShowActivity((value) => !value);
      return;
    }
    if (!changesView() && (matches(key, "up") || matches(key, "down"))) {
      key.preventDefault();
      const visible = rows();
      let index = visible.findIndex((r) => r.id === selected());
      if (index < 0) index = visible.findIndex((r) => r.project?.id === row()?.value.project?.id);
      const target =
        visible[Math.max(0, Math.min(visible.length - 1, index + (key.name === "up" ? -1 : 1)))];
      if (target) selectRow(target);
    }
    if (matches(key, navigationShortcuts.quit)) {
      key.preventDefault();
      key.stopPropagation();
      void exit();
    }
    if (matches(key, navigationShortcuts.project)) {
      key.preventDefault();
      key.stopPropagation();
      setError("");
      setForm("project");
    }
    if (matches(key, navigationShortcuts.actions) && row()) {
      key.preventDefault();
      key.stopPropagation();
      setError("");
      setForm("actions");
    }
  };
  onMount(() => {
    // Safety and modal routing run before child useKeyboard callbacks, regardless
    // of Solid's mount order. Consumed events cannot fall through after a form changes.
    renderer.keyInput.prependListener("keypress", keyboard);
    onCleanup(() => renderer.keyInput.off("keypress", keyboard));
  });
  const dispatch = (name: string) => {
    if (name === "changes") setChangesView((v) => !v);
    setAction((v) => ({ id: v.id + 1, name }));
  };
  const lifecycle = async (conversation: Conversation) => {
    if (busy()) return;
    setBusy(true);
    setError("");
    try {
      await flushDrafts();
      const client = await connect();
      if (!client) throw new Error("Daemon disconnected");
      await client.request(`/v1/conversations/${conversation.id}`, "PATCH", {
        archived: conversation.archivedAt === null,
      });
      setForm(null);
      setNotice(
        conversation.archivedAt === null ? "Conversation archived" : "Conversation restored",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Conversation operation failed");
    } finally {
      setBusy(false);
    }
  };
  const requestDelete = (target: Omit<ProjectRow, "id"> | undefined) => {
    if (!target || busy()) return;
    setError("");
    setDeleteTarget(target);
    setForm("delete");
  };
  const deleteSelected = async () => {
    const target = deleteTarget();
    if (!target || busy()) return;
    setBusy(true);
    setError("");
    try {
      await flushDrafts();
      await preferenceSave;
      const client = await connect();
      if (!client) throw new Error("Daemon disconnected");
      const conversation = target.conversation;
      await client.request(
        conversation
          ? `/v1/conversations/${conversation.id}`
          : `/v1/projects/${target.project?.id}`,
        "DELETE",
        { confirmed: true },
        60000,
      );
      for (const c of snapshot().conversations)
        if (conversation ? c.id === conversation.id : c.projectId === target.project?.id)
          views.delete(c.id);
      setForm(null);
      setDeleteTarget(null);
      setNotice(conversation ? "Conversation deleted" : "Project deleted");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Deletion failed");
    } finally {
      setBusy(false);
    }
  };
  const createConversation = async (workspaceMode: "shared" | "worktree", standalone = false) => {
    const project = standalone ? null : row()?.value.project;
    if ((!standalone && !project) || busy()) return;
    setBusy(true);
    setError("");
    try {
      await flushDrafts();
      const client = await connect();
      if (!client) throw new Error("Daemon disconnected");
      const conversation = await client.request<Conversation>(
        project ? `/v1/projects/${project.id}/conversations` : "/v1/conversations",
        "POST",
        project ? { workspaceMode } : { workspacePath: launchCwd },
      );
      // Select the returned ID immediately, even if the WS snapshot has not arrived yet.
      batch(() => {
        setSnapshot((current) => ({
          ...current,
          conversations: [
            ...current.conversations.filter((c) => c.id !== conversation.id),
            conversation,
          ],
        }));
        setShowArchived(false);
        selectRow({ id: conversationKey(conversation.id), project: project ?? null, conversation });
        setForm("message");
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Conversation creation failed");
    } finally {
      setBusy(false);
    }
  };
  const requestRename = (conversation: Conversation) => {
    if (busy()) return;
    setRenameTarget(conversation);
    setError("");
    setForm("rename");
  };
  const contextCommands = createMemo<Command[]>(() => {
    const target = row()?.value;
    if (!target) return [];
    const conversation = target.conversation;
    return [
      ...(conversation
        ? [
            {
              id: "rename",
              name: "Rename Conversation…",
              run: () => requestRename(conversation),
            },
            {
              id: "archive",
              name:
                conversation.archivedAt === null
                  ? "Archive Conversation"
                  : "Restore Archived Conversation",
              run: () => void lifecycle(conversation),
            },
          ]
        : []),
      {
        id: "delete",
        name: conversation ? "Delete Conversation…" : "Delete Project…",
        run: () => requestDelete(target),
      },
    ];
  });
  const commands = createMemo<Command[]>(() => [
    { id: "actions", name: "Project and Conversation Actions", run: () => setForm("actions") },
    ...contextCommands(),
    ...allRows().map((r) => ({
      id: r.id,
      name: r.conversation
        ? `Conversation · ${r.project ? `${r.project.name} / ` : ""}${r.conversation.title}`
        : `Project · ${r.project?.name}`,
      description: r.conversation
        ? `${r.conversation.runtimeStatus} · ${r.conversation.workspacePath}`
        : (r.project?.rootPath ?? ""),
      run: () => selectRow(r),
    })),
    {
      id: "archives",
      name: showArchived() ? "Hide Archived Conversations" : "View Archived Conversations",
      run: () => {
        const previous = row()?.value;
        batch(() => {
          setShowArchived((v) => !v);
          if (!allRows().some((r) => r.id === selected()))
            setSelected(
              previous?.project ? projectKey(previous.project.id) : (allRows()[0]?.id ?? null),
            );
        });
      },
    },
    {
      id: "project",
      name: "Add Project",
      description: "Register an existing local directory",
      run: () => setForm("project"),
    },
    {
      id: "new",
      name: "New Conversation",
      description: "Use the selected project's shared workspace",
      run: () => void createConversation("shared"),
    },
    {
      id: "new_standalone",
      name: "New Standalone Conversation",
      description: "Ctrl+N · Use the directory where this hhu was launched, without a project",
      run: () => void createConversation("shared", true),
    },
    {
      id: "new_worktree",
      name: "New Conversation in Git Worktree",
      description: "Create an isolated branch and working directory",
      run: () => void createConversation("worktree"),
    },
    {
      id: "worktrees",
      name: "Manage Worktrees",
      description: "Inspect managed directories and safe cleanup",
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
    { id: "sidebar", name: "Toggle Sidebar", run: toggleSidebar },
    { id: "activity", name: "Toggle Global Activity", run: () => setShowActivity((v) => !v) },
    { id: "keys", name: "Configure Shortcuts", run: () => setForm("shortcuts") },
    {
      id: "quit",
      name: "Quit TUI",
      description: "Keep the Daemon and Agents running in the background",
      run: () => {
        void exit();
      },
    },
    ...(row()?.value.conversation
      ? [
          {
            id: "raw",
            name: "Raw Events / Debug",
            description: "Inspect the complete persisted ACP protocol",
            run: () => dispatch("raw"),
          },
          {
            id: "restore_pending",
            name: "Restore Unconfirmed Message",
            description: "Return the reserved message to the editor for inspection",
            run: () => dispatch("restore_pending"),
          },
          { id: "message", name: "Write Message", run: () => setForm("message") },
          {
            id: "initialize",
            name: "Initialize ACP session",
            description: "Connect and negotiate capabilities without a Prompt",
            run: () => dispatch("initialize"),
          },
          { id: "changes", name: "Toggle Changes / Chat", run: () => dispatch("changes") },
          { id: "queue", name: "Message Queue", run: () => dispatch("queue") },
          { id: "approval", name: "Choose Native Approval", run: () => setForm("approval") },
          { id: "cancel", name: "Cancel Current Turn (ACP)", run: () => dispatch("cancel") },
          {
            id: "harness",
            name: "Select Next Harness",
            description: "Ctrl+H · The first message to the target starts Handoff",
            run: () => dispatch("harness"),
          },
          {
            id: "cancel_switch",
            name: "Cancel Pending Harness Switch",
            run: () => dispatch("cancel_switch"),
          },
          {
            id: "handoff",
            name: "Handoff Failure",
            description: "View saved context, confirm degraded context, retry or cancel",
            run: () => dispatch("handoff"),
          },
          {
            id: "settings",
            name: "HarnessHub ACP settings",
            description: "Choose model, mode and other options exposed by the native session",
            run: () => setForm("settings"),
          },
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
      else if (form() === "rename" && renameTarget()) {
        await client.request(`/v1/conversations/${renameTarget()?.id}`, "PATCH", { title: value });
        setNotice("Conversation renamed");
      }
      setForm(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      paddingX={1}
      gap={0}
      backgroundColor={ui.canvas}
    >
      <box id="app-header" flexDirection="row" height={1} flexShrink={0} backgroundColor={ui.panel}>
        <text fg={ui.text} flexShrink={0}>
          <b> HarnessHub</b>
          <span style={{ fg: statusColor(state()) }}>{` · ${state()}`}</span>
        </text>
        <box flexGrow={1} minWidth={0} />
        <Show when={showActivity() && dimensions().width >= 100}>
          <text fg={ui.muted} wrapMode="none" height={1} flexShrink={0}>
            {"Global · "}
            <span
              style={{ fg: snapshot().activity.running ? ui.accent : ui.muted }}
            >{`Running ${snapshot().activity.running}`}</span>
            {" · "}
            <span
              style={{ fg: snapshot().activity.pendingApprovals ? ui.warning : ui.muted }}
            >{`Approval ${snapshot().activity.pendingApprovals}`}</span>
            {" · "}
            <span
              style={{ fg: snapshot().activity.problems ? ui.error : ui.muted }}
            >{`Problems ${snapshot().activity.problems}`}</span>
            {"   "}
          </text>
        </Show>
        <Show when={showActivity() && dimensions().width >= 55 && dimensions().width < 100}>
          <text height={1} flexShrink={0} fg={ui.muted}>
            <span
              style={{ fg: snapshot().activity.pendingApprovals ? ui.warning : ui.muted }}
            >{`! ${snapshot().activity.pendingApprovals}`}</span>
            <span
              style={{ fg: snapshot().activity.problems ? ui.error : ui.muted }}
            >{`  × ${snapshot().activity.problems}  `}</span>
          </text>
        </Show>
        <Show when={showArchived() && dimensions().width >= 70}>
          <text fg={ui.warning} flexShrink={0}>
            Archives{" "}
          </text>
        </Show>
        <box
          id="commands-button"
          flexShrink={0}
          backgroundColor={ui.selection}
          onMouse={(event) => {
            if (event.type !== "down" || event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            if (form() && form() !== "message" && form() !== "transcript") return;
            openPalette();
          }}
        >
          <text selectable={false} fg={ui.accent}>
            {dimensions().width >= 45 ? " / Commands " : " / "}
          </text>
        </box>
      </box>
      <box flexGrow={1} minHeight={0} flexDirection="row" gap={1}>
        <Show when={sidebarVisible()}>
          <box
            id="workspace-sidebar"
            width={Math.min(32, Math.floor(dimensions().width * 0.28))}
            minWidth={0}
            border={["right"]}
            borderColor={ui.border}
            backgroundColor={ui.panel}
            flexDirection="column"
          >
            <box paddingX={1} paddingTop={1} flexShrink={0}>
              <text height={1} flexShrink={0} fg={ui.text} wrapMode="none">
                <b>Projects</b>
                <span style={{ fg: ui.muted }}>{`  ${snapshot().projects.length}`}</span>
              </text>
            </box>
            <box flexDirection="row" paddingX={1} paddingBottom={1} gap={1} flexShrink={0}>
              <ActionButton
                id="sidebar-add-project"
                label="+ Add"
                disabled={busy() || (!!form() && form() !== "message" && form() !== "transcript")}
                onPress={() => setForm("project")}
              />
              <Show when={row()}>
                <box
                  height={1}
                  flexShrink={0}
                  onMouse={(event) =>
                    sidebarClick("sidebar-actions", event, () => {
                      if (!form() || form() === "transcript") {
                        setError("");
                        setForm("actions");
                      }
                    })
                  }
                >
                  <text selectable={false} fg={ui.muted}>
                    ⋯ Actions
                  </text>
                </box>
              </Show>
            </box>
            <Show
              when={rows().length > 0}
              fallback={
                <text fg={ui.secondary}>No projects yet. Press / and choose Add Project.</text>
              }
            >
              <ProjectTree
                rows={rows()}
                selected={selected()}
                activeProjectId={row()?.value.conversation?.projectId ?? null}
                collapsed={collapsed()}
                disabled={!!form() && form() !== "message" && form() !== "transcript"}
                onSelect={selectRow}
                onToggle={toggleProject}
                onProjectClick={(target) => {
                  const project = target.project;
                  if (!project) return;
                  const wasCollapsed = collapsed().has(project.id);
                  batch(() => {
                    selectRow(target);
                    if (!wasCollapsed) toggleProject(project.id);
                  });
                }}
                onActions={(conversation) => {
                  setActionsTarget(conversation);
                  setForm("conversationActions");
                }}
              />
            </Show>
          </box>
        </Show>
        <box flexGrow={1} flexShrink={1} minWidth={0} flexDirection="column" minHeight={0} gap={0}>
          <Show
            when={row()}
            fallback={
              <box flexDirection="column" padding={1} gap={1}>
                <text fg={ui.text}>
                  <b>Open your workspace</b>
                </text>
                <text fg={ui.secondary}>
                  Add an existing project directory, then create a conversation.
                </text>
                <KeyHints items={[["/", "commands and projects"]]} />
                <box flexDirection="row" flexWrap="wrap" gap={1}>
                  <ActionButton
                    id="welcome-add-project"
                    label="+ Add project"
                    primary
                    disabled={!!form() || busy()}
                    onPress={() => setForm("project")}
                  />
                  <ActionButton
                    id="welcome-new-conversation"
                    label="+ Standalone conversation"
                    disabled={!!form() || busy()}
                    onPress={() => void createConversation("shared", true)}
                  />
                </box>
              </box>
            }
          >
            <box
              id="workspace-header"
              flexDirection={row()?.value.conversation ? "row" : "column"}
              flexShrink={0}
              columnGap={2}
              paddingX={row()?.value.conversation ? 0 : 1}
              paddingTop={row()?.value.conversation ? 0 : 1}
              backgroundColor={ui.panel}
            >
              <text
                id="workspace-heading"
                height={1}
                flexGrow={1}
                flexShrink={1}
                minWidth={0}
                fg={ui.text}
                wrapMode="none"
                truncate
              >
                <Show
                  when={row()?.value.conversation}
                  fallback={<b>{row()?.value.project?.name}</b>}
                >
                  <b>{row()?.value.conversation?.title}</b>
                  <Show when={row()?.value.conversation?.archivedAt !== null}>
                    <span style={{ fg: ui.warning }}> [archived]</span>
                  </Show>
                </Show>
              </text>
              <text
                id="workspace-path"
                height={1}
                flexShrink={0}
                width={row()?.value.conversation ? "40%" : "100%"}
                fg={ui.muted}
                wrapMode="none"
                truncate
              >
                <Show when={!row()?.value.conversation}>Workspace · </Show>
                {row()?.value.conversation?.workspacePath ?? row()?.value.project?.rootPath}
              </text>
            </box>
          </Show>
          <Show
            when={row() && !row()?.value.conversation ? row()?.value.project?.rootPath : undefined}
            keyed
          >
            {(rootPath) => (
              <WorkspaceOverview
                rootPath={rootPath}
                archived={showArchived()}
                conversations={snapshot().conversations.filter(
                  (c) => c.projectId === row()?.value.project?.id,
                )}
                disabled={!!form() || busy()}
                onCreate={(mode) => void createConversation(mode)}
                onSelect={(conversation) =>
                  selectRow({
                    id: conversationKey(conversation.id),
                    project: row()?.value.project ?? null,
                    conversation,
                  })
                }
              />
            )}
          </Show>
          <Show when={row()?.value.conversation?.id} keyed>
            {(conversationId) => (
              <AgentPane
                conversation={
                  snapshot().conversations.find((c) => c.id === conversationId) as Conversation
                }
                form={form()}
                setForm={(value) => {
                  if (row()?.value.conversation?.id === conversationId) setForm(value);
                }}
                onDraftError={setError}
                onHelp={() => {
                  paletteReturn = "message";
                  setForm("palette");
                }}
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
            <text fg={ui.warning}>
              Another Conversation is active in this shared workspace. Concurrent file edits can
              conflict.
            </text>
          </Show>
        </box>
      </box>
      <Show when={form() === "project"}>
        <ProjectPathInput busy={busy()} onSubmit={(value) => void submit(value)} />
      </Show>
      <Show when={form() === "rename" && renameTarget()}>
        {(target) => (
          <box
            border
            borderColor={ui.border}
            backgroundColor={ui.panel}
            flexDirection="column"
            height={5}
          >
            <text fg={ui.text}>
              <b>Rename Conversation</b>
            </text>
            <input
              {...inputStyle}
              id="conversation-title"
              focused={!busy()}
              value={(target() as Conversation).title}
              placeholder="Conversation title"
              onSubmit={(value) => {
                if (typeof value === "string") void submit(value);
              }}
              width="100%"
            />
            <KeyHints
              items={[
                ["Enter", "save"],
                ["Esc", "cancel"],
              ]}
            />
          </box>
        )}
      </Show>
      <Show when={form() === "worktrees"}>
        <Panel
          title="Managed Worktrees"
          hint="Choose a worktree to inspect cleanup. Esc closes."
          height="80%"
        >
          <text fg={ui.secondary}>
            Cleanup moves an unbound, clean worktree to a retained directory. Files and branches
            remain available for inspection; HarnessHub never physically deletes them.
          </text>
          <select
            {...listStyle}
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
        </Panel>
      </Show>
      <Show when={form() === "cleanup" && cleanupTarget()}>
        {(w) => (
          <Panel title="Confirm safe Worktree cleanup" hint="Type CLEAN to continue. Esc cancels.">
            <text
              fg={ui.secondary}
            >{`Retain managed directory: ${(w() as ManagedWorktree).path}`}</text>
            <text fg={ui.secondary}>{`Preserve branch: ${(w() as ManagedWorktree).branch}`}</text>
            <text fg={ui.secondary}>
              Dirty, hidden-index, bound, locked or mismatched worktrees are refused. Files are
              retained.
            </text>
            <input
              {...inputStyle}
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
                    const retained = await client.request<ManagedWorktree>(
                      `/v1/worktrees/${(w() as ManagedWorktree).id}/cleanup`,
                      "POST",
                      { confirmed: true },
                    );
                    setForm(null);
                    setNotice(
                      `Worktree ${retained.status.toLowerCase()}: ${retained.path}; files and branch preserved`,
                    );
                  } catch (e) {
                    setError(e instanceof Error ? e.message : "Cleanup failed");
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
            />
          </Panel>
        )}
      </Show>
      <Show when={form() === "palette"}>
        <CommandPalette commands={commands()} onClose={closePalette} />
      </Show>
      <Show when={form() === "actions"}>
        <CommandPalette
          title="Conversation / Project actions"
          commands={contextCommands()}
          onClose={() => setForm(null)}
        />
      </Show>
      <Show when={form() === "conversationActions" && actionsTarget()}>
        {(target) => (
          <ConversationActions
            conversation={target() as Conversation}
            busy={busy()}
            onRename={() => requestRename(target() as Conversation)}
            onArchive={() => void lifecycle(target() as Conversation)}
            onDelete={() => {
              const conversation = target() as Conversation;
              const project = snapshot().projects.find((p) => p.id === conversation.projectId);
              requestDelete({ project: project ?? null, conversation });
            }}
            onClose={() => setForm(null)}
          />
        )}
      </Show>
      <Show when={form() === "delete" && deleteTarget()}>
        {(target) => (
          <DeleteConfirmation
            kind={target().conversation ? "Conversation" : "Project"}
            busy={busy()}
            onCancel={() => setForm(null)}
            onDelete={() => void deleteSelected()}
          >
            <text fg={ui.secondary}>
              {target().conversation
                ? `Permanently delete “${target().conversation?.title}” and its application history?`
                : `Permanently delete Project “${target().project?.name}” and all ${snapshot().conversations.filter((c) => c.projectId === target().project?.id).length} Conversations (including archived) and their history?`}
            </text>
            <text fg={ui.secondary}>
              {target().conversation
                ? "Delete cancels active work and pending approvals, stops this Conversation's Workers, then removes its history. Unresponsive owned Workers will be terminated."
                : "Active, pending approval or UNCERTAIN Conversations must be resolved first."}
            </text>
          </DeleteConfirmation>
        )}
      </Show>
      <Show when={form() === "shortcuts"}>
        <Panel title="Shortcuts" hint="Edit JSON overrides. Enter saves. Esc closes.">
          <text fg={ui.secondary}>
            Use Ctrl combinations (legacy Meta overrides remain supported). Letters alone never
            invoke shortcuts. Editor keys, Enter, Shift+Enter and Esc are reserved. Empty object
            restores defaults.
          </text>
          <text fg={ui.secondary}>{JSON.stringify(keys())}</text>
          <input
            {...inputStyle}
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
                  "Invalid shortcuts: use distinct Ctrl/Meta keys; editor keys, fixed Ctrl actions and quit are reserved",
                );
              }
            }}
          />
        </Panel>
      </Show>
      <Show when={error()}>
        <text fg={ui.error}>{error()}</text>
        <box
          onMouse={(event) => {
            if (event.type === "down" && event.button === 0) props.onExit();
          }}
        >
          <text fg={ui.secondary}>Click here to close without saving pending local edits.</text>
        </box>
      </Show>
      <Show when={notice()}>
        <text height={1} fg={ui.muted}>
          {notice()}
        </text>
      </Show>
      <box backgroundColor={ui.panel} height={1} flexShrink={0}>
        <KeyHints
          items={
            dimensions().width < 70
              ? [
                  ["/", "Commands"],
                  ["Ctrl+C", "Quit"],
                ]
              : form() === "message"
                ? [
                    ["/", "Commands"],
                    ["Ctrl+H", "Harness"],
                    ["Ctrl+T", "Transcript"],
                    ["Ctrl+C", "Copy / Clear / Quit"],
                  ]
                : row()?.value.conversation
                  ? [
                      ["/", "Commands"],
                      ["Ctrl+H", "Harness"],
                      ["Enter", "Message"],
                      ["Ctrl+C", "Copy / Clear / Quit"],
                    ]
                  : [
                      ["/", "Commands"],
                      ["N", "New conversation"],
                      ["Ctrl+N", "Standalone"],
                      ["Ctrl+C", "Quit"],
                    ]
          }
        />
      </box>
    </box>
  );
}
export async function openTui(initialProjectId?: string, launchCwd = process.cwd()) {
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
    () => (
      <App
        initialProjectId={initialProjectId}
        launchCwd={launchCwd}
        onExit={() => renderer.destroy()}
      />
    ),
    renderer,
  );
  await done;
  await renderer.closed;
}
