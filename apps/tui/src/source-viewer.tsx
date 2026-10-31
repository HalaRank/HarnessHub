import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/solid";
import { createMemo, createSignal, For } from "solid-js";
import type { SourcePart } from "./rich-content";

// Showing source never submits it to an Agent. Copy uses the original string, not screen text.
export function SourceViewer(props: { parts: SourcePart[]; onClose: () => void }) {
  const renderer = useRenderer();
  let scroll: ScrollBoxRenderable | undefined;
  const [selected, setSelected] = createSignal(0),
    [page, setPage] = createSignal(0),
    [notice, setNotice] = createSignal("");
  const source = () => props.parts[selected()]?.text ?? "";
  const count = () => Math.max(1, Math.ceil(source().length / 24000));
  const options = createMemo(() =>
    props.parts.map((p) => ({ name: p.name, description: "", value: p })),
  );
  const copy = () =>
    setNotice(
      renderer.copyToClipboardOSC52(source())
        ? "Copy sent to terminal clipboard (OSC52); terminal policy controls acceptance"
        : "Terminal clipboard unavailable; select source text to copy",
    );
  useKeyboard((key) => {
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
    <box
      position="absolute"
      top={1}
      left={1}
      width="96%"
      height="94%"
      border
      borderColor="#80cbc4"
      backgroundColor="#10151c"
      padding={1}
      flexDirection="column"
      gap={1}
      title="Original source · Esc close"
    >
      <select
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
      <text>
        Enter copy full selected source · Ctrl+←/→ source pages {page() + 1}/{count()}
      </text>
      <scrollbox
        ref={(el) => {
          scroll = el;
        }}
        flexGrow={1}
        scrollX
        scrollY
      >
        <text selectable flexShrink={0} wrapMode="none">
          {source().slice(page() * 24000, (page() + 1) * 24000)}
        </text>
      </scrollbox>
      <For each={notice() ? [notice()] : []}>{(value) => <text fg="#ffcc80">{value}</text>}</For>
    </box>
  );
}
