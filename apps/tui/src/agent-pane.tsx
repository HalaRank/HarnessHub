import type {
  Approval,
  Conversation,
  Handoff,
  NativeCommand,
  NativeSession,
  PendingInput,
  Shortcuts,
  Turn,
} from "@harnesshub/shared";
import { sessionCommands } from "@harnesshub/shared";
import { connect, HttpError, watchConversation } from "@harnesshub/shared/client";
import type { TextareaRenderable } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { ChangesPane } from "./changes-pane";
import { useClipboard } from "./clipboard";
import { DraftSession } from "./draft-session";
import { localCommands } from "./local-commands";
import { NativeEvents } from "./native-events";
import { RawEvents } from "./raw-events";
import { binding, matches, navigationShortcuts, shortcuts } from "./shortcuts";
import { matchingCommands, SlashCommands, slashQuery } from "./slash-commands";
import { SourceViewer } from "./source-viewer";
import { object, Transcript, type ViewState } from "./transcript";
import { inputStyle, KeyHints, listStyle, Panel, statusColor, ui } from "./ui";

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
  setForm: (value: "message" | "transcript" | "approval" | "details" | "settings" | null) => void;
  onDraftError: (message: string) => void;
  view?: ViewState;
  shortcuts?: Shortcuts;
  action?: AgentAction;
  onChangesChange?: (value: boolean) => void;
  registerClearInput?: (clear: (() => boolean) | undefined) => void;
  onCommand?: (name: string) => void;
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
  const [pendingInputs, setPendingInputs] = createSignal<PendingInput[]>([]);
  const [queueOpen, setQueueOpen] = createSignal(false);
  const [messageHistory, setMessageHistory] = createSignal<string[]>([]);
  const [historySearch, setHistorySearch] = createSignal<string | null>(null);
  const [lastResponse, setLastResponse] = createSignal("");
  const responseChunks = new Map<string, string>();
  let historyIndex: number | null = null;
  let historyDraft = "";
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
  const [followRequest, setFollowRequest] = createSignal(0);
  const dimensions = useTerminalDimensions();
  const composerLines = () =>
    Math.min(inputLines(), Math.max(1, Math.min(8, dimensions().height - 12)));
  const [editorRevision, setEditorRevision] = createSignal(0),
    [slashDismissedText, setSlashDismissedText] = createSignal<string | null>(null),
    [slashPasted, setSlashPasted] = createSignal(false),
    [slashSelected, setSlashSelected] = createSignal(0),
    [rawConfirm, setRawConfirm] = createSignal(false);
  const commandSession = () => {
    const session = activeSession();
    return !openHandoffRecord() && session?.harnessId === harness() ? session : undefined;
  };
  const commands = () =>
    connection() === "Connected" ? sessionCommands(commandSession()) : undefined;
  const query = createMemo(() => {
    editorRevision();
    return textarea
      ? slashQuery(textarea.plainText, textarea.getTextRange(0, textarea.cursorOffset))
      : null;
  });
  const availableCommands = () => [
    ...(commands() ?? []),
    ...localCommands.filter(
      (command) => !(commands() ?? []).some((native) => native.name === command.name),
    ),
  ];
  const options = createMemo(() => matchingCommands(availableCommands(), query() ?? ""));
  const steeringAvailable = () =>
    object(object(object(executionSession()?.capabilities).initialize)._meta).steering;
  const isRunning = () =>
    ["PREPARING", "RUNNING", "WAITING_APPROVAL"].includes(props.conversation.runtimeStatus);
  const refreshInputs = async () => {
    const result = await request<PendingInput[]>(`/v1/conversations/${conversationId}/inputs`);
    if (!disposed) setPendingInputs(result);
  };
  const commandStatus = () => {
    if (connection() !== "Connected")
      return "Daemon disconnected; ACP commands cannot be executed.";
    if (openHandoffRecord() || (activeSession() && activeSession()?.harnessId !== harness()))
      return "Target Handoff has not completed; source commands are unavailable here.";
    if (!commandSession())
      return "NativeSession not initialized. Use Commands → Initialize ACP session (no Prompt).";
    if (commandSession()?.status !== "READY" || commandSession()?.endedAt !== null)
      return "NativeSession is no longer live. Historical commands cannot be executed.";
    if (!commands()?.length) return "Agent has not published any ACP commands.";
    return "No matching ACP commands.";
  };
  const slashOpen = () =>
    props.form === "message" &&
    query() !== null &&
    slashDismissedText() !== textarea?.plainText &&
    !slashPasted();
  createEffect(() => {
    query();
    options();
    setSlashSelected(0);
  });
  const chooseCommand = (command: NativeCommand) => {
    if (!textarea || !options().includes(command)) return;
    const token = textarea.plainText.split(/\s/, 1)[0] ?? "";
    // Use native display offsets, including wide/combining characters. Preserve
    // all parameters and undo history instead of resetting the editor buffer.
    textarea.setSelection(0, textarea.editBuffer.measureText(token));
    textarea.insertText(`/${command.name}`);
    setSlashDismissedText(textarea.plainText);
    props.setForm("message");
    textarea.focus();
  };
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
    const generation = ++sessionRefresh;
    const result = await request<NativeSession[]>(`/v1/conversations/${conversationId}/sessions`);
    const conversation = await request<Conversation>(`/v1/conversations/${conversationId}`);
    if (!disposed && generation === sessionRefresh) {
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
  let sessionRefresh = 0;
  createEffect(() => {
    const selected = props.conversation.selectedHarnessId;
    if (selected && !selectionPending) setHarness(selected);
  });
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
      await refreshInputs();
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
          if (event.kind === "user.message") {
            if (!object(event.payload).delivery) setTurnId(event.turnId);
            const text = object(event.payload).text;
            if (typeof text === "string") setMessageHistory((messages) => [...messages, text]);
          }
          if (
            event.kind === "agent_message_chunk" &&
            event.turnId &&
            event.purpose !== "handoff_internal"
          ) {
            const text = object(object(event.payload).content).text;
            if (typeof text === "string")
              responseChunks.set(event.turnId, (responseChunks.get(event.turnId) ?? "") + text);
          }
          if (
            event.kind === "runtime.turn_finished" &&
            event.turnId &&
            object(event.payload).state === "COMPLETED"
          ) {
            const response = responseChunks.get(event.turnId);
            if (response) setLastResponse(response);
          }
          if (
            (event.kind === "runtime.turn_finished" && event.purpose !== "handoff_internal") ||
            event.kind === "runtime.interrupted"
          )
            setTurnId((current) => (current === event.turnId ? null : current));
        }
        if (batch.some((event) => event.kind === "runtime.input_updated"))
          void refreshInputs().catch(() => {});
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
              "runtime.context_ended",
              "runtime.settings_pending",
              "runtime.settings_settled",
              "runtime.session_error",
              "available_commands_update",
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
      if (["message", "transcript", "approval", "details", "settings"].includes(props.form ?? ""))
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
    void run(async () => {
      await selectionQueue;
      const conversation = await request<Conversation>(`/v1/conversations/${conversationId}`);
      const list = profiles();
      const index = list.findIndex(
        (profile) => profile.id === (conversation.selectedHarnessId ?? harness()),
      );
      await selectHarness(list[(index + 1) % list.length]?.id ?? "codex");
    });
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
    if (action.name === "initialize")
      void run(async () => {
        await selectionQueue;
        if (selectionFailure) throw new Error(selectionFailure);
        await request(`/v1/conversations/${conversationId}/sessions`, "POST", {
          harnessId: harness(),
        });
        await refreshSessions();
      });
  });
  useKeyboard((key) => {
    if (key.defaultPrevented || key.propagationStopped) return;
    if (props.form === "message" && key.sequence === "?" && !textarea?.plainText) {
      key.preventDefault();
      key.stopPropagation();
      props.onCommand?.("help");
      return;
    }
    if (key.name === "escape" && (queueOpen() || historySearch() !== null)) {
      key.preventDefault();
      key.stopPropagation();
      setQueueOpen(false);
      setHistorySearch(null);
      props.setForm("message");
      return;
    }
    if (props.form === "message" && key.name === "escape") {
      key.preventDefault();
      key.stopPropagation();
      if (slashOpen()) setSlashDismissedText(textarea?.plainText ?? "");
      else if (turnId()) cancel();
      else {
        props.setForm(null);
        setFollowRequest((value) => value + 1);
      }
      return;
    }
    if (!props.form && key.name === "escape" && turnId()) {
      key.preventDefault();
      key.stopPropagation();
      cancel();
      return;
    }
    if (
      props.form === "message" &&
      matches(key, "tab") &&
      !slashOpen() &&
      isRunning() &&
      textarea?.plainText.trim()
    ) {
      key.preventDefault();
      key.stopPropagation();
      void send(false, "queue");
      return;
    }
    if (
      (!props.form || props.form === "message" || props.form === "transcript") &&
      matches(key, "ctrl+t")
    ) {
      key.preventDefault();
      key.stopPropagation();
      if (props.form !== "transcript") setChanges(false);
      props.setForm(props.form === "transcript" ? "message" : "transcript");
      return;
    }
    if (props.form === "message" && matches(key, "ctrl+r")) {
      key.preventDefault();
      key.stopPropagation();
      setHistorySearch("");
      props.setForm("details");
      return;
    }
    if (
      props.form === "message" &&
      textarea &&
      !slashOpen() &&
      (matches(key, "up") || matches(key, "down"))
    ) {
      const up = key.name === "up";
      const prefix = textarea.getTextRange(0, textarea.cursorOffset);
      const atEdge = up
        ? !prefix.includes("\n")
        : !textarea.plainText.slice(prefix.length).includes("\n");
      if (atEdge && messageHistory().length && (up || historyIndex !== null)) {
        key.preventDefault();
        key.stopPropagation();
        if (historyIndex === null) historyDraft = textarea.plainText;
        historyIndex = Math.max(
          0,
          Math.min(
            messageHistory().length,
            (historyIndex ?? messageHistory().length) + (up ? -1 : 1),
          ),
        );
        textarea.setText(messageHistory()[historyIndex] ?? historyDraft);
        textarea.gotoBufferEnd();
        if (historyIndex === messageHistory().length) historyIndex = null;
        return;
      }
    }
    if (key.name === "escape" && (props.form === "settings" || handoffMenu() || rawConfirm())) {
      key.preventDefault();
      key.stopPropagation();
      const returnToMessage = rawConfirm();
      setHandoffMenu(false);
      setRawConfirm(false);
      props.setForm(returnToMessage ? "message" : null);
      return;
    }
    if (
      slashOpen() &&
      !key.ctrl &&
      !key.meta &&
      !key.shift &&
      ["up", "down", "tab", "return"].includes(key.name)
    ) {
      key.preventDefault();
      key.stopPropagation();
      if (key.name === "up" || key.name === "down")
        setSlashSelected((i) =>
          Math.max(0, Math.min(options().length - 1, i + (key.name === "up" ? -1 : 1))),
        );
      else {
        const command = options()[slashSelected()];
        if (command) chooseCommand(command);
        else
          setError(
            `${commandStatus()} Esc closes suggestions; Enter then offers sending as plain text.`,
          );
      }
      return;
    }
    if (matches(key, keys().changes) && !props.form) {
      key.preventDefault();
      key.stopPropagation();
      setChanges((v) => !v);
      return;
    }
    if (matches(key, keys().copy) && (!props.form || props.form === "message")) {
      const text =
        renderer.getSelection()?.getSelectedText() || textarea?.getSelectedText() || lastResponse();
      if (text) {
        key.preventDefault();
        key.stopPropagation();
        renderer.clearSelection();
        textarea?.clearSelection();
        void copyText(text).then(setError);
      }
      return;
    }
    if (props.form) return;
    if (matches(key, navigationShortcuts.message) || matches(key, "return")) {
      key.preventDefault();
      key.stopPropagation();
      props.setForm("message");
      if (key.name === "return") textarea?.gotoBufferEnd();
      return;
    }
    if (busy()) return;
    if (matches(key, navigationShortcuts.approval) && approvals().length) {
      key.preventDefault();
      props.setForm("approval");
    }
    if (matches(key, navigationShortcuts.cancel)) cancel();
    if (matches(key, navigationShortcuts.cancelSwitch)) cancelSwitch();
    if (matches(key, navigationShortcuts.handoff) && failedHandoff()) openHandoff();
  });
  const send = (raw = false, delivery?: "steer" | "queue") =>
    run(async () => {
      await selectionQueue;
      if (selectionFailure) throw new Error(selectionFailure);
      const message = textarea?.plainText ?? "";
      if (!message.trim()) return;
      const token = message.split(/\s/, 1)[0] ?? "";
      const command = commands()?.find((c) => `/${c.name}` === token);
      const local = !raw && !command && localCommands.find((c) => `/${c.name}` === token);
      if (local) {
        if (message.trim() !== token) throw new Error(`/${local.name} does not accept arguments`);
        textarea?.setText("");
        draft.update("");
        await draft.flush();
        if (local.name === "copy") {
          if (lastResponse()) setError(await copyText(lastResponse()));
        } else if (local.name === "queue") {
          await refreshInputs();
          setQueueOpen(true);
          props.setForm("details");
        } else props.onCommand?.(local.name);
        return;
      }
      if (!raw && message.startsWith("/") && !command) {
        setDebug(false);
        setRawConfirm(true);
        props.setForm("details");
        return;
      }
      draft.update(message);
      const session = commandSession();
      const submission = await draft.prepare(
        harness(),
        !raw && command && session
          ? { nativeSessionId: session.id, name: command.name }
          : undefined,
        delivery ?? draft.value.pendingSubmission?.delivery ?? (isRunning() ? "steer" : undefined),
      );
      try {
        const result = await request<Turn | PendingInput>(
          `/v1/conversations/${conversationId}/${submission.delivery ? "inputs" : "turns"}`,
          "POST",
          submission,
        );
        if ("endedAt" in result) setTurnId(result.endedAt ? null : result.id);
      } catch (error) {
        if (error instanceof HttpError && [400, 404, 409].includes(error.status))
          await draft.rejected();
        throw error;
      }
      await draft.accepted();
      if (!disposed) {
        textarea?.setText(draft.text);
        historyIndex = null;
        setSlashPasted(false);
        setSlashDismissedText(null);
        props.setForm("message");
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
        name: String(m.name),
        description: `Mode · ${m.id}${m.id === object(native.modes).currentModeId ? " · current" : ""}`,
        value: { kind: "mode", modeId: m.id },
      });
    }
    for (const raw of Array.isArray(native.configOptions) ? native.configOptions : []) {
      const option = object(raw);
      if (option.type === "boolean")
        for (const value of [true, false])
          choices.push({
            name: String(value),
            description: `${option.name}${value === option.currentValue ? " · current" : ""}`,
            value: { kind: "config", configId: option.id, value },
          });
      for (const rawEntry of Array.isArray(option.options) ? option.options : []) {
        const entry = object(rawEntry);
        for (const rawValue of Array.isArray(entry.options) ? entry.options : [entry]) {
          const v = object(rawValue);
          choices.push({
            name: String(v.name),
            description: `${option.name} · ${v.value}${v.value === option.currentValue ? " · current" : ""}`,
            value: { kind: "config", configId: option.id, value: v.value },
          });
        }
      }
    }
    return choices;
  });
  return (
    <box
      flexDirection="column"
      flexGrow={1}
      minHeight={0}
      gap={0}
      onMouse={(event) => {
        if (
          event.type !== "down" ||
          event.defaultPrevented ||
          event.button !== 0 ||
          busy() ||
          !draftReady() ||
          (changes() && event.target !== textarea && event.target !== textarea?.parent) ||
          (props.form && props.form !== "message")
        )
          return;
        props.setForm("message");
        if (event.target !== textarea) {
          event.preventDefault();
          // Renderer starts history selection before dispatching this mouse event.
          // Editor movement helpers clear that selection, breaking drag and multi-click copy.
          textarea?.editBuffer.gotoLine(textarea.editBuffer.getLineCount());
          textarea?.requestRender();
          textarea?.focus();
        }
      }}
    >
      <box
        id="conversation-toolbar"
        flexDirection="row"
        flexWrap="wrap"
        flexShrink={0}
        alignItems="flex-start"
        justifyContent="space-between"
        columnGap={2}
      >
        <text
          id="harness-identity"
          fg={ui.secondary}
          flexShrink={1}
          minWidth={0}
          maxWidth="100%"
          wrapMode="char"
        >
          <span style={{ fg: ui.text }}>
            <b>{executionSession()?.harnessId ?? harness()}</b>
          </span>
          <span style={{ fg: ui.muted }}> · </span>
          {executionSession() ? actualModel(executionSession()) : "not initialized"}
        </text>
        <text
          id="harness-status"
          fg={ui.muted}
          flexShrink={1}
          minWidth={0}
          maxWidth="100%"
          wrapMode="char"
        >
          <span style={{ fg: statusColor(props.conversation.runtimeStatus) }}>
            {`● ${props.conversation.runtimeStatus}`}
          </span>
          {` · ${changes() ? "Changes" : "Chat"}`}
          <Show when={connection() !== "Connected"}>
            <span style={{ fg: statusColor(connection()) }}>{` · ${connection()}`}</span>
          </Show>
        </text>
      </box>
      <Show
        when={openHandoffRecord() || (activeSession() && activeSession()?.harnessId !== harness())}
      >
        <text fg={ui.warning} flexShrink={0} wrapMode="char">
          <span style={{ fg: ui.warning }}>
            {openHandoffRecord()
              ? `Handoff ${openHandoffRecord()?.sourceHarness} → ${openHandoffRecord()?.targetHarness} · ${openHandoffRecord()?.status}`
              : activeSession() && activeSession()?.harnessId !== harness()
                ? ` → ${harness()} (PENDING_SWITCH)`
                : ""}
          </span>
        </text>
      </Show>
      <Show when={activeSession() && activeSession()?.harnessId !== harness()}>
        <text fg={ui.warning}>
          First target message starts Handoff. Wait for source execution/approval/cancellation to
          finish before sending.
        </text>
      </Show>
      <Show when={failedHandoff()}>
        <text fg={ui.warning}>
          Context may be incomplete / 上下文可能不完整 · /handoff for materials / confirm degraded /
          retry / cancel. Target task has NOT been sent.
        </text>
      </Show>
      <Show when={["INTERRUPTED", "UNCERTAIN"].includes(props.conversation.runtimeStatus)}>
        <text fg={ui.warning}>
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
            followRequest={followRequest()}
            running={["PREPARING", "RUNNING", "CANCELLING", "HANDOFF"].includes(
              props.conversation.runtimeStatus,
            )}
            disabled={!!props.form && props.form !== "transcript"}
            mouseDisabled={!!props.form && !["message", "transcript"].includes(props.form)}
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
            borderColor={ui.warning}
            backgroundColor={ui.panel}
            flexDirection="column"
            flexShrink={0}
            height={Math.min(12, (approval().request as Permission).options.length + 7)}
            title="Native permission"
          >
            <text fg={ui.warning}>
              <b>User decision required</b>
            </text>
            <scrollbox height={2} flexShrink={0}>
              <text selectable>{JSON.stringify((approval().request as Permission).toolCall)}</text>
            </scrollbox>
            <scrollbox flexGrow={1} minHeight={0}>
              <For each={(approval().request as Permission).options}>
                {(option, index) => (
                  <text fg={ui.text}>
                    <span style={{ fg: ui.warning }}>{index() + 1}. </span>
                    <b>{option.name}</b>
                    <span style={{ fg: ui.muted }}>{` [${option.kind}]`}</span>
                  </text>
                )}
              </For>
            </scrollbox>
            <Show
              when={props.form === "approval"}
              fallback={
                <box
                  onMouse={(event) => {
                    if (event.type === "down" && event.button === 0) {
                      event.preventDefault();
                      event.stopPropagation();
                      props.setForm("approval");
                    }
                  }}
                >
                  <text fg={ui.secondary}>
                    Use /approval or click here to choose an Agent option.
                  </text>
                </box>
              }
            >
              <input
                {...inputStyle}
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
        <box flexDirection="column" height={composerLines() + 2} flexShrink={0}>
          <Show when={slashOpen()}>
            <SlashCommands
              title="Commands"
              commands={options()}
              selected={slashSelected()}
              bottom={composerLines() + 2}
              height={Math.max(
                3,
                Math.min(
                  12,
                  dimensions().height - composerLines() - 5,
                  options().length ? options().length * 2 + 4 : 6,
                ),
              )}
              status={commandStatus()}
              notice={commands()?.length ? "" : commandStatus()}
              choose={chooseCommand}
            />
          </Show>
          <box
            id="message-composer"
            border
            height={composerLines() + 2}
            flexShrink={0}
            borderColor={props.form === "message" ? ui.accent : ui.border}
            backgroundColor={ui.input}
            title={
              isRunning()
                ? `Message · Enter ${object(steeringAvailable()).supported === true ? "steer" : "queue (steering unavailable)"} · Tab queue · Esc interrupt`
                : props.form === "message"
                  ? "Message"
                  : "Message · Enter to write"
            }
          >
            <textarea
              {...inputStyle}
              id="message-draft"
              onMouseDown={(event) => {
                if (props.form && props.form !== "message") event.preventDefault();
              }}
              initialValue={draft.text}
              // Terminal IME preedit can appear before committed text reaches the editor.
              placeholder={
                props.form === "message" ? null : "Type a message, / for commands, ? for shortcuts"
              }
              onContentChange={() => {
                const text = textarea?.plainText ?? draft.text;
                draft.update(text);
                setInputLines(Math.max(1, text.split("\n").length));
                setEditorRevision((n) => n + 1);
              }}
              onCursorChange={() => setEditorRevision((n) => n + 1)}
              onPaste={() => {
                setSlashPasted(true);
              }}
              onKeyDown={(key) => {
                if (
                  !key.ctrl &&
                  !key.meta &&
                  key.sequence.length > 0 &&
                  !["return", "tab", "escape", "up", "down"].includes(key.name)
                ) {
                  setSlashPasted(false);
                  setSlashDismissedText(null);
                }
              }}
              ref={(element) => {
                textarea = element;
                if (props.form === "message") textarea.gotoBufferEnd();
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
                if (slashOpen()) {
                  const command = options()[slashSelected()];
                  if (command) chooseCommand(command);
                  return;
                }
                void send();
              }}
              flexGrow={1}
            />
          </box>
        </box>
      </Show>
      <Show
        when={pendingInputs().some((input) =>
          ["QUEUED", "HELD", "SENDING", "ERROR", "UNCERTAIN"].includes(input.state),
        )}
      >
        <box
          onMouse={(event) => {
            if (event.type !== "down" || event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            setQueueOpen(true);
            props.setForm("details");
          }}
        >
          <text fg={ui.warning}>
            {pendingInputs()
              .filter((input) =>
                ["QUEUED", "HELD", "SENDING", "ERROR", "UNCERTAIN"].includes(input.state),
              )
              .slice(0, 3)
              .map(
                (input) =>
                  `${input.state} · ${input.input.message.replace(/\s+/g, " ").slice(0, 65)} · ${input.reason}`,
              )
              .join("\n")}
            {"\n/queue to inspect messages"}
          </text>
        </box>
      </Show>
      <Show when={queueOpen() && props.form === "details"}>
        <Panel title="Message queue" hint="Enter choose · Esc return to message" height="65%">
          <text fg={ui.secondary}>
            Held messages wait for explicit resume. Unknown delivery requires history inspection.
          </text>
          <select
            {...listStyle}
            focused={!busy()}
            flexGrow={1}
            options={[
              {
                name: "Resume held messages",
                description: "Send in order after confirmed completion",
                value: { action: "resume", id: "" },
              },
              ...pendingInputs()
                .filter((input) => ["QUEUED", "HELD", "ERROR"].includes(input.state))
                .flatMap((input) => [
                  {
                    name: `Edit · ${input.state} · ${input.input.message}`,
                    description: input.reason,
                    value: { action: "edit", id: input.requestId },
                  },
                  {
                    name: `Remove · ${input.input.message}`,
                    description: "Remove this unsent message",
                    value: { action: "remove", id: input.requestId },
                  },
                ]),
            ]}
            onSelect={(_index, option) => {
              if (!option) return;
              const value = option.value as { action: string; id: string };
              void run(async () => {
                if (value.action === "resume")
                  await request(`/v1/conversations/${conversationId}/inputs/resume`, "POST");
                else {
                  const input = pendingInputs().find((item) => item.requestId === value.id);
                  if (!input) return;
                  if (value.action === "edit" && textarea?.plainText.trim())
                    throw new Error(
                      "Save or clear the current draft before editing a queued message",
                    );
                  await request(`/v1/conversations/${conversationId}/inputs/${value.id}`, "DELETE");
                  if (value.action === "edit") {
                    textarea?.setText(input.input.message);
                    draft.update(input.input.message);
                    setQueueOpen(false);
                    props.setForm("message");
                  }
                }
                await refreshInputs();
              });
            }}
          />
        </Panel>
      </Show>
      <Show when={historySearch() !== null && props.form === "details"}>
        <Panel title="Search prompt history" hint="Enter restore · Esc return" height="60%">
          <input
            {...inputStyle}
            focused={!busy()}
            placeholder="Search previous messages"
            onInput={(value) => setHistorySearch(value)}
            onSubmit={() => {
              const match = [...messageHistory()]
                .reverse()
                .find((text) =>
                  text.toLocaleLowerCase().includes((historySearch() ?? "").toLocaleLowerCase()),
                );
              if (match) {
                textarea?.setText(match);
                draft.update(match);
              }
              setHistorySearch(null);
              props.setForm("message");
            }}
          />
          <scrollbox flexGrow={1}>
            <For
              each={[...messageHistory()]
                .reverse()
                .filter((text) =>
                  text.toLocaleLowerCase().includes((historySearch() ?? "").toLocaleLowerCase()),
                )}
            >
              {(text) => (
                <text selectable fg={ui.secondary}>
                  {text}
                </text>
              )}
            </For>
          </scrollbox>
        </Panel>
      </Show>
      <Show when={rawConfirm() && props.form === "details"}>
        <Panel
          title="Unadvertised slash text"
          hint="Choose how to handle the original message. Esc closes."
        >
          <text fg={ui.secondary}>
            {commandStatus()} This prefix is not an advertised command in the selected session.
          </text>
          <text fg={ui.secondary}>
            Send the exact text as an ordinary Prompt? This may start a model Turn or pending
            Handoff.
          </text>
          <select
            {...listStyle}
            focused={!busy()}
            height={4}
            showDescription={false}
            options={[
              { name: "Keep editing (no Prompt)", description: "", value: false },
              { name: "Send original text as ordinary Prompt", description: "", value: true },
            ]}
            onSelect={(_index, option) => {
              setRawConfirm(false);
              props.setForm("message");
              if (option?.value) void send(true);
            }}
          />
        </Panel>
      </Show>
      <Show when={error()}>
        <text fg={ui.error}>{error()}</text>
      </Show>
      <Show when={draftState() >= 0 && draft.value.pendingSubmission}>
        <text fg={ui.warning}>
          Unconfirmed request {draft.value.pendingSubmission?.requestId}. Restore Unconfirmed
          Message to inspect/retry the original; reconnect never sends it.
        </text>
      </Show>

      <Show
        when={!busy() && draftReady()}
        fallback={
          <text fg={ui.warning} height={1}>
            ACP operation pending
          </text>
        }
      >
        <KeyHints
          items={
            props.form === "message"
              ? [
                  ["Enter", isRunning() ? "steer / queue" : "send"],
                  ...(isRunning() ? [["Tab", "queue"] as [string, string]] : []),
                  ["Shift+Enter", "newline"],
                  [keys().newline, "newline"],
                  ["Esc", isRunning() ? "interrupt" : "navigate"],
                  ["/", "commands"],
                ]
              : [
                  ["Enter", "Message"],
                  ["Esc", "interrupt"],
                  ["/", "commands"],
                ]
          }
        />
      </Show>
      <Show when={handoffMenu() && props.form === "details"}>
        <Panel title="Handoff failed" hint="Context may be incomplete. Esc closes." height="70%">
          <text fg={ui.secondary}>
            Report generation may use native tools; HarnessHub cannot sandbox Agent-owned tools.
            Native permissions always require your choice.
          </text>
          <Show
            when={failedHandoff()}
            fallback={
              <text fg={ui.secondary}>
                No settled failed Handoff. Inspect the history; UNCERTAIN tasks cannot be resent.
              </text>
            }
          >
            {(h) => (
              <>
                <Show when={h().error}>
                  <text fg={ui.warning}>{h().error}</text>
                </Show>
                <text fg={ui.secondary}>
                  {`Source native session · ${sessions().find((s) => s.id === h().sourceNativeSessionId)?.status ?? "unavailable"}`}
                </text>
                <select
                  {...listStyle}
                  focused={!busy()}
                  flexGrow={1}
                  showDescription
                  options={[
                    {
                      name: "View saved context",
                      description: "Inspect the report and original source evidence",
                      value: "view",
                    },
                    {
                      name: "Confirm degraded context and send reserved target task",
                      description: "Send the reserved message using the available context",
                      value: "confirm",
                    },
                    {
                      name: "Retry report / target preparation",
                      description: "Reuse the reserved request and prepare its context again",
                      value: "retry",
                    },
                    {
                      name: "Cancel switch",
                      description: "Keep the target message unsent",
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
              </>
            )}
          </Show>
        </Panel>
      </Show>
      <Show when={materials() && props.form === "details"}>
        <SourceViewer
          parts={[
            {
              name: "Saved Handoff materials (may be incomplete)",
              text: `${materials()?.reportText ?? "No generated report"}\n\n${materials()?.fallbackText ?? "No fallback"}\n\n${JSON.stringify(materials(), null, 2)}`,
            },
          ]}
          onClose={() => {
            setMaterials(null);
            props.setForm(null);
          }}
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
        <Panel
          title="HarnessHub ACP settings"
          hint="Native session options · Enter applies · Esc closes"
          height="80%"
        >
          <Show
            when={sessionChoices().length}
            fallback={
              <text fg={ui.secondary}>
                No session options exposed by ACP. Start a native session first.
              </text>
            }
          >
            <select
              {...listStyle}
              focused={!busy()}
              flexGrow={1}
              options={sessionChoices()}
              showDescription
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
        </Panel>
      </Show>
    </box>
  );
}
