import {
  type CliRenderer,
  createClipboard,
  createHostClipboard,
  createRendererClipboardAdapter,
} from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { onCleanup } from "solid-js";

// OpenTUI selects the available native host provider; OSC52 is the terminal fallback.
export function useClipboard() {
  const renderer = useRenderer();
  const clipboard = createClipboard({
    host: createHostClipboard({ timeoutMs: 1000 }),
    terminal: createRendererClipboardAdapter(renderer),
  });
  let queue = Promise.resolve("");
  onCleanup(() => {
    void queue.finally(() => clipboard.dispose());
  });
  return (text: string) => {
    const next = queue.then(async () => {
      try {
        let result = await clipboard.writeText(text, { destination: "best-available" });
        if (result.host.status === "timed-out" && result.terminal.status === "not-attempted")
          result = await clipboard.writeText(text, { destination: "terminal-only" });
        return result.host.status === "written"
          ? "Copied to system clipboard"
          : result.terminal.status === "attempted"
            ? "Copy sent to terminal clipboard; terminal policy controls acceptance"
            : "Clipboard unavailable; use y to view original source";
      } catch {
        return "Clipboard unavailable; use y to view original source";
      }
    });
    queue = next;
    return next;
  };
}

// A single synchronous decision is shared by raw Ctrl+C and the OS SIGINT path.
export function interruptTui(
  renderer: CliRenderer,
  copy: (text: string) => void,
  clearInput: () => boolean,
  exit: () => void,
) {
  const selection = renderer.getSelection()?.getSelectedText();
  if (selection) {
    renderer.clearSelection();
    copy(selection);
    return;
  }
  renderer.clearSelection();
  if (!clearInput()) exit();
}
