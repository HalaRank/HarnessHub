import { createSignal } from "solid-js";
import { mouseClick } from "./project-tree";
import { ui } from "./ui";

export function ActionButton(props: {
  id: string;
  label: string;
  hint?: string;
  primary?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const click = mouseClick();
  const [hovered, setHovered] = createSignal(false);
  return (
    <box
      id={props.id}
      height={1}
      flexShrink={0}
      paddingX={1}
      backgroundColor={
        hovered() && !props.disabled ? ui.hover : props.primary ? ui.selection : ui.panel
      }
      onMouse={(event) => {
        if (event.type === "over") setHovered(true);
        if (event.type === "out") setHovered(false);
        click(props.id, event, () => {
          if (!props.disabled) props.onPress();
        });
      }}
    >
      <text
        selectable={false}
        height={1}
        wrapMode="none"
        fg={props.disabled ? ui.muted : props.primary ? ui.accent : ui.text}
      >
        <b>{props.label}</b>
        {props.hint ? <span style={{ fg: ui.muted }}>{`  ${props.hint}`}</span> : null}
      </text>
    </box>
  );
}
