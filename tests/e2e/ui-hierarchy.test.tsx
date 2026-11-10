import { expect, test } from "bun:test";
import { type BoxRenderable, RGBA, TextAttributes } from "@opentui/core";
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

test("command menu groups actions, stays bounded on resize, and preserves exact execution targets", async () => {
  const { mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { clickControl } = await import("./ui-actions");
  const { createSignal } = await import("solid-js");
  const evidence = mkdtempSync(join(tmpdir(), "hhu-command-ui-"));
  mkdirSync(join(evidence, "frames"));
  const executed: string[] = [];
  let closed = 0;
  const commands: import("../../apps/tui/src/command-palette").Command[] = [
    {
      id: "project-a",
      name: "Project · HarnessHub",
      group: "Projects",
      description: "/workspace/HarnessHub",
      run: () => executed.push("project"),
    },
    {
      id: "new",
      name: "New Conversation",
      group: "Workspace",
      shortcut: "N",
      description: "Use the selected project's shared workspace",
      run: () => executed.push("new"),
    },
    {
      id: "message",
      name: "Write Message",
      group: "Conversation",
      shortcut: "Enter",
      description: "Focus the message editor",
      run: () => executed.push("message"),
    },
    {
      id: "delete",
      name: "Delete Conversation…",
      group: "Conversation",
      danger: true,
      description: "Review and confirm deletion of application history",
      run: () => executed.push("delete"),
    },
    ...Array.from({ length: 35 }, (_, i) => ({
      id: `conversation-${i}`,
      name: `Conversation · HarnessHub / 对话 ${i}`,
      group: "Conversations" as const,
      description: `/workspace/HarnessHub/feature-${i}`,
      run: () => executed.push(`conversation-${i}`),
    })),
    {
      id: "quit",
      name: "Quit TUI",
      group: "Interface",
      description: "Keep Daemon and Agents running",
      run: () => executed.push("quit"),
    },
  ];
  const [items, setItems] = createSignal(commands);
  const screen = await testRender(
    () => <CommandPalette commands={items()} onClose={() => closed++} />,
    { width: 150, height: 40 },
  );
  try {
    for (const [width, height] of [
      [150, 40],
      [80, 24],
      [35, 12],
      [150, 40],
    ] as const) {
      screen.resize(width, height);
      for (let i = 0; i < 4; i++) await screen.renderOnce();
      const panel = screen.renderer.root.findDescendantById("command-palette");
      const search = screen.renderer.root.findDescendantById("command-search");
      const results = screen.renderer.root.findDescendantById("command-results");
      if (!panel || !search || !results) throw new Error("Missing command menu controls");
      expect(panel.width).toBeLessThanOrEqual(88);
      expect(panel.x + panel.width).toBeLessThanOrEqual(width);
      expect(panel.y + panel.height).toBeLessThanOrEqual(height);
      expect(Math.abs(panel.x - (width - panel.width) / 2)).toBeLessThanOrEqual(1);
      expect(search.x + search.width).toBeLessThan(panel.x + panel.width);
      expect(results.height).toBeGreaterThanOrEqual(2);
      expect(screen.captureCharFrame()).toContain("Write Message");
      expect(screen.captureCharFrame()).toContain("↑↓ choose");
      writeFileSync(join(evidence, "frames", `commands-${width}.txt`), screen.captureCharFrame());
      writeFileSync(
        join(evidence, "frames", `commands-${width}.json`),
        JSON.stringify(screen.captureSpans()),
      );
    }
    const initial = screen.captureCharFrame();
    expect(initial.indexOf("Write Message")).toBeLessThan(initial.indexOf("New Conversation"));
    expect(initial).toContain("Enter");
    // Navigation skips section headings and the same selected ID survives metadata replacement.
    screen.mockInput.pressArrow("down");
    await screen.renderOnce();
    setItems(commands.filter((c) => c.id !== "message").map((c) => ({ ...c })));
    await screen.renderOnce();
    expect(
      (
        screen.renderer.root.findDescendantById("command-option-delete") as BoxRenderable
      )?.backgroundColor.equals(RGBA.fromHex(ui.selection)),
    ).toBe(true);
    screen.mockInput.pressEnter();
    expect(executed).toEqual(["delete"]);
    expect(closed).toBe(1);
    // Search is case insensitive, token-based and can combine name with path.
    await screen.mockInput.typeText("/FEATURE-34 对话");
    for (let i = 0; i < 3; i++) await screen.renderOnce();
    expect(screen.captureCharFrame()).toContain("1 / 1");
    expect(screen.captureCharFrame()).toContain("对话 34");
    await clickControl(screen, "command-option-conversation-34");
    expect(executed).toEqual(["delete", "conversation-34"]);
    expect(closed).toBe(2);
    screen.mockInput.pressKey("a", { ctrl: true });
    screen.mockInput.pressKey("k", { ctrl: true });
    for (let i = 0; i < 15; i++) screen.mockInput.pressKey("\x1b[6~");
    for (let i = 0; i < 4; i++) await screen.renderOnce();
    expect(screen.captureCharFrame()).toContain("Quit TUI");
    screen.mockInput.pressEnter();
    expect(executed.at(-1)).toBe("quit");
    expect(closed).toBe(3);
    screen.mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 40));
    await screen.renderOnce();
    expect(closed).toBe(4);
  } finally {
    await screen.dispose();
  }
  console.log(`Command menu evidence: ${evidence}`);
});

test("shared dialogs fit their containing conversation pane with the sidebar open", async () => {
  const { Panel } = await import("../../apps/tui/src/ui");
  const screen = await testRender(
    () => (
      <box flexDirection="row" width="100%" height="100%">
        <box width={34} flexShrink={0}>
          <text>Projects → Conversations</text>
        </box>
        <box id="dialog-host" flexGrow={1} minWidth={0} height="100%">
          <Panel id="nested-dialog" title="ACP settings" height="80%">
            <text>Native session options</text>
          </Panel>
        </box>
      </box>
    ),
    { width: 150, height: 35 },
  );
  try {
    for (const width of [150, 100, 70, 150]) {
      screen.resize(width, 35);
      for (let i = 0; i < 8; i++) await screen.renderOnce();
      const host = screen.renderer.root.findDescendantById("dialog-host");
      const dialog = screen.renderer.root.findDescendantById("nested-dialog");
      if (!host || !dialog) throw new Error("Missing nested dialog");
      expect(dialog.x).toBeGreaterThanOrEqual(host.x);
      expect(dialog.x + dialog.width).toBeLessThanOrEqual(host.x + host.width);
      expect(dialog.y + dialog.height).toBeLessThanOrEqual(host.y + host.height);
      expect(dialog.width).toBeLessThanOrEqual(96);
    }
  } finally {
    await screen.dispose();
  }
});
