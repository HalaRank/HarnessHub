import { activeStates, type Conversation } from "@harnesshub/shared";
import { createMemo, createSignal, For, Show } from "solid-js";
import { ActionButton } from "./action-button";
import { ProjectDirectory } from "./project-directory";
import { mouseClick } from "./project-tree";
import { statusColor, ui } from "./ui";

export function WorkspaceOverview(props: {
  rootPath: string;
  conversations: Conversation[];
  disabled: boolean;
  archived?: boolean;
  onCreate: (mode: "shared" | "worktree") => void;
  onSelect: (conversation: Conversation) => void;
}) {
  const [width, setWidth] = createSignal(0);
  const [height, setHeight] = createSignal(0);
  const [hovered, setHovered] = createSignal<string | null>(null);
  const click = mouseClick();
  const wide = () => width() >= 92;
  const compact = () => height() < 22;
  const recent = createMemo(() =>
    props.conversations
      .filter((c) => (props.archived ? c.archivedAt !== null : c.archivedAt === null))
      .sort((a, b) => b.updatedAt - a.updatedAt),
  );
  const running = () => recent().filter((c) => activeStates.has(c.runtimeStatus)).length;
  return (
    <box
      id="workspace-overview"
      flexGrow={1}
      minHeight={0}
      flexDirection="column"
      ref={(element) => {
        element.onSizeChange = () => {
          setWidth(element.width);
          setHeight(element.height);
        };
      }}
    >
      <box
        flexDirection="column"
        paddingY={compact() ? 0 : 1}
        flexShrink={0}
        gap={compact() ? 0 : 1}
      >
        <Show when={height() >= 14}>
          <text fg={ui.secondary} height={1} wrapMode="none">
            <span style={{ fg: ui.accent }}>{recent().length}</span>{" "}
            {recent().length === 1 ? "conversation" : "conversations"}
            <span
              style={{ fg: running() ? ui.accent : ui.muted }}
            >{`   ·   ${running()} active`}</span>
          </text>
        </Show>
        <box
          flexDirection="row"
          flexWrap="wrap"
          columnGap={1}
          rowGap={compact() ? 0 : 1}
          flexShrink={0}
        >
          <ActionButton
            id="project-new-conversation"
            label={width() < 48 ? "New conversation" : "+ New conversation"}
            hint="N"
            primary
            disabled={props.disabled}
            onPress={() => props.onCreate("shared")}
          />
          <ActionButton
            id="project-new-worktree"
            label={width() < 48 ? "Worktree" : "+ Git worktree"}
            disabled={props.disabled}
            onPress={() => props.onCreate("worktree")}
          />
        </box>
      </box>
      <box
        flexGrow={1}
        minHeight={0}
        flexDirection={wide() ? "row" : "column"}
        gap={height() < 14 ? 0 : 1}
      >
        <box
          id="workspace-conversations"
          flexDirection="column"
          width={wide() ? "55%" : "100%"}
          height={wide() ? "100%" : compact() ? 3 : 9}
          flexShrink={0}
          minHeight={0}
          border={["top"]}
          borderColor={ui.border}
          title={props.archived ? " Archived conversations " : " Conversations "}
          titleColor={ui.secondary}
        >
          <Show
            when={recent().length > 0}
            fallback={
              <box flexDirection="column" paddingX={1} paddingTop={compact() ? 0 : 1}>
                <text fg={ui.text} height={1} wrapMode="none">
                  <b>{props.archived ? "No archived conversations." : "Start something here."}</b>
                </text>
                <text
                  fg={ui.muted}
                  height={compact() ? 1 : "auto"}
                  wrapMode={compact() ? "none" : "word"}
                >
                  {props.archived
                    ? "Use Commands to return to active conversations."
                    : "Create a conversation to work in this project."}
                </text>
                <Show when={!compact() && !props.archived}>
                  <text fg={ui.muted}>Use a Git worktree when you need an isolated branch.</text>
                </Show>
              </box>
            }
          >
            <scrollbox id="workspace-recent-list" flexGrow={1} minHeight={0} scrollX={false}>
              <For each={recent()}>
                {(conversation) => (
                  <box
                    id={`recent-${conversation.id}`}
                    flexDirection="column"
                    height={2}
                    flexShrink={0}
                    paddingX={1}
                    backgroundColor={hovered() === conversation.id ? ui.hover : "transparent"}
                    onMouse={(event) => {
                      if (event.type === "over") setHovered(conversation.id);
                      if (event.type === "out") setHovered(null);
                      click(conversation.id, event, () => {
                        if (!props.disabled) props.onSelect(conversation);
                      });
                    }}
                  >
                    <text height={1} wrapMode="none" truncate selectable={false} fg={ui.text}>
                      <span style={{ fg: statusColor(conversation.runtimeStatus) }}>● </span>
                      {conversation.title}
                    </text>
                    <text height={1} wrapMode="none" selectable={false} fg={ui.muted}>
                      {"  "}
                      <span style={{ fg: statusColor(conversation.runtimeStatus) }}>
                        {conversation.runtimeStatus}
                      </span>
                      {` · ${conversation.selectedHarnessId ?? "Harness not selected"} · ${conversation.workspaceMode}`}
                    </text>
                  </box>
                )}
              </For>
            </scrollbox>
          </Show>
        </box>
        <box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} minHeight={0}>
          <ProjectDirectory
            rootPath={props.rootPath}
            showRoot={false}
            disabled={props.disabled}
            compact={height() < 14}
          />
        </box>
      </box>
    </box>
  );
}
