import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { createEffect, createMemo, createSignal, Index, Show } from "solid-js";
import { mouseClick } from "./project-tree";
import { inputStyle, KeyHints, Panel, ui } from "./ui";

export type CommandGroup =
  | "Conversation"
  | "Workspace"
  | "Projects"
  | "Conversations"
  | "Interface";
export type Command = {
  id: string;
  name: string;
  description?: string;
  group?: CommandGroup;
  shortcut?: string;
  danger?: boolean;
  order?: number;
  run: () => void;
};
const groupOrder: CommandGroup[] = [
  "Conversation",
  "Workspace",
  "Projects",
  "Conversations",
  "Interface",
];

export function CommandPalette(props: {
  commands: Command[];
  onClose: () => void;
  title?: string;
}) {
  const dimensions = useTerminalDimensions();
  const [query, setQuery] = createSignal("");
  const [selectedId, setSelectedId] = createSignal<string | undefined>();
  const [hovered, setHovered] = createSignal<string | null>(null);
  let scroll: ScrollBoxRenderable | undefined;
  const click = mouseClick();
  const compact = () => dimensions().height < 20;
  const options = createMemo(() => {
    const search = query().trim().replace(/^\//, "").toLocaleLowerCase();
    const tokens = search.split(/\s+/).filter(Boolean);
    return props.commands
      .map((command, index) => {
        const name = command.name.toLocaleLowerCase();
        const text =
          `${name} ${command.description ?? ""} ${command.group ?? ""}`.toLocaleLowerCase();
        return {
          command,
          index,
          matches: tokens.every((token) => text.includes(token)),
          score: !search
            ? 0
            : name === search
              ? 3
              : name.startsWith(search)
                ? 2
                : name.includes(search)
                  ? 1
                  : 0,
        };
      })
      .filter((item) => item.matches)
      .sort((a, b) => {
        if (search) return b.score - a.score || a.index - b.index;
        return (
          groupOrder.indexOf(a.command.group ?? "Workspace") -
            groupOrder.indexOf(b.command.group ?? "Workspace") ||
          (a.command.order ?? 0) - (b.command.order ?? 0) ||
          a.index - b.index
        );
      })
      .map(({ command }) => command);
  });
  const selected = () =>
    Math.max(
      0,
      options().findIndex((command) => command.id === selectedId()),
    );
  const current = () => options()[selected()];
  const rowId = (id: string) => `command-option-${id}`;
  createEffect(() => {
    const command = current();
    scroll?.afterLayout(() => {
      if (command) scroll?.scrollChildIntoView(rowId(command.id));
    });
  });
  const choose = (command = current()) => {
    if (!command) return;
    props.onClose();
    command.run();
  };
  useKeyboard((key) => {
    if (key.defaultPrevented || key.propagationStopped) return;
    if (key.name === "escape") {
      key.preventDefault();
      key.stopPropagation();
      props.onClose();
    }
    if (["up", "down", "pageup", "pagedown"].includes(key.name)) {
      key.preventDefault();
      key.stopPropagation();
      const step = key.name.startsWith("page")
        ? Math.max(1, Math.floor((scroll?.height ?? 6) / 2) - 1)
        : 1;
      const delta = ["up", "pageup"].includes(key.name) ? -step : step;
      const next = Math.max(0, Math.min(options().length - 1, selected() + delta));
      setSelectedId(options()[next]?.id);
    }
  });
  return (
    <Panel
      id="command-palette"
      title={props.title ?? "Command palette"}
      height={Math.min(32, Math.max(8, dimensions().height - (compact() ? 2 : 4)))}
      width={Math.min(88, dimensions().width - 2)}
    >
      <box
        border={["bottom"]}
        borderColor={ui.border}
        height={compact() ? 2 : 3}
        flexShrink={0}
        paddingTop={compact() ? 0 : 1}
        flexDirection="row"
        backgroundColor={ui.input}
      >
        <text fg={ui.accent} selectable={false} width={2} height={1}>
          ›{" "}
        </text>
        <input
          {...inputStyle}
          id="command-search"
          width={0}
          flexShrink={1}
          focused
          flexGrow={1}
          minWidth={0}
          placeholder="Search commands, projects, conversations…"
          onInput={(value) => {
            setQuery(value);
            setSelectedId(undefined);
          }}
          onSubmit={() => choose()}
        />
      </box>
      <box height={1} flexShrink={0} flexDirection="row" paddingX={1}>
        <text fg={ui.muted} height={1} flexGrow={1} minWidth={0} wrapMode="none" truncate>
          {query().trim() ? "Search results" : "Browse commands"}
        </text>
        <text fg={ui.muted} height={1} flexShrink={0}>
          {options().length ? `${selected() + 1} / ${options().length}` : "0 results"}
        </text>
      </box>
      <scrollbox
        id="command-results"
        ref={(element) => {
          scroll = element;
        }}
        flexGrow={1}
        minHeight={0}
        scrollX={false}
        focused={false}
      >
        <Show
          when={options().length}
          fallback={
            <box flexDirection="column" paddingX={1} paddingY={compact() ? 0 : 1}>
              <text fg={ui.text}>No matching commands.</text>
              <text fg={ui.muted}>Try a name or workspace path.</text>
            </box>
          }
        >
          <Index each={options()}>
            {(command, index) => (
              <box flexDirection="column" flexShrink={0}>
                <Show
                  when={
                    !query().trim() &&
                    (index === 0 || command().group !== options()[index - 1]?.group)
                  }
                >
                  <text height={1} flexShrink={0} fg={ui.accent} selectable={false} paddingLeft={1}>
                    <b>{command().group ?? "Workspace"}</b>
                  </text>
                </Show>
                <box
                  id={rowId(command().id)}
                  flexDirection="column"
                  height={command().description ? 2 : 1}
                  flexShrink={0}
                  paddingX={1}
                  backgroundColor={
                    current()?.id === command().id
                      ? ui.selection
                      : hovered() === command().id
                        ? ui.hover
                        : ui.panel
                  }
                  onMouse={(event) => {
                    if (event.type === "over") setHovered(command().id);
                    if (event.type === "out") setHovered(null);
                    click(command().id, event, () => choose(command()));
                  }}
                >
                  <box flexDirection="row" height={1} flexShrink={0}>
                    <text selectable={false} fg={ui.accent} width={2} height={1}>
                      {current()?.id === command().id ? "› " : "  "}
                    </text>
                    <text
                      selectable={false}
                      height={1}
                      flexGrow={1}
                      minWidth={0}
                      wrapMode="none"
                      truncate
                      fg={command().danger ? ui.error : ui.text}
                    >
                      <b>{command().name}</b>
                    </text>
                    <Show when={command().shortcut && dimensions().width >= 60}>
                      <text
                        selectable={false}
                        height={1}
                        flexShrink={0}
                        fg={ui.muted}
                      >{`  ${command().shortcut}`}</text>
                    </Show>
                  </box>
                  <Show when={command().description}>
                    <box paddingLeft={2} height={1} flexShrink={0}>
                      <text
                        selectable={false}
                        height={1}
                        wrapMode="none"
                        truncate
                        fg={current()?.id === command().id ? ui.secondary : ui.muted}
                      >
                        {command().description}
                      </text>
                    </box>
                  </Show>
                </box>
              </box>
            )}
          </Index>
        </Show>
      </scrollbox>
      <Show when={!compact() && current()?.description}>
        <box border={["top"]} borderColor={ui.border} paddingX={1} flexShrink={0} maxHeight={4}>
          <text id="command-description" fg={ui.secondary} maxHeight={3}>
            {current()?.description}
          </text>
        </box>
      </Show>
      <box height={1} flexShrink={0} backgroundColor={ui.input}>
        <KeyHints
          items={[
            ["↑↓", "choose"],
            ["Enter", "execute"],
            ["Esc", "close"],
            ["PgUp/PgDn", "page"],
          ]}
        />
      </box>
    </Panel>
  );
}
