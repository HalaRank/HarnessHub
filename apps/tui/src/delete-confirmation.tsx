import { useKeyboard } from "@opentui/solid";
import { createSignal, type JSX } from "solid-js";
import { mouseClick } from "./project-tree";
import { matches } from "./shortcuts";
import { Panel, ui } from "./ui";

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
    } else if (matches(key, "delete")) {
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
    <Panel
      title={`Confirm ${props.kind} deletion`}
      hint="Review the application data being deleted. Esc cancels."
    >
      {props.children}
      <text fg={ui.secondary}>
        This cannot be undone. Project files, Worktrees and Git branches are preserved.
      </text>
      <box flexDirection="row" gap={2}>
        <box
          id="delete-cancel"
          backgroundColor={!confirm() ? ui.border : ui.canvas}
          paddingX={1}
          onMouse={(event) => {
            if (!props.busy) click("cancel", event, props.onCancel);
          }}
        >
          <text selectable={false}>{!confirm() ? "› Cancel" : "  Cancel"}</text>
        </box>
        <box
          id="delete-confirm"
          backgroundColor={confirm() ? ui.danger : ui.canvas}
          paddingX={1}
          onMouse={(event) => {
            if (!props.busy) click("delete", event, props.onDelete);
          }}
        >
          <text selectable={false} fg={ui.error}>
            {props.busy ? "Deleting…" : confirm() ? "› Delete" : "  Delete"}
          </text>
        </box>
      </box>
      <text fg={ui.muted}>Delete to delete · Tab / ← → choose · Enter confirm · Esc cancel</text>
    </Panel>
  );
}
