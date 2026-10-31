import type { ConversationEvent } from "@harnesshub/shared";
import { useKeyboard } from "@opentui/solid";
import { createSignal } from "solid-js";
import { SourceViewer } from "./source-viewer";
import { pretty } from "./transcript";

export function RawEvents(props: {
  events: ConversationEvent[];
  count: number;
  onClose: () => void;
}) {
  const [page, setPage] = createSignal(Math.max(0, Math.ceil(props.count / 100) - 1));
  useKeyboard((key) => {
    if (key.ctrl && ["pageup", "pagedown"].includes(key.name)) {
      key.preventDefault();
      setPage((v) =>
        Math.max(
          0,
          Math.min(
            Math.max(0, Math.ceil(props.count / 100) - 1),
            v + (key.name === "pageup" ? -1 : 1),
          ),
        ),
      );
    }
  });
  return (
    <SourceViewer
      parts={
        props.count
          ? props.events.slice(page() * 100, (page() + 1) * 100).map((event) => ({
              name: `Raw Events #${event.seq} ${event.kind} · Ctrl+PgUp/PgDn event pages`,
              text: pretty(event),
            }))
          : [{ name: "Raw Events", text: "No persisted events yet." }]
      }
      onClose={props.onClose}
    />
  );
}
