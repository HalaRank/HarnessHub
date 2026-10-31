import { defaultShortcuts, type Shortcuts } from "@harnesshub/shared";

export { defaultShortcuts };
export function binding(value: string) {
  const parts = value.split("+");
  return {
    name: parts.at(-1) ?? "",
    ctrl: parts.includes("ctrl"),
    shift: parts.includes("shift"),
    meta: parts.includes("meta"),
  };
}
export function matches(
  key: { name: string; ctrl?: boolean; shift?: boolean; meta?: boolean },
  value: string,
) {
  const b = binding(value);
  return (
    key.name === b.name && !!key.ctrl === b.ctrl && !!key.shift === b.shift && !!key.meta === b.meta
  );
}
export function shortcuts(overrides: Shortcuts = {}) {
  return { ...defaultShortcuts, ...overrides };
}
