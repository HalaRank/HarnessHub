import { useKeyboard } from "@opentui/solid";
import { createMemo, createSignal } from "solid-js";
export type Command = { id: string; name: string; run: () => void };
export function CommandPalette(props: { commands: Command[]; onClose: () => void }) {
  const [query, setQuery] = createSignal(""),
    [selected, setSelected] = createSignal(0);
  const options = createMemo(() =>
    props.commands
      .filter((command) => command.name.toLocaleLowerCase().includes(query().toLocaleLowerCase()))
      .map((command) => ({ name: command.name, description: "", value: command })),
  );
  const choose = () => {
    const command = options()[selected()]?.value;
    if (command) {
      props.onClose();
      command.run();
    }
  };
  useKeyboard((key) => {
    if (["up", "down"].includes(key.name)) {
      key.preventDefault();
      setSelected((i) =>
        Math.max(0, Math.min(options().length - 1, i + (key.name === "up" ? -1 : 1))),
      );
    }
  });
  return (
    <box
      position="absolute"
      top={2}
      left="8%"
      width="84%"
      height="75%"
      border
      borderColor="#80cbc4"
      backgroundColor="#10151c"
      padding={1}
      flexDirection="column"
      gap={1}
      title="Command palette · ↑/↓ choose · Enter execute · Esc close"
    >
      <input
        focused
        placeholder="Search Projects, Conversations and actions…"
        onInput={(value) => {
          setQuery(value);
          setSelected(0);
        }}
        onSubmit={choose}
      />
      <select
        options={options()}
        selectedIndex={selected()}
        showDescription={false}
        flexGrow={1}
        onChange={(index) => setSelected(index)}
        onSelect={choose}
      />
    </box>
  );
}
