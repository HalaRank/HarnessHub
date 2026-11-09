import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Conversation, Handoff } from "@harnesshub/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { workspaceFolder } from "../../../packages/core/src/workspace-location";
import { type DesktopApi, desktopRequest } from "../src/contracts";
import { explorerFolder } from "../src/main/navigation";
import { gitStatus } from "../src/renderer/Changes";
import { slashIntent } from "../src/renderer/Composer";
import { diffBlocks, NativeDiff, UnifiedDiff } from "../src/renderer/Diff";
import { Handoffs } from "../src/renderer/Handoffs";
import { DesktopTranscript } from "../src/renderer/history";

const api = {
  request: async () => {
    throw new Error("render only");
  },
} as unknown as DesktopApi;
const id = "7ad657ec-2001-405b-801a-3d86b092f1b0";
test("unpublished /path and ordinary slash-prefix text require explicit plain text confirmation", () => {
  for (const value of [
    "/path",
    "/home/me/project",
    "/unknown args",
    "/this is ordinary text",
    "// a comment",
  ]) {
    expect(slashIntent(value, []).confirmText).toBe(true);
    expect(slashIntent(value, undefined).confirmText).toBe(true);
  }
  expect(slashIntent("/published arg", [{ name: "published", description: "native" }])).toEqual({
    name: "published",
    confirmText: false,
  });
  for (const value of ["ordinary /path", "hello", "/"])
    expect(slashIntent(value, []).confirmText).toBe(false);
});
test("controlled navigation rejects arbitrary paths, force, missing confirmation and extra IPC fields", () => {
  for (const input of [
    { type: "workspace.open", conversationId: id, path: "/etc" },
    { type: "workspace.open", conversationId: id, location: { kind: "workspace", path: "/etc" } },
    {
      type: "workspace.open",
      conversationId: id,
      location: { kind: "tool", seq: -1, collection: "content", index: 0 },
    },
    { type: "worktrees.cleanup", worktreeId: id, confirmed: false },
    { type: "worktrees.cleanup", worktreeId: id, confirmed: true, force: true },
  ])
    expect(desktopRequest.safeParse(input).success).toBe(false);
  expect(
    desktopRequest.safeParse({
      type: "workspace.open",
      conversationId: id,
      location: { kind: "workspace" },
    }).success,
  ).toBe(true);
});
test("WSL UNC conversion preserves spaces, unicode and literal shell characters, rejects ambiguous Windows names", () => {
  expect(explorerFolder("测试 Ubuntu", "/home/a b/项目 & $(literal)#%")).toBe(
    "\\\\wsl.localhost\\测试 Ubuntu\\home\\a b\\项目 & $(literal)#%",
  );
  for (const path of [
    "/a/../b",
    "/a/./b",
    "/a\\..\\b",
    "C:\\Windows",
    "//host/share",
    "/a:stream",
    "/a\n",
    "/trailing.",
    "/trailing ",
    "/double//slash",
  ])
    expect(() => explorerFolder("Ubuntu", path)).toThrow();
  for (const distro of ["../bad", "bad\\host", "bad\n", ""])
    expect(() => explorerFolder(distro, "/home")).toThrow();
});
test("WSL realpath boundary rejects tool traversal and symlink escape, locates deleted files safely", async () => {
  const root = mkdtempSync(join(tmpdir(), "hhu-nav-"));
  const workspace = join(root, "项目 space & $");
  mkdirSync(workspace);
  const nested = join(workspace, "nested");
  mkdirSync(nested);
  writeFileSync(join(nested, "file.ts"), "text");
  symlinkSync(root, join(workspace, "escape"));
  expect(await workspaceFolder(workspace, join(nested, "file.ts"))).toEqual({ linuxPath: nested });
  expect(await workspaceFolder(workspace, join(nested, "deleted.ts"))).toEqual({
    linuxPath: nested,
  });
  await expect(workspaceFolder(workspace, "../outside")).rejects.toThrow();
  await expect(workspaceFolder(workspace, join(workspace, "escape"))).rejects.toThrow();
});
test("Git status labels and source separation preserve native old/new text", () => {
  expect(
    ["A ", " M", " D", "??"].map((s) =>
      gitStatus({ path: "a", index: s[0] ?? "", worktree: s[1] ?? "" }),
    ),
  ).toEqual(["Added", "Modified", "Deleted", "Untracked"]);
  const native = renderToStaticMarkup(
    <NativeDiff
      api={api}
      content={{ path: "/repo/a.ts", oldText: "const before = 1", newText: "const after = 2" }}
    />,
  );
  expect(native).toContain("原生 ACP Diff（Agent 提供）");
  expect(native).not.toContain("Workspace Git Diff");
  expect(native).toContain("oldText");
  expect(native).toContain("newText");
});
test("large multi-hunk and single-hunk diffs have bounded highlighted DOM", () => {
  const text =
    "diff --git a/a.ts b/a.ts\n" +
    Array.from(
      { length: 400 },
      (_, i) => `@@ -${i},1 +${i},1 @@\n-const a = 1;\n+const a = 2;`,
    ).join("\n");
  expect(diffBlocks(text)).toHaveLength(401);
  const html = renderToStaticMarkup(
    <UnifiedDiff api={api} path="a.ts" source="Workspace Git Diff" text={text} />,
  );
  expect((html.match(/class="diff-block"/g) ?? []).length).toBe(30);
  expect(html).toContain("hljs-keyword");
  expect(html).toContain("下一组块");
  const huge = renderToStaticMarkup(
    <UnifiedDiff
      api={api}
      path="a.ts"
      source="Workspace Git Diff"
      text={`@@ -0,0 +1,50000 @@\n${"+const a = 1;\n".repeat(50000)}`}
    />,
  );
  expect((huge.match(/class="diff-line /g) ?? []).length).toBe(200);
  expect(huge.length).toBeLessThan(100000);
  expect(huge).toContain("下一页行");
});
test("handoff roundtrip reports and real states are traceable, UNCERTAIN has no replay action", () => {
  const conversation = { id, selectedHarnessId: "codex", runtimeStatus: "IDLE" } as Conversation;
  const base = {
    conversationId: id,
    sourceNativeSessionId: "codex-1",
    targetNativeSessionId: "grok-1",
    sourceEventStart: 1,
    sourceEventEnd: 9,
    reportText: "## Source report",
    fallbackText: "Fallback 原始历史",
    fallbackSources: { eventIds: ["e1"] },
    status: "COMMITTED",
    updatedAt: 1,
  } as Handoff;
  const handoffs = [
    { ...base, id: "h1", sourceHarness: "codex", targetHarness: "grok" },
    {
      ...base,
      id: "h2",
      sourceHarness: "grok",
      targetHarness: "codex",
      sourceNativeSessionId: "grok-1",
      targetNativeSessionId: "codex-2",
    },
  ];
  const html = renderToStaticMarkup(
    <Handoffs api={api} conversation={conversation} handoffs={handoffs} sessions={[]} connected />,
  );
  expect(html).toContain("codex → grok");
  expect(html).toContain("grok → codex");
  expect(html).toContain("codex-2");
  expect(html).toContain("#1 → #9");
  for (const status of ["GENERATING", "READY", "DELIVERING", "FAILED", "UNCERTAIN"] as const) {
    const markup = renderToStaticMarkup(
      <Handoffs
        api={api}
        conversation={conversation}
        handoffs={[{ ...base, id: "h1", status }]}
        sessions={[]}
        connected
      />,
    );
    expect(markup).toContain(status);
    expect(markup.includes("重试报告")).toBe(status === "FAILED");
    expect(markup.includes("检查并确认降级")).toBe(status === "FAILED");
    expect(markup.includes(">取消交接</button>")).toBe(status === "FAILED");
  }
});
test("native tool location provenance survives content-only and status-only updates", () => {
  const t = new DesktopTranscript();
  const e = (seq: number, payload: unknown) => ({
    id: String(seq),
    seq,
    kind: "tool_call",
    payload,
    raw: null,
    conversationId: id,
    nativeSessionId: "session",
    turnId: "turn",
    origin: "agent" as const,
    createdAt: 0,
  });
  t.append([
    e(1, { toolCallId: "tool", locations: [{ path: "/repo/a" }] }),
    e(2, { toolCallId: "tool", content: [{ type: "diff", path: "/repo/b", newText: "b" }] }),
    e(3, { toolCallId: "tool", status: "completed" }),
  ]);
  expect(t.rows[0]?.toolSources).toEqual({ locations: 1, content: 2 });
});
