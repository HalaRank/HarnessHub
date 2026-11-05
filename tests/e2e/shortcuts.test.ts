import { expect, test } from "bun:test";
import {
  binding,
  defaultShortcuts,
  matches,
  navigationShortcuts,
  shortcuts,
} from "../../apps/tui/src/shortcuts";
import { shortcutInput, shortcutNames } from "../../packages/shared/src/session-state";

test("Codex CLI defaults reserve Esc interrupt, Ctrl+J newline and Ctrl+O response copy", () => {
  expect(navigationShortcuts.cancel).toBe("escape");
  expect(defaultShortcuts.newline).toBe("ctrl+j");
  expect(defaultShortcuts.copy).toBe("ctrl+o");
  expect(navigationShortcuts.conversation).toBe("n");
  expect(navigationShortcuts.standaloneConversation).toBe("ctrl+n");
  for (const [action, shortcut] of Object.entries(navigationShortcuts)) {
    if (!["cancel", "conversation", "standaloneConversation"].includes(action))
      expect(shortcut).toBe("");
  }
  for (const shortcut of Object.values({ ...defaultShortcuts, ...navigationShortcuts })) {
    if (!shortcut) {
      expect(matches({ name: "" }, shortcut)).toBe(false);
      continue;
    }
    const key = binding(shortcut);
    expect(matches(key, shortcut)).toBe(true);
    expect(matches({ ...key, shift: true }, shortcut)).toBe(false);
    expect(matches({ ...key, ctrl: !key.ctrl }, shortcut)).toBe(false);
  }
});

test("explicit shortcut overrides remain available, can be unbound and reject editor collisions", () => {
  for (const action of shortcutNames) {
    for (const name of "abcdefghijklmnopqrstuvwxyz") {
      expect(shortcutInput.safeParse({ [action]: name }).success).toBe(false);
      expect(shortcutInput.safeParse({ [action]: `shift+${name}` }).success).toBe(false);
    }
  }
  expect(shortcutInput.safeParse({}).success).toBe(true);
  expect(shortcutInput.safeParse({ palette: "ctrl+n" }).success).toBe(false);
  expect(shortcutInput.safeParse(defaultShortcuts).success).toBe(true);
  expect(shortcutInput.safeParse({ copy: "", palette: "" }).success).toBe(true);
  expect(shortcuts()).toEqual(defaultShortcuts);
  const overrides = { palette: "ctrl+s", sidebar: "ctrl+v", newline: "meta+return" };
  expect(shortcutInput.safeParse(overrides).success).toBe(true);
  expect(shortcuts(overrides)).toEqual({ ...defaultShortcuts, ...overrides });
});
