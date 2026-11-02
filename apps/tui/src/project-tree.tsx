import type { Conversation, Project } from "@harnesshub/shared";
import type { MouseEvent, ScrollBoxRenderable } from "@opentui/core";
import { createEffect, createSignal, For, Show, untrack } from "solid-js";

export type ProjectRow = { id: string; project: Project; conversation?: Conversation };
export const projectKey = (id: string) => `project-${id}`;
export const conversationKey = (id: string) => `conversation-${id}`;

// OpenTUI 0.8 has mouse down/up and drag events, but no synthetic click.
// Keep the gesture outside individual rows so metadata refreshes cannot retarget it.
export function mouseClick() {
  let press: { id: string; x: number; y: number } | undefined;
  return (id: string, event: MouseEvent, run: () => void) => {
    // OpenTUI may emit the previous target's deferred hover-out after a new down.
    // Only leaving the pressed target can cancel that gesture.
    if (
      ["drag", "drag-end", "scroll"].includes(event.type) ||
      (event.type === "out" && press?.id === id && (event.x !== press.x || event.y !== press.y))
    )
      press = undefined;
    if (event.type === "scroll" || event.type === "over" || event.type === "out") return;
    event.stopPropagation();
    event.preventDefault(); // Keep sidebar presses out of native selection and autofocus.
    if (event.type === "down") {
      press =
        event.button === 0 &&
        !event.modifiers.shift &&
        !event.modifiers.ctrl &&
        !event.modifiers.alt
          ? { id, x: event.x, y: event.y }
          : undefined;
    }
    if (event.type === "up") {
      const start = press;
      press = undefined;
      if (
        event.button === 0 &&
        !event.isDragging &&
        start?.id === id &&
        start.x === event.x &&
        start.y === event.y
      )
        run();
    }
  };
}

export function ProjectTree(props: {
  rows: ProjectRow[];
  selected: string | null;
  activeProjectId: string | null;
  collapsed: ReadonlySet<string>;
  disabled: boolean;
  onSelect: (row: ProjectRow) => void;
  onToggle: (projectId: string) => void;
  onProjectClick: (row: ProjectRow) => void;
  onActions: (conversation: Conversation) => void;
}) {
  const [hovered, setHovered] = createSignal<string | null>(null);
  const click = mouseClick();
  let scroll: ScrollBoxRenderable | undefined;
  createEffect(() => {
    const selected = props.selected;
    // Reveal navigation, never reset the wheel position on a background snapshot update.
    untrack(() => {
      if (selected) scroll?.afterLayout(() => scroll?.scrollChildIntoView(selected));
    });
  });
  const mouse = (id: string, event: MouseEvent, run: () => void) => {
    if (props.disabled) return;
    click(id, event, run);
  };
  return (
    <scrollbox
      id="project-tree"
      ref={(element) => {
        scroll = element;
      }}
      flexGrow={1}
      minHeight={0}
      scrollX={false}
      focused={false}
      onMouseScroll={(event) => {
        click("", event, () => {});
        event.stopPropagation();
      }}
    >
      <For each={props.rows}>
        {(row) => (
          <box
            id={row.id}
            height={1}
            flexShrink={0}
            flexDirection="row"
            backgroundColor={
              props.selected === row.id
                ? "#264b63"
                : hovered() === row.id
                  ? "#1c2935"
                  : !row.conversation &&
                      props.activeProjectId === row.project.id &&
                      props.collapsed.has(row.project.id)
                    ? "#203747"
                    : "transparent"
            }
            onMouse={(event) => {
              if (event.type === "over") setHovered(row.id);
              if (event.type === "out") setHovered((id) => (id === row.id ? null : id));
              mouse(row.id, event, () =>
                row.conversation ? props.onSelect(row) : props.onProjectClick(row),
              );
            }}
          >
            <Show
              when={!row.conversation}
              fallback={
                <text selectable={false} width={4} flexShrink={0}>
                  {"  └ "}
                </text>
              }
            >
              <text
                id={`arrow-${row.project.id}`}
                selectable={false}
                width={2}
                flexShrink={0}
                fg="#80cbc4"
                onMouse={(event) =>
                  mouse(`arrow-${row.project.id}`, event, () => props.onToggle(row.project.id))
                }
              >
                {props.collapsed.has(row.project.id) ? "▸ " : "▾ "}
              </text>
            </Show>
            <text
              selectable={false}
              flexGrow={1}
              flexShrink={1}
              width={0}
              minWidth={0}
              height={1}
              wrapMode="none"
              fg={!row.conversation ? "#80cbc4" : props.selected === row.id ? "#ffffff" : "#c9d1d9"}
            >
              {row.conversation ? (
                `${row.conversation.runtimeStatus !== "IDLE" ? `${row.conversation.runtimeStatus} · ` : ""}${row.conversation.title}${row.conversation.archivedAt !== null ? " [archived]" : ""}`
              ) : (
                <b>{row.project.name}</b>
              )}
            </text>
            <Show when={row.conversation}>
              {(conversation) => (
                <text
                  id={`actions-${conversation().id}`}
                  selectable={false}
                  width={3}
                  flexShrink={0}
                  fg="#80cbc4"
                  onMouse={(event) =>
                    mouse(`actions-${conversation().id}`, event, () =>
                      props.onActions(conversation()),
                    )
                  }
                >
                  {" ⋯ "}
                </text>
              )}
            </Show>
          </box>
        )}
      </For>
    </scrollbox>
  );
}

export function ConversationActions(props: {
  conversation: Conversation;
  busy: boolean;
  onRename: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const click = mouseClick();
  const [hovered, setHovered] = createSignal("");
  return (
    <box
      position="absolute"
      top={3}
      left={3}
      width={38}
      height={8}
      border
      borderColor="#80cbc4"
      backgroundColor="#10151c"
      flexDirection="column"
      title="Conversation actions · Esc close"
    >
      <text selectable={false} height={1} wrapMode="none">
        {props.conversation.title}
      </text>
      <For
        each={[
          { id: "rename", label: "Rename Conversation…", run: props.onRename },
          {
            id: "archive",
            label:
              props.conversation.archivedAt === null
                ? "Archive Conversation"
                : "Restore Archived Conversation",
            run: props.onArchive,
          },
          { id: "delete", label: "Delete Conversation…", run: props.onDelete },
          { id: "close", label: "Close", run: props.onClose },
        ]}
      >
        {(action) => (
          <text
            id={`conversation-action-${action.id}`}
            selectable={false}
            height={1}
            bg={hovered() === action.id ? "#1c2935" : "transparent"}
            onMouse={(event) => {
              if (event.type === "over") setHovered(action.id);
              if (event.type === "out") setHovered("");
              if (!props.busy) click(action.id, event, action.run);
            }}
          >
            {action.label}
          </text>
        )}
      </For>
    </box>
  );
}
