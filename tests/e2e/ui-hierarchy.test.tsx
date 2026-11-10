import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RGBA, TextAttributes } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { CommandPalette } from "../../apps/tui/src/command-palette";
import { SlashCommands } from "../../apps/tui/src/slash-commands";
import { chat, inputStyle, listStyle, ui } from "../../apps/tui/src/ui";
import { WorkspaceOverview } from "../../apps/tui/src/workspace-overview";
import type { Conversation } from "../../packages/shared/src/index";
import { clickControl } from "./ui-actions";

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

test("workspace overview adapts to resize, opens real directories and keeps actions behind modal ownership", async () => {
  const root = mkdtempSync(join(tmpdir(), "hhu-workspace-layout-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "index.ts"), "// directory fixture\n");
  writeFileSync(join(root, "README.md"), "Workspace fixture\n");
  const conversations: Conversation[] = Array.from({ length: 20 }, (_, index) => ({
    id: `conversation-${index}`,
    projectId: "project",
    title: index === 0 ? "优化工作区 · Workspace layout" : `Conversation ${index}`,
    archivedAt: index === 19 ? 1 : null,
    workspaceMode: "shared",
    selectedHarnessId: "codex",
    workspacePath: root,
    runtimeStatus: index === 0 ? "WAITING_APPROVAL" : "IDLE",
    createdAt: 0,
    updatedAt: 20 - index,
  }));
  for (const disabled of [false, true]) {
    const created: string[] = [];
    const selected: string[] = [];
    const screen = await testRender(
      () => (
        <WorkspaceOverview
          rootPath={root}
          conversations={conversations}
          disabled={disabled}
          onCreate={(mode) => created.push(mode)}
          onSelect={(c) => selected.push(c.id)}
        />
      ),
      { width: 120, height: 32 },
    );
    try {
      for (const [width, height] of [
        [120, 32],
        [70, 24],
        [35, 12],
        [120, 32],
      ] as const) {
        screen.resize(width, height);
        for (let i = 0; i < 5; i++) {
          await screen.renderOnce();
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const frame = screen.captureCharFrame();
        if (height >= 14) expect(frame).toContain("19 conversations");
        expect(frame).toContain("WAITING_APPROVAL");
        expect(frame).not.toContain("Conversation 19");
        const list = screen.renderer.root.findDescendantById("workspace-conversations");
        const directory = screen.renderer.root.findDescendantById("project-directory");
        expect(list).toBeDefined();
        expect(directory).toBeDefined();
        if (!directory || !list) throw new Error("Missing workspace panels");
        expect(directory.height).toBeGreaterThanOrEqual(3);
        expect(directory.y + directory.height).toBeLessThanOrEqual(height);
        if (width >= 92) expect(directory.x).toBeGreaterThan(list.x + list.width);
        else expect(directory.y).toBeGreaterThanOrEqual(list.y + list.height);
        for (const id of ["project-new-conversation", "project-new-worktree"]) {
          const button = screen.renderer.root.findDescendantById(id);
          if (!button) throw new Error(`Missing ${id}`);
          expect(button.x + button.width).toBeLessThanOrEqual(width);
          await clickControl(screen, id);
        }
        await clickControl(screen, "recent-conversation-0");
        if (!disabled) {
          writeFileSync(join(root, `overview-${width}.txt`), frame);
          writeFileSync(
            join(root, `overview-${width}.json`),
            JSON.stringify(screen.captureSpans()),
          );
        }
      }
      expect(created).toEqual(disabled ? [] : Array(4).fill(["shared", "worktree"]).flat());
      expect(selected).toEqual(disabled ? [] : Array(4).fill("conversation-0"));
      await clickControl(screen, "directory-src");
      for (let i = 0; i < 5; i++) {
        await screen.renderOnce();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(!!screen.renderer.root.findDescendantById("directory-src/index.ts")).toBe(!disabled);
    } finally {
      await screen.dispose();
    }
  }
  console.log(`Workspace layout evidence: ${root}`);
});
