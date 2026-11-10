import type { BoxOptions } from "@opentui/core";
import { createMemo, createSignal, For, type JSX, Show } from "solid-js";

// Terminal chrome shares a restrained palette. Native transcript styling is independent.
export const ui = {
  canvas: "#14181d",
  panel: "#1b222a",
  input: "#202931",
  hover: "#233342",
  selection: "#294456",
  border: "#394651",
  text: "#edf2f7",
  secondary: "#b8c4d0",
  muted: "#94a4b5",
  accent: "#80cbc4",
  project: "#b2dfdb",
  warning: "#ffcc80",
  error: "#ff9c9c",
  danger: "#632b30",
};

export const chat = {
  canvas: "#181a1b",
  user: "#2d2d30",
  text: "#d4d4d8",
  heading: "#e1e4e5",
  muted: "#979a9b",
  command: "#75baff",
  option: "#e9a1a8",
  string: "#b7dc88",
  operator: "#8dd5df",
  success: "#40cf92",
  error: "#ff8c8c",
  warning: "#e8bd79",
};

export const listStyle = {
  backgroundColor: ui.panel,
  focusedBackgroundColor: ui.panel,
  textColor: ui.text,
  focusedTextColor: ui.text,
  selectedBackgroundColor: ui.selection,
  selectedTextColor: ui.text,
  descriptionColor: ui.muted,
  selectedDescriptionColor: ui.secondary,
};

export const inputStyle = {
  backgroundColor: ui.input,
  focusedBackgroundColor: ui.input,
  textColor: ui.text,
  focusedTextColor: ui.text,
  placeholderColor: ui.muted,
};

export function KeyHints(props: { items: [string, string][] }) {
  const [width, setWidth] = createSignal(0);
  const visible = createMemo(() => {
    let used = 0;
    return props.items.filter(([key, label]) => {
      if (!key) return false;
      const size = Bun.stringWidth(`${key} ${label}`) + (used ? 3 : 0);
      if (width() && used + size > width()) return false;
      used += size;
      return true;
    });
  });
  return (
    <box
      height={1}
      width="100%"
      flexShrink={0}
      ref={(element) => {
        element.onSizeChange = () => setWidth(element.width);
      }}
    >
      <text selectable={false} height={1} wrapMode="none" fg={ui.muted}>
        <For each={visible()}>
          {([key, label], index) => (
            <>
              {index() ? "   " : ""}
              <span style={{ fg: ui.secondary }}>
                <b>{key}</b>
              </span>{" "}
              {label}
            </>
          )}
        </For>
      </text>
    </box>
  );
}

export function Panel(props: {
  title: string;
  hint?: string;
  height?: BoxOptions["height"];
  width?: BoxOptions["width"];
  children: JSX.Element;
}) {
  return (
    <box
      position="absolute"
      top={1}
      left={1}
      width={props.width ?? "96%"}
      {...(props.height ? { height: props.height } : {})}
      maxHeight="94%"
      border
      borderStyle="rounded"
      borderColor={ui.border}
      backgroundColor={ui.panel}
      paddingX={1}
      flexDirection="column"
      zIndex={30}
    >
      <text height={1} flexShrink={0} fg={ui.text} wrapMode="none">
        <b>{props.title}</b>
      </text>
      <Show when={props.hint}>
        <text fg={ui.muted} flexShrink={0}>
          {props.hint}
        </text>
      </Show>
      {props.children}
    </box>
  );
}

export function statusColor(status: string) {
  if (["ERROR", "UNCERTAIN", "INTERRUPTED", "Disconnected"].includes(status)) return ui.error;
  if (["WAITING_APPROVAL", "HANDOFF", "CANCELLING", "PREPARING"].includes(status))
    return ui.warning;
  if (status === "RUNNING" || status === "Connected") return ui.accent;
  return ui.muted;
}
