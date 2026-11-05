import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { mouseClick } from "./project-tree";
import { ui } from "./ui";

type Entry = { path: string; name: string; directory: boolean; symlink: boolean };

// TUI and Daemon run locally. This read-only view never invokes an Agent or follows symlinks.
export function ProjectDirectory(props: { rootPath: string }) {
  const cache = new Map<string, Entry[]>();
  const [open, setOpen] = createSignal<ReadonlySet<string>>(new Set([props.rootPath]));
  const [errors, setErrors] = createSignal<Record<string, string>>({});
  const [revision, setRevision] = createSignal(0);
  let disposed = false;
  const click = mouseClick();
  const load = async (path: string) => {
    try {
      const entries = await readdir(path, { withFileTypes: true });
      if (disposed) return;
      cache.set(
        path,
        entries
          .map((entry) => ({
            path: join(path, entry.name),
            name: entry.name,
            directory: entry.isDirectory(),
            symlink: entry.isSymbolicLink(),
          }))
          .sort(
            (a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name),
          ),
      );
      setErrors((current) => {
        const next = { ...current };
        delete next[path];
        return next;
      });
      setRevision((value) => value + 1);
    } catch (error) {
      if (!disposed)
        setErrors((current) => ({
          ...current,
          [path]: error instanceof Error ? error.message : "Cannot read directory",
        }));
    }
  };
  onMount(() => {
    void load(props.rootPath);
  });
  onCleanup(() => {
    disposed = true;
  });
  const rows = createMemo(() => {
    revision();
    const result: { entry: Entry; depth: number }[] = [];
    const walk = (path: string, depth: number) => {
      for (const entry of cache.get(path) ?? []) {
        result.push({ entry, depth });
        if (entry.directory && open().has(entry.path)) walk(entry.path, depth + 1);
      }
    };
    walk(props.rootPath, 0);
    return result;
  });
  const toggle = (entry: Entry) => {
    if (!entry.directory) return;
    const closing = open().has(entry.path);
    setOpen((current) => {
      const next = new Set(current);
      if (closing) next.delete(entry.path);
      else next.add(entry.path);
      return next;
    });
    if (!closing && !cache.has(entry.path)) void load(entry.path);
  };
  return (
    <box id="project-directory" flexDirection="column" flexGrow={1} minHeight={0}>
      <text height={1} flexShrink={0} fg={ui.text}>
        <b>Project directory</b>
      </text>
      <text fg={ui.muted} height={1} flexShrink={0} wrapMode="none">
        Click folders to expand / collapse · /new creates a conversation
      </text>
      <scrollbox flexGrow={1} minHeight={0} scrollX={false} focused={false}>
        <text selectable fg={ui.muted}>
          {props.rootPath}
        </text>
        <Show
          when={revision() > 0}
          fallback={<text>{errors()[props.rootPath] ? "" : "Loading directory…"}</text>}
        >
          <Show when={rows().length} fallback={<text fg={ui.muted}>(empty directory)</text>}>
            <For each={rows()}>
              {({ entry, depth }) => (
                <box
                  height={1}
                  flexShrink={0}
                  onMouse={(event) => click(entry.path, event, () => toggle(entry))}
                >
                  <text
                    id={`directory-${relative(props.rootPath, entry.path)}`}
                    selectable={false}
                    wrapMode="none"
                    height={1}
                    fg={entry.directory ? ui.text : ui.secondary}
                  >
                    <span
                      style={{ fg: ui.muted }}
                    >{`${"  ".repeat(depth)}${entry.directory ? (open().has(entry.path) ? "▾ " : "▸ ") : "  "}`}</span>
                    {`${entry.name}${entry.directory ? "/" : entry.symlink ? " @" : ""}`}
                  </text>
                </box>
              )}
            </For>
          </Show>
        </Show>
        <For each={Object.entries(errors())}>
          {([path, error]) => <text fg={ui.error}>{`Cannot read ${path}: ${error}`}</text>}
        </For>
      </scrollbox>
    </box>
  );
}
