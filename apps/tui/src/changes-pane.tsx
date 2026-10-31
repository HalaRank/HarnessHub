import type { GitChanges, GitPatch } from "@harnesshub/shared";
import { connect } from "@harnesshub/shared/client";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { UnifiedDiff } from "./rich-content";
import { SourceViewer } from "./source-viewer";

export function ChangesPane(props: {
  conversationId: string;
  disabled: boolean;
  onModalChange: (open: boolean) => void;
}) {
  const [state, setState] = createSignal<GitChanges | null>(null),
    [patch, setPatch] = createSignal<GitPatch | null>(null),
    [selected, setSelected] = createSignal(0),
    [error, setError] = createSignal(""),
    [busy, setBusy] = createSignal(false),
    [source, setSource] = createSignal(false);
  let alive = true,
    generation = 0,
    scroll: ScrollBoxRenderable | undefined;
  onCleanup(() => {
    alive = false;
    generation++;
  });
  const request = async <T,>(path: string) => {
    const client = await connect();
    if (!client) throw new Error("Daemon disconnected");
    return client.request<T>(`/v1/conversations/${props.conversationId}/changes${path}`);
  };
  const load = async (index: number) => {
    const path = state()?.files[index]?.path,
      token = ++generation;
    setPatch(null);
    setSelected(index);
    setError("");
    if (!path) return;
    setBusy(true);
    try {
      const result = await request<GitPatch>(`?path=${encodeURIComponent(path)}`);
      if (alive && token === generation) {
        setPatch(result);
        scroll?.scrollTo(0);
      }
    } catch (e) {
      if (alive && token === generation)
        setError(e instanceof Error ? e.message : "Git diff failed");
    } finally {
      if (alive && token === generation) setBusy(false);
    }
  };
  const refresh = async () => {
    const token = ++generation;
    setBusy(true);
    setError("");
    try {
      const result = await request<GitChanges>("");
      if (alive && token === generation) {
        setState(result);
        setPatch(null);
        setSelected(0);
        if (result.files.length) await load(0);
      }
    } catch (e) {
      if (alive && token === generation)
        setError(e instanceof Error ? e.message : "Git status failed");
    } finally {
      if (alive) setBusy(false);
    }
  };
  onMount(() => {
    void refresh();
  });
  const sections = () =>
    patch()
      ? [
          { name: "Staged", text: patch()?.staged ?? "" },
          { name: "Unstaged", text: patch()?.unstaged ?? "" },
          { name: "Untracked", text: patch()?.untracked ?? "" },
        ].filter((s) => s.text)
      : [];
  useKeyboard((key) => {
    if (props.disabled || source()) return;
    if (key.name === "g") void refresh();
    if (key.name === "up" || key.name === "down") {
      key.preventDefault();
      void load(
        Math.max(
          0,
          Math.min((state()?.files.length ?? 1) - 1, selected() + (key.name === "up" ? -1 : 1)),
        ),
      );
    }
    if (key.name === "pageup" || key.name === "pagedown") {
      key.preventDefault();
      scroll?.scrollBy(key.name === "pageup" ? -0.8 : 0.8, "viewport");
    }
    if (key.name === "y" && patch()) {
      setSource(true);
      props.onModalChange(true);
    }
  });
  return (
    <box flexGrow={1} flexDirection="column" gap={1}>
      <text fg="#ffcc80">
        Changes · Shared workspace · No Agent attribution · g refresh · y copy diff
      </text>
      <Show when={state()}>
        {(s) => (
          <>
            <text>{s().notice}</text>
            <text fg="#8b949e">{`Workspace: ${s().workspace} · Repository: ${s().repository ?? "none"}`}</text>
            <Show when={s().files.length} fallback={<text>No Git changes.</text>}>
              <select
                height={Math.min(6, s().files.length + 1)}
                focused={false}
                selectedIndex={selected()}
                showDescription={false}
                options={s().files.map((f) => ({
                  name: `${f.index}${f.worktree} ${f.path}${f.previousPath ? ` ← ${f.previousPath}` : ""}`,
                  description: "",
                  value: f,
                }))}
                onChange={(index) => void load(index)}
              />
            </Show>
          </>
        )}
      </Show>
      <Show when={busy()}>
        <text>Reading Git…</text>
      </Show>
      <Show when={error()}>
        <text fg="#ef9a9a">{error()}</text>
      </Show>
      <scrollbox
        ref={(el) => {
          scroll = el;
        }}
        flexGrow={1}
        viewportCulling
      >
        <For each={sections()}>
          {(section) => (
            <box flexDirection="column" flexShrink={0}>
              <text fg="#80cbc4">{section.name}</text>
              <UnifiedDiff value={section.text.slice(0, 96000)} path={patch()?.path ?? ""} />
              <Show when={section.text.length > 96000}>
                <text>
                  Diff preview limited to 96,000 characters. Press y for complete source pages /
                  copy.
                </text>
              </Show>
            </box>
          )}
        </For>
      </scrollbox>
      <Show when={source()}>
        <SourceViewer
          parts={sections()}
          onClose={() => {
            setSource(false);
            props.onModalChange(false);
          }}
        />
      </Show>
    </box>
  );
}
