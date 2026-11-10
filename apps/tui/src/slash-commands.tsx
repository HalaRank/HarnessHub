import type { NativeCommand } from "@harnesshub/shared";
import type { ScrollBoxRenderable } from "@opentui/core";
import { createEffect, For, Show } from "solid-js";
import { mouseClick } from "./project-tree";
import { KeyHints, ui } from "./ui";

// Only the first token of the entire message is a command trigger. The caller
// obtains the prefix from the editor's real cursor (native offsets are not JS UTF-16).
export function slashQuery(text: string, prefix: string): string | null {
  if (!/^\/[^\s/\\`]*$/.test(prefix)) return null;
  const token = text.split(/\s/, 1)[0] ?? "";
  if (!token.startsWith(prefix) || /[/\\`]/.test(token.slice(1))) return null;
  return prefix.slice(1);
}
export function matchingCommands(commands: NativeCommand[], query: string) {
  return commands.filter((c) => c.name.toLocaleLowerCase().startsWith(query.toLocaleLowerCase()));
}
export function SlashCommands(props: {
  title?: string;
  commands: NativeCommand[];
  selected: number;
  height: number;
  bottom: number;
  status: string;
  notice?: string;
  choose: (command: NativeCommand) => void;
}) {
  let scroll: ScrollBoxRenderable | undefined;
  const click = mouseClick();
  createEffect(() => {
    const selected = props.selected;
    const commands = props.commands;
    scroll?.afterLayout(() => {
      if (commands[selected]) scroll?.scrollChildIntoView(`slash-${selected}`);
    });
  });
  return (
    <box
      id="slash-popup"
      position="absolute"
      bottom={props.bottom}
      left={0}
      width="100%"
      height={props.height}
      zIndex={20}
      border
      borderColor={ui.border}
      backgroundColor={ui.panel}
      flexDirection="column"
      paddingX={1}
    >
      <text height={1} flexShrink={0} fg={ui.text} selectable={false}>
        <b>{props.title ?? "ACP commands"}</b>
        <span style={{ fg: ui.muted }}>{`  ${props.commands.length} available`}</span>
      </text>
      <scrollbox
        id="slash-options"
        ref={(el) => {
          scroll = el;
        }}
        flexGrow={1}
        minHeight={0}
      >
        <Show when={props.notice}>
          <text fg={ui.secondary}>{props.notice}</text>
        </Show>
        <Show
          when={props.commands.length}
          fallback={
            <text selectable={false} fg={ui.secondary}>
              {props.status}
            </text>
          }
        >
          <For each={props.commands}>
            {(command, index) => (
              <box
                id={`slash-${index()}`}
                flexDirection="column"
                flexShrink={0}
                backgroundColor={props.selected === index() ? ui.selection : ui.panel}
                onMouse={(event) => click(command.name, event, () => props.choose(command))}
              >
                <text selectable={false} fg={ui.text} height={1} wrapMode="none" truncate>
                  <span style={{ fg: ui.accent }}>{props.selected === index() ? "› " : "  "}</span>
                  <b>{`/${command.name}`}</b>
                  <span style={{ fg: props.selected === index() ? ui.secondary : ui.muted }}>
                    {command.input?.hint ? `  ${command.input.hint}` : ""}
                  </span>
                </text>
                <box paddingLeft={2}>
                  <text
                    selectable={false}
                    fg={props.selected === index() ? ui.secondary : ui.muted}
                  >
                    {command.description}
                  </text>
                </box>
              </box>
            )}
          </For>
        </Show>
      </scrollbox>
      <KeyHints
        items={[
          ["↑↓", "choose"],
          ["Tab / Enter", "complete"],
          ["Esc", "close"],
        ]}
      />
    </box>
  );
}
