import { expect, test } from "bun:test";
import {
  binding,
  defaultShortcuts,
  matches,
  navigationShortcuts,
  shortcuts,
} from "../../apps/tui/src/shortcuts";
import { shortcutInput, shortcutNames } from "../../packages/shared/src/session-state";

test("all letter actions require exact modifier chords", () => {
  for (const shortcut of Object.values({ ...defaultShortcuts, ...navigationShortcuts })) {
    const key = binding(shortcut);
    expect(matches(key, shortcut)).toBe(true);
    expect(matches({ name: key.name }, shortcut)).toBe(false);
    expect(matches({ name: key.name, shift: true }, shortcut)).toBe(false);
    expect(matches({ ...key, shift: true }, shortcut)).toBe(false);
    expect(matches({ ...key, ctrl: !key.ctrl, meta: !key.meta }, shortcut)).toBe(false);
  }
});

test("shortcut overrides reject bare letters, Shift-only letters and fixed action collisions", () => {
  for (const action of shortcutNames) {
    for (const name of "abcdefghijklmnopqrstuvwxyz") {
      expect(shortcutInput.safeParse({ [action]: name }).success).toBe(false);
      expect(shortcutInput.safeParse({ [action]: `shift+${name}` }).success).toBe(false);
    }
    for (const shortcut of Object.values(navigationShortcuts))
      expect(shortcutInput.safeParse({ [action]: shortcut }).success).toBe(false);
  }
  expect(shortcutInput.safeParse({}).success).toBe(true);
  expect(shortcuts()).toEqual(defaultShortcuts);
  const overrides = { palette: "ctrl+o", sidebar: "ctrl+s", newline: "meta+return" };
  expect(shortcutInput.safeParse(overrides).success).toBe(true);
  expect(shortcuts(overrides)).toEqual({ ...defaultShortcuts, ...overrides });
});
