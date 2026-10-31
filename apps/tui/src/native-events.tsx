import type { ConversationEvent } from "@harnesshub/shared";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from "solid-js";
import { Markdown, type SourcePart, sourceParts, ToolContent } from "./rich-content";
import { SourceViewer } from "./source-viewer";
import {
  newViewState,
  object,
  pretty,
  Transcript,
  type TranscriptRow,
  toolExpanded,
  type ViewState,
} from "./transcript";

export const HISTORY_PAGE_SIZE = 60;
export function NativeEvents(props: {
  events?: ConversationEvent[];
  model?: Transcript;
  disabled: boolean;
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
      [row.id]: !(row.value().kind === "tool"
        ? toolExpanded(row.value(), v[row.id])
        : (v[row.id] ?? false)),
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
  useKeyboard((key) => {
    if (source() || props.disabled) return;
    if (key.name === "t") {
      const candidates = model.rows
        .map((r, i) => ({ r, i }))
        .filter(({ r }) => r.value().kind === "tool");
      const next = candidates.find(({ i }) => i > selectedIndex()) ?? candidates[0];
      if (next) reveal(next.i);
    }
    if (key.name === "[" || key.name === "]")
      reveal(
        Math.max(0, Math.min(model.size() - 1, selectedIndex() + (key.name === "[" ? -1 : 1))),
      );
    if (key.name === "e" && selectedRow()) toggle(selectedRow() as TranscriptRow);
    if (key.name === "r") inspect(true);
    if (key.name === "y") inspect(false);
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
    if (key.name === "end") {
      key.preventDefault();
      setPage(null);
      scroll?.scrollTo(Infinity);
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
        viewportCulling
      >
        <Show
          when={model.size()}
          fallback={<text>No Agent output yet. Press m to send a message.</text>}
        >
          <For each={visible()}>
            {(row) => (
              <box id={`native-${row.id}`} flexDirection="column" flexShrink={0} marginBottom={1}>
                <text
                  fg={row.value().label === "You" ? "#80cbc4" : "#8b949e"}
                >{`${selectedRow()?.id === row.id ? "▶ " : ""}${row.value().kind === "tool" ? (row.value().tool?.title ?? row.value().tool?.toolCallId) : row.value().label} · #${row.sources[0]?.seq}`}</text>
                <Show when={row.value().kind === "text"}>
                  <Markdown text={row.value().text} streaming={row.value().streaming} />
                </Show>
                <Show when={row.value().kind === "handoff"}>
                  <text fg="#80cbc4">e expand/collapse · y complete report · r source events</text>
                  <Show when={manual()[row.id] ?? row.value().waiting}>
                    <Markdown text={row.value().text.slice(0, 24000)} />
                  </Show>
                </Show>
                <Show when={row.value().kind === "tool"}>
                  <box flexDirection="column" border borderColor="#36404b" paddingX={1}>
                    <text>{`${row.value().waiting ? "WAITING_APPROVAL · " : ""}${row.value().tool?.status ?? "pending"} · e expand/collapse`}</text>
                    <Show when={toolExpanded(row.value(), manual()[row.id])}>
                      <ToolContent
                        tool={row.value().tool ?? {}}
                        terminals={row.value().terminals}
                      />
                    </Show>
                  </box>
                </Show>
                <Show when={row.value().kind === "raw"}>
                  <Show
                    when={
                      row.value().label === "plan" &&
                      Array.isArray(object(row.sources[0]?.payload).entries)
                    }
                    fallback={
                      <text selectable fg="#a0aab4">
                        {manual()[row.id]
                          ? row.value().text.slice(0, 24000)
                          : row.value().text.slice(0, 180) +
                            (row.value().text.length > 180 ? " … (r: full raw details)" : "")}
                      </text>
                    }
                  >
                    <For each={object(row.sources[0]?.payload).entries as unknown[]}>
                      {(raw) => (
                        <box flexDirection="column" flexShrink={0}>
                          <text fg="#80cbc4">{`[${String(object(raw).status ?? "")}] ${String(object(raw).priority ?? "")}`}</text>
                          <Markdown text={String(object(raw).content ?? "")} />
                        </box>
                      )}
                    </For>
                  </Show>
                </Show>
              </box>
            )}
          </For>
        </Show>
      </scrollbox>
      <text
        flexShrink={0}
        height={1}
        fg="#8b949e"
      >{`History ${currentPage() + 1}/${totalPages()} · ${model.size()} items · [/] select · r details · y copy · PgUp/PgDn scroll · End follow`}</text>
      <Show when={source()}>{(parts) => <SourceViewer parts={parts()} onClose={close} />}</Show>
    </box>
  );
}
