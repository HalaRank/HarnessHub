import type { BoxOptions } from "@opentui/core";
import { For, type JSX, Show } from "solid-js";

// Terminal chrome shares a restrained palette. Native transcript styling is independent.
export const ui = {
  canvas: "#10151c",
  panel: "#18212b",
  input: "#1c2733",
  hover: "#233342",
  selection: "#294456",
  border: "#3b4b5b",
  text: "#edf2f7",
  secondary: "#b8c4d0",
  muted: "#94a4b5",
  accent: "#80cbc4",
  project: "#b2dfdb",
  warning: "#ffcc80",
  error: "#ff9c9c",
  danger: "#632b30",
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
  return (
    <text selectable={false} height={1} flexShrink={0} wrapMode="none" fg={ui.muted}>
      <For each={props.items.filter(([key]) => key.length > 0)}>
        {([key, label], index) => (
          <>
            {index() ? "   " : ""}
            <span style={{ fg: ui.secondary }}>{key}</span> {label}
          </>
        )}
      </For>
    </text>
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
