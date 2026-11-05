import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { createMemo, createSignal, Show } from "solid-js";
import { inputStyle, KeyHints, listStyle, Panel, ui } from "./ui";
export type Command = { id: string; name: string; description?: string; run: () => void };
export function CommandPalette(props: {
  commands: Command[];
  onClose: () => void;
  title?: string;
}) {
  const dimensions = useTerminalDimensions();
  const [query, setQuery] = createSignal(""),
    [selected, setSelected] = createSignal(0);
  const options = createMemo(() =>
    props.commands
      .filter((command) =>
        `${command.name} ${command.description ?? ""}`
          .toLocaleLowerCase()
          .includes(query().toLocaleLowerCase()),
      )
      .map((command) => ({
        name: command.name,
        description: command.description ?? "",
        value: command,
      })),
  );
  const choose = () => {
    const command = options()[selected()]?.value;
    if (command) {
      props.onClose();
      command.run();
    }
  };
  useKeyboard((key) => {
    if (key.defaultPrevented || key.propagationStopped) return;
    if (["up", "down"].includes(key.name)) {
      key.preventDefault();
      key.stopPropagation();
      setSelected((i) =>
        Math.max(0, Math.min(options().length - 1, i + (key.name === "up" ? -1 : 1))),
      );
    }
  });
  return (
    <Panel
      title={props.title ?? "Command palette"}
      height="75%"
      hint="Search projects, conversations and actions"
    >
      <Show when={dimensions().width >= 80 && dimensions().height >= 24 && !query()}>
        <text fg={ui.secondary} height={1} flexShrink={0} wrapMode="none">
          Enter send / steer · Tab queue · Esc interrupt · Shift+Enter newline
        </text>
        <text fg={ui.muted} height={1} flexShrink={0} wrapMode="none">
          ↑↓ prompt history · Ctrl+R search history · Ctrl+O copy response · Ctrl+T transcript
        </text>
      </Show>
      <input
        {...inputStyle}
        focused
        placeholder="Search Projects, Conversations and actions…"
        onInput={(value) => {
          setQuery(value);
          setSelected(0);
        }}
        onSubmit={choose}
      />
      <Show
        when={options().length}
        fallback={<text fg={ui.muted}>No matching commands. Try a different search.</text>}
      >
        <select
          {...listStyle}
          options={options()}
          selectedIndex={selected()}
          showDescription
          flexGrow={1}
          onChange={(index) => setSelected(index)}
          onSelect={choose}
        />
      </Show>
      <KeyHints
        items={[
          ["↑↓", "choose"],
          ["Enter", "execute"],
          ["Esc", "close"],
        ]}
      />
    </Panel>
  );
}
