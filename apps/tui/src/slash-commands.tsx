import type { NativeCommand } from "@harnesshub/shared";
import type { ScrollBoxRenderable } from "@opentui/core";
import { createEffect, For, Show } from "solid-js";
import { mouseClick } from "./project-tree";

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
  commands: NativeCommand[];
  selected: number;
  height: number;
  bottom: number;
  status: string;
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
      borderColor="#80cbc4"
      backgroundColor="#10151c"
      flexDirection="column"
      title="ACP commands · ↑↓ · Tab / Enter complete · Esc close"
    >
      <scrollbox
        id="slash-options"
        ref={(el) => {
          scroll = el;
        }}
        flexGrow={1}
        minHeight={0}
      >
        <Show
          when={props.commands.length}
          fallback={<text selectable={false}>{props.status}</text>}
        >
          <For each={props.commands}>
            {(command, index) => (
              <box
                id={`slash-${index()}`}
                flexDirection="column"
                flexShrink={0}
                backgroundColor={props.selected === index() ? "#36404b" : "#10151c"}
                onMouse={(event) => click(command.name, event, () => props.choose(command))}
              >
                <text
                  selectable={false}
                  fg="#80cbc4"
                >{`/${command.name}${command.input?.hint ? ` · ${command.input.hint}` : ""}`}</text>
                <text selectable={false}>{command.description}</text>
              </box>
            )}
          </For>
        </Show>
      </scrollbox>
    </box>
  );
}
