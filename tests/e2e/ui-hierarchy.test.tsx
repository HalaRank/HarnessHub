import { expect, test } from "bun:test";
import { RGBA, TextAttributes } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { CommandPalette } from "../../apps/tui/src/command-palette";
import { SlashCommands } from "../../apps/tui/src/slash-commands";
import { chat, inputStyle, listStyle, ui } from "../../apps/tui/src/ui";

test("slash commands distinguish names, native hints and descriptions in both selection states", async () => {
  for (const width of [100, 35]) {
    for (const selected of [0, 1]) {
      const screen = await testRender(
        () => (
          <SlashCommands
            commands={[
              { name: "review", description: "原生审查说明", input: { hint: "[scope]" } },
              { name: "compact", description: "Native description" },
            ]}
            selected={selected}
            height={8}
            bottom={1}
            status=""
            choose={() => {}}
          />
        ),
        { width, height: 12 },
      );
      try {
        await screen.renderOnce();
        await screen.renderOnce();
        const lines = screen.captureSpans().lines;
        const spans = (text: string) =>
          lines.flatMap((line) => line.spans).filter((span) => span.text.includes(text));
        const name = spans("/review");
        expect(name.length).toBeGreaterThan(0);
        expect(
          name.every(
            (span) =>
              (span.attributes & TextAttributes.BOLD) !== 0 &&
              span.fg.equals(RGBA.fromHex(ui.text)),
          ),
        ).toBe(true);
        for (const text of ["[scope]", "原生审查说明"]) {
          const detail = spans(text);
          expect(detail.length).toBeGreaterThan(0);
          expect(
            detail.every(
              (span) =>
                (span.attributes & TextAttributes.BOLD) === 0 &&
                span.fg.equals(RGBA.fromHex(selected === 0 ? ui.secondary : ui.muted)),
            ),
          ).toBe(true);
        }
        const popup = screen.renderer.root.findDescendantById("slash-popup");
        expect(popup).toBeDefined();
        expect((popup?.x ?? 0) + (popup?.width ?? 0)).toBeLessThanOrEqual(width);
        expect(screen.captureCharFrame()).toContain("ACP commands");
        expect(screen.captureCharFrame()).toContain("↑↓ choose");
      } finally {
        await screen.dispose();
      }
    }
  }
});

test("palette keeps path search and empty results safe at narrow terminal sizes", async () => {
  for (const width of [100, 35]) {
    let executed = 0;
    const screen = await testRender(
      () => (
        <CommandPalette
          commands={[
            {
              id: "project",
              name: "Project · 示例",
              description: "/workspace/unique-path",
              run: () => executed++,
            },
          ]}
          onClose={() => {}}
        />
      ),
      { width, height: 16 },
    );
    try {
      await screen.renderOnce();
      await screen.mockInput.typeText("unique-path");
      await screen.renderOnce();
      expect(screen.captureCharFrame()).toContain("Project · 示例");
      await screen.mockInput.typeText("-missing");
      await screen.renderOnce();
      expect(screen.captureCharFrame()).toContain("No matching commands.");
      screen.mockInput.pressEnter();
      expect(executed).toBe(0);
      screen.mockInput.pressKey("a", { ctrl: true });
      screen.mockInput.pressKey("k", { ctrl: true });
      await screen.mockInput.typeText("unique-path");
      screen.mockInput.pressEnter();
      expect(executed).toBe(1);
    } finally {
      await screen.dispose();
    }
  }
});

test("chrome text, descriptions and placeholders meet normal-text contrast", () => {
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map((offset) => {
      const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return (channels[0] ?? 0) * 0.2126 + (channels[1] ?? 0) * 0.7152 + (channels[2] ?? 0) * 0.0722;
  };
  for (const [foreground, background] of [
    [ui.text, ui.panel],
    [ui.muted, ui.panel],
    [listStyle.selectedDescriptionColor, listStyle.selectedBackgroundColor],
    [inputStyle.placeholderColor, inputStyle.backgroundColor],
    [ui.accent, ui.selection],
    ...Object.entries(chat)
      .filter(([name]) => name !== "canvas" && name !== "user")
      .map(([, color]) => [color, chat.canvas]),
    [chat.text, chat.user],
    [chat.muted, chat.user],
  ]) {
    const values = [luminance(foreground ?? ""), luminance(background ?? "")].sort((a, b) => a - b);
    expect(((values[1] ?? 0) + 0.05) / ((values[0] ?? 0) + 0.05)).toBeGreaterThanOrEqual(4.5);
  }
});
