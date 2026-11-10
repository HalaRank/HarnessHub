import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import { createEffect, createMemo, createSignal, For, untrack } from "solid-js";
import { useClipboard } from "./clipboard";
import type { SourcePart } from "./rich-content";
import { KeyHints, listStyle, Panel, ui } from "./ui";

// Showing source never submits it to an Agent. Copy uses the original string, not screen text.
export function SourceViewer(props: { parts: SourcePart[]; onClose: () => void }) {
  const copyText = useClipboard();
  let scroll: ScrollBoxRenderable | undefined;
  const [selected, setSelected] = createSignal(0),
    [page, setPage] = createSignal(0),
    [notice, setNotice] = createSignal("");
  createEffect(() => {
    if (untrack(selected) >= props.parts.length) setSelected(0);
    const text = props.parts[untrack(selected)]?.text ?? "";
    setPage((value) => Math.min(value, Math.max(0, Math.ceil(text.length / 24000) - 1)));
  });
  const source = () => props.parts[selected()]?.text ?? "";
  const count = () => Math.max(1, Math.ceil(source().length / 24000));
  const options = createMemo(() =>
    props.parts.map((p) => ({ name: p.name, description: "", value: p })),
  );
  const copy = () => {
    void copyText(source()).then(setNotice);
  };
  useKeyboard((key) => {
    if (key.defaultPrevented || key.propagationStopped) return;
    if (key.name === "escape") {
      key.preventDefault();
      key.stopPropagation();
      props.onClose();
    }
    if (key.name === "pageup" || key.name === "pagedown") {
      key.preventDefault();
      scroll?.scrollBy(key.name === "pageup" ? -0.8 : 0.8, "viewport");
    }
    if (key.name === "return") {
      key.preventDefault();
      copy();
    }
    if (key.ctrl && (key.name === "left" || key.name === "right")) {
      key.preventDefault();
      setPage((v) => Math.max(0, Math.min(count() - 1, v + (key.name === "left" ? -1 : 1))));
    }
  });
  return (
    <Panel
      title="Original source"
      width="96%"
      hint="Inspect and copy complete original content. Esc closes."
      height="94%"
    >
      <select
        {...listStyle}
        height={Math.min(5, props.parts.length + 1)}
        options={options()}
        focused
        selectedIndex={selected()}
        showDescription={false}
        onChange={(index) => {
          setSelected(index);
          setPage(0);
        }}
      />
      <KeyHints
        items={[
          ["Enter", "copy full selected source"],
          ["Ctrl+←/→", `source pages ${page() + 1}/${count()}`],
        ]}
      />
      <scrollbox
        ref={(el) => {
          scroll = el;
        }}
        flexGrow={1}
        scrollX
        scrollY
      >
        <text selectable flexShrink={0} wrapMode="none" fg={ui.text}>
          {source().slice(page() * 24000, (page() + 1) * 24000)}
        </text>
      </scrollbox>
      <For each={notice() ? [notice()] : []}>{(value) => <text fg={ui.warning}>{value}</text>}</For>
    </Panel>
  );
}
