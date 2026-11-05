import type { ConversationEvent } from "@harnesshub/shared";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from "solid-js";
import { Markdown, type SourcePart, sourceParts, ToolContent } from "./rich-content";
import { matches, navigationShortcuts } from "./shortcuts";
import { SourceViewer } from "./source-viewer";
import {
  newViewState,
  object,
  pretty,
  type RowData,
  Transcript,
  type TranscriptRow,
  toolExpanded,
  type ViewState,
} from "./transcript";

export const HISTORY_PAGE_SIZE = 60;
function rowAccent(value: RowData) {
  if (value.waiting) return "#ffcc80";
  if (value.kind === "tool") {
    if (value.tool?.status === "failed") return "#ef9a9a";
    if (value.tool?.status === "completed") return "#4ade80";
    return "#80cbc4";
  }
  if (value.label === "Agent") return "#a5d6ff";
  if (value.label === "Public thinking") return "#8b949e";
  if (value.kind === "notice") return "#ffcc80";
  return "#80cbc4";
}

export function NativeEvents(props: {
  events?: ConversationEvent[];
  model?: Transcript;
  disabled: boolean;
  running?: boolean;
  followRequest?: number;
  view?: ViewState;
  onModalChange?: (open: boolean) => void;
}) {
  const model = props.model ?? new Transcript(),
    view = props.view ?? newViewState();
  const [manual, setManual] = createSignal(view.manual),
    [selected, setSelected] = createSignal(view.selected),
    [page, setPage] = createSignal(view.page);
  const [source, setSource] = createSignal<SourcePart[] | null>(null);
  let scroll: ScrollBoxRenderable | undefined;
  let restored = false;
  const rememberScroll = () => {
    if (!scroll || !restored) return;
    const bottom = scroll.scrollTop + scroll.viewport.height >= scroll.scrollHeight - 1;
    if (!bottom && page() === null) setPage(currentPage());
    else if (bottom && currentPage() === totalPages() - 1 && page() !== null) setPage(null);
  };
  createEffect(() => {
    const events = props.events;
    if (events) untrack(() => model.append(events.slice(model.events.length)));
  });
  const totalPages = () => Math.max(1, Math.ceil(model.size() / HISTORY_PAGE_SIZE));
  const currentPage = () => Math.min(page() ?? totalPages() - 1, totalPages() - 1);
  const visible = createMemo(() => {
    model.size();
    return model.rows.slice(
      currentPage() * HISTORY_PAGE_SIZE,
      (currentPage() + 1) * HISTORY_PAGE_SIZE,
    );
  });
  createEffect(() => {
    if (!model.size() || restored || !scroll) return;
    restored = true;
    scroll.afterLayout(() => {
      if (view.following && page() === null) scroll?.scrollTo(Infinity);
      else scroll?.scrollTo(view.scrollTop);
    });
  });
  onCleanup(() => {
    scroll?.verticalScrollBar.off("change", rememberScroll);
    view.manual = manual();
    view.selected = selected();
    view.page = page();
    if (scroll) {
      view.scrollTop = scroll.scrollTop;
      view.following = scroll.scrollTop + scroll.viewport.height >= scroll.scrollHeight - 1;
    }
  });
  const selectedIndex = () => {
    const start = currentPage() * HISTORY_PAGE_SIZE,
      end = Math.min(model.size(), start + HISTORY_PAGE_SIZE);
    return selected() >= start && selected() < end ? selected() : end - 1;
  };
  const selectedRow = () => model.rows[selectedIndex()];
  const reveal = (index: number) => {
    setSelected(index);
    const target = Math.floor(index / HISTORY_PAGE_SIZE);
    if (target !== currentPage()) setPage(target === totalPages() - 1 ? null : target);
    scroll?.scrollChildIntoView(`native-${model.rows[index]?.id}`, { align: "nearest" });
  };
  const toggle = (row: TranscriptRow) =>
    setManual((v) => ({
      ...v,
      [row.id]: !(row.value().kind === "tool" ? toolExpanded(v[row.id]) : (v[row.id] ?? false)),
    }));
  const close = () => {
    setSource(null);
    props.onModalChange?.(false);
  };
  const inspect = (raw: boolean) => {
    const row = selectedRow();
    if (!row) return;
    setSource(
      raw
        ? row.sources.map((event) => ({
            name: `#${event.seq} ${event.kind} · ${event.id}`,
            text: pretty({
              eventId: event.id,
              seq: event.seq,
              nativeSessionId: event.nativeSessionId,
              turnId: event.turnId,
              normalized: { kind: event.kind, payload: event.payload },
              raw: event.raw,
            }),
          }))
        : sourceParts(model.source(row), row.value().tool, row.value().terminals),
    );
    props.onModalChange?.(true);
  };
  const followLatest = () => {
    setPage(null);
    scroll?.afterLayout(() => scroll?.scrollTo(Infinity));
  };
  createEffect(() => {
    if (props.followRequest) followLatest();
  });
  useKeyboard((key) => {
    if (key.defaultPrevented || key.propagationStopped) return;
    if (source() || props.disabled) return;
    if (matches(key, navigationShortcuts.nextTool)) {
      const candidates = model.rows
        .map((r, i) => ({ r, i }))
        .filter(({ r }) => r.value().kind === "tool");
      const next = candidates.find(({ i }) => i > selectedIndex()) ?? candidates[0];
      if (next) reveal(next.i);
    }
    if (matches(key, "up") || matches(key, "down")) {
      key.preventDefault();
      key.stopPropagation();
      reveal(
        Math.max(0, Math.min(model.size() - 1, selectedIndex() + (key.name === "up" ? -1 : 1))),
      );
    }
    if (matches(key, "return") && selectedRow()) {
      key.preventDefault();
      key.stopPropagation();
      toggle(selectedRow() as TranscriptRow);
    }
    if (matches(key, navigationShortcuts.source)) inspect(true);
    if (matches(key, navigationShortcuts.copySource)) inspect(false);
    if ((key.ctrl || key.meta || key.shift) && !["pageup", "pagedown"].includes(key.name)) return;
    if (key.name === "pageup" || key.name === "pagedown") {
      key.preventDefault();
      if (key.ctrl) {
        const next = Math.max(
          0,
          Math.min(totalPages() - 1, currentPage() + (key.name === "pageup" ? -1 : 1)),
        );
        setPage(next === totalPages() - 1 ? null : next);
        setSelected(next * HISTORY_PAGE_SIZE);
        scroll?.scrollTo(key.name === "pageup" ? Infinity : 0);
      } else scroll?.scrollBy(key.name === "pageup" ? -0.8 : 0.8, "viewport");
    }
    if (key.name === "end" || key.name === "escape") {
      key.preventDefault();
      key.stopPropagation();
      followLatest();
      if (key.name === "end") setSelected(model.size() - 1);
    }
  });
  return (
    <box flexGrow={1} flexBasis={0} minHeight={3} flexDirection="column">
      <scrollbox
        id="native-history"
        ref={(el) => {
          scroll = el;
          el.verticalScrollBar.on("change", rememberScroll);
        }}
        flexGrow={1}
        flexBasis={0}
        minHeight={2}
        stickyScroll
        stickyStart="bottom"
        scrollAcceleration={{ tick: () => 5, reset() {} }}
        viewportCulling
      >
        <Show
          when={model.size()}
          fallback={<text>Start a conversation. Press Enter to write a message.</text>}
        >
          <For each={visible()}>
            {(row) => (
              <box
                id={`native-${row.id}`}
                flexDirection="row"
                flexShrink={0}
                marginBottom={1}
                backgroundColor={row.value().label === "You" ? "#2d2d30" : "transparent"}
                paddingX={row.value().label === "You" ? 1 : 0}
                paddingY={row.value().label === "You" ? 1 : 0}
              >
                <Show when={row.value().label !== "You"}>
                  <text width={2} flexShrink={0} fg={rowAccent(row.value())}>
                    {selectedRow()?.id === row.id ? "▶" : "•"}
                  </text>
                </Show>
                <box flexDirection="column" flexGrow={1} flexBasis={0} minWidth={0}>
                  <Show
                    when={row.value().kind === "tool"}
                    fallback={
                      <text>
                        <span
                          style={{
                            fg: row.value().label === "You" ? "#b7bdc8" : rowAccent(row.value()),
                            bold: true,
                          }}
                        >
                          {`${row.value().label === "You" && selectedRow()?.id === row.id ? "▶ " : ""}${row.value().label}`}
                        </span>
                      </text>
                    }
                  >
                    <box flexDirection="row" height={1} flexShrink={0}>
                      <text
                        flexGrow={1}
                        flexBasis={0}
                        minWidth={0}
                        height={1}
                        wrapMode="none"
                        truncate
                      >
                        <span style={{ fg: rowAccent(row.value()), bold: true }}>
                          {
                            String(
                              row.value().tool?.title ?? row.value().tool?.name ?? "Tool",
                            ).split(/\r?\n/, 1)[0]
                          }
                        </span>
                      </text>
                      <text fg={rowAccent(row.value())} flexShrink={0}>
                        {` · ${row.value().waiting ? "WAITING_APPROVAL" : (row.value().tool?.status ?? "pending")}`}
                      </text>
                    </box>
                  </Show>
                  <Show when={row.value().kind === "text"}>
                    <Markdown text={row.value().text} streaming={row.value().streaming} />
                  </Show>
                  <Show when={row.value().kind === "handoff"}>
                    <text fg="#80cbc4">
                      Enter expand/collapse · click Source for the complete report and events
                    </text>
                    <Show when={manual()[row.id] ?? row.value().waiting}>
                      <Markdown text={row.value().text.slice(0, 24000)} />
                    </Show>
                  </Show>
                  <Show when={row.value().kind === "tool"}>
                    <ToolContent
                      tool={row.value().tool ?? {}}
                      terminals={row.value().terminals}
                      expanded={toolExpanded(manual()[row.id])}
                    />
                  </Show>
                  <Show when={row.value().kind === "notice"}>
                    <text selectable fg="#ffcc80">
                      {manual()[row.id]
                        ? row.value().text.slice(0, 24000)
                        : row
                            .value()
                            .text.slice(0, 180)
                            .replace(/\s*\n\s*/g, " ") +
                          (row.value().text.length > 180 ? " … (Enter expands in transcript)" : "")}
                    </text>
                  </Show>
                  <Show when={row.value().kind === "plan"}>
                    <For
                      each={
                        Array.isArray(object(row.sources[0]?.payload).entries)
                          ? (object(row.sources[0]?.payload).entries as unknown[])
                          : []
                      }
                    >
                      {(entry) => (
                        <box flexDirection="column" flexShrink={0}>
                          <text fg="#80cbc4">{`[${String(object(entry).status ?? "")}] ${String(object(entry).priority ?? "")}`}</text>
                          <Markdown text={String(object(entry).content ?? "")} />
                        </box>
                      )}
                    </For>
                  </Show>
                </box>
              </box>
            )}
          </For>
        </Show>
      </scrollbox>
      <Show when={props.running}>
        <text fg="#80cbc4" height={1} flexShrink={0}>
          Agent is working…
        </text>
      </Show>
      <box flexDirection="row" height={1} flexShrink={0}>
        <text
          flexGrow={1}
          minWidth={0}
          truncate
          fg="#8b949e"
        >{`Chat · History ${currentPage() + 1}/${totalPages()} · ${model.size()} items · Ctrl+T transcript · ↑↓ select · Enter expand`}</text>
        <box
          id="transcript-expand"
          onMouse={(event) => {
            if (event.type !== "down" || event.button !== 0 || !selectedRow()) return;
            event.preventDefault();
            event.stopPropagation();
            toggle(selectedRow() as TranscriptRow);
          }}
        >
          <text selectable={false} fg="#8b949e">
            More / less{" "}
          </text>
        </box>
        <box
          id="transcript-source"
          onMouse={(event) => {
            if (event.type !== "down" || event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            inspect(false);
          }}
        >
          <text selectable={false} fg="#8b949e">
            Source{" "}
          </text>
        </box>
        <box
          id="transcript-raw"
          onMouse={(event) => {
            if (event.type !== "down" || event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            inspect(true);
          }}
        >
          <text selectable={false} fg="#8b949e">
            Raw
          </text>
        </box>
      </box>
      <Show when={source()}>{(parts) => <SourceViewer parts={parts()} onClose={close} />}</Show>
    </box>
  );
}
