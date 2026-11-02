import { useKeyboard } from "@opentui/solid";
import { createSignal, type JSX } from "solid-js";
import { mouseClick } from "./project-tree";

export function DeleteConfirmation(props: {
  kind: "Project" | "Conversation";
  busy: boolean;
  children: JSX.Element;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const [confirm, setConfirm] = createSignal(false);
  const click = mouseClick();
  useKeyboard((key) => {
    if (key.defaultPrevented || key.propagationStopped) return;
    if (props.busy) return;
    if (["tab", "left", "right", "up", "down"].includes(key.name)) {
      key.preventDefault();
      key.stopPropagation();
      setConfirm((value) => !value);
    } else if (key.name === "delete") {
      key.preventDefault();
      key.stopPropagation();
      props.onDelete();
    } else if (key.name === "return") {
      key.preventDefault();
      key.stopPropagation();
      if (confirm()) props.onDelete();
      else props.onCancel();
    }
  });
  return (
    <box
      position="absolute"
      top={3}
      left={3}
      width="88%"
      border
      backgroundColor="#10151c"
      padding={1}
      gap={1}
      flexDirection="column"
      title={`Confirm ${props.kind} deletion · Esc cancel`}
    >
      {props.children}
      <text>This cannot be undone. Project files, Worktrees and Git branches are preserved.</text>
      <box flexDirection="row" gap={2}>
        <box
          id="delete-cancel"
          backgroundColor={!confirm() ? "#36404b" : "#10151c"}
          paddingX={1}
          onMouse={(event) => {
            if (!props.busy) click("cancel", event, props.onCancel);
          }}
        >
          <text selectable={false}>{!confirm() ? "› Cancel" : "  Cancel"}</text>
        </box>
        <box
          id="delete-confirm"
          backgroundColor={confirm() ? "#632b30" : "#10151c"}
          paddingX={1}
          onMouse={(event) => {
            if (!props.busy) click("delete", event, props.onDelete);
          }}
        >
          <text selectable={false} fg="#ff8b8b">
            {props.busy ? "Deleting…" : confirm() ? "› Delete" : "  Delete"}
          </text>
        </box>
      </box>
      <text fg="#8b949e">Delete to delete · Tab / ← → choose · Enter confirm · Esc cancel</text>
    </box>
  );
}
