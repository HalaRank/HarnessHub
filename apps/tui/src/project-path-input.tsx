import type { InputRenderable } from "@opentui/core";
import { createSignal, onCleanup, Show } from "solid-js";
import { completeProjectPath } from "./project-path";

export function ProjectPathInput(props: { busy: boolean; onSubmit: (value: string) => void }) {
  let input: InputRenderable;
  let revision = 0;
  const [hint, setHint] = createSignal("");
  onCleanup(() => revision++);
  const complete = async () => {
    const current = ++revision;
    const value = input.value;
    const cursor = input.cursorOffset;
    const prefix = input.getTextRange(0, cursor);
    const isCurrent = () =>
      current === revision && !props.busy && input.value === value && input.cursorOffset === cursor;
    try {
      const result = await completeProjectPath(prefix);
      if (!isCurrent()) return;
      let insertion = result.value.slice(prefix.length);
      if (insertion.endsWith("/") && value.slice(prefix.length).startsWith("/"))
        insertion = insertion.slice(0, -1);
      if (insertion) input.insertText(insertion);
      setHint(
        result.candidates.length === 0
          ? "No matching directories"
          : result.candidates.length > 1
            ? result.candidates.join("  ")
            : "",
      );
    } catch {
      if (isCurrent()) setHint("Cannot read this directory");
    }
  };
  return (
    <box flexDirection="column">
      <box border title="Existing project: directory · Tab complete · Enter register" height={3}>
        <input
          id="project-path"
          ref={(element) => {
            input = element;
          }}
          value="~/"
          focused={!props.busy}
          onInput={() => {
            revision++;
            setHint("");
          }}
          onKeyDown={(key) => {
            if (key.name === "tab" && !key.ctrl && !key.meta && !key.shift) {
              key.preventDefault();
              if (!props.busy) void complete();
            }
          }}
          onSubmit={(value) => {
            if (typeof value === "string") props.onSubmit(value);
          }}
          width="100%"
        />
      </box>
      <Show when={hint()}>
        <text maxHeight={3}>{hint()}</text>
      </Show>
    </box>
  );
}
