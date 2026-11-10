import type { TextareaRenderable, TextRenderable } from "@opentui/core";
import type { testRender } from "@opentui/solid";

type Screen = Awaited<ReturnType<typeof testRender>>;
export async function waitHeading(screen: Screen, title: string) {
  for (let count = 0; count < 200; count++) {
    await screen.renderOnce();
    const heading = screen.renderer.root.findDescendantById("workspace-heading") as
      | TextRenderable
      | undefined;
    if (heading?.plainText === title) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Missing conversation heading ${title}:\n${screen.captureCharFrame()}`);
}
export async function clickControl(screen: Screen, id: string) {
  await screen.renderOnce();
  const control = screen.renderer.root.findDescendantById(id);
  if (!control) throw new Error(`Missing UI control ${id}`);
  await screen.mockMouse.click(control.x, control.y);
  await screen.renderOnce();
}
export async function openCommands(screen: Screen) {
  await screen.renderOnce();
  if (screen.captureCharFrame().includes("Command palette")) {
    screen.mockInput.pressEscape();
    await screen.renderOnce();
    return;
  }
  await clickControl(screen, "commands-button");
  for (let count = 0; count < 30; count++) {
    await screen.renderOnce();
    if (screen.captureCharFrame().includes("Command palette")) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Command palette did not open");
}
export async function invoke(screen: Screen, command: string) {
  await openCommands(screen);
  await screen.mockInput.typeText(command);
  await screen.renderOnce();
  screen.mockInput.pressEnter();
  await screen.renderOnce();
  await new Promise((resolve) => setTimeout(resolve, 80));
  await screen.renderOnce();
}
export async function focusMessage(screen: Screen) {
  const editor = screen.renderer.root.findDescendantById("message-draft") as
    | TextareaRenderable
    | undefined;
  if (editor?.focused) return;
  await invoke(screen, "Write Message");
  for (let count = 0; count < 200; count++) {
    await screen.renderOnce();
    const current = screen.renderer.root.findDescendantById("message-draft") as
      | TextareaRenderable
      | undefined;
    if (current?.focused) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Message editor did not acquire focus");
}
export async function navigate(screen: Screen) {
  if (screen.renderer.currentFocusedEditor?.id === "message-draft") {
    screen.mockInput.pressKey("t", { ctrl: true });
    await screen.renderOnce();
    screen.mockInput.pressEscape();
    await screen.renderOnce();
  }
}
export async function selectLastRow(screen: Screen) {
  if (screen.renderer.root.findDescendantById("message-draft")) {
    screen.mockInput.pressKey("t", { ctrl: true });
    await screen.renderOnce();
  }
  screen.mockInput.pressKey("END");
  await screen.renderOnce();
}
