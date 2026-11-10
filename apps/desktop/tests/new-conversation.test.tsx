import { expect, test } from "bun:test";
import type { Conversation } from "@harnesshub/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { type DesktopApi, type DesktopState, desktopRequest } from "../src/contracts";
import { performAction } from "../src/main/actions";
import { ConversationItem } from "../src/renderer/App";
import { newConversationDraft } from "../src/renderer/drafts";
import { NewConversation } from "../src/renderer/NewConversation";

const id = "7ad657ec-2001-405b-801a-3d86b092f1b0";
const api = {
  request: async () => {
    throw new Error("render only");
  },
  subscribe: () => () => {},
} as DesktopApi;
const state: DesktopState = {
  revision: 0,
  status: "connected",
  detail: "",
  distribution: "Ubuntu",
  conversationId: null,
  events: [],
  historyLoading: false,
  profiles: [{ id: "codex", name: "Codex" }],
  snapshot: {
    projects: [{ id, name: "HarnessHub", rootPath: "/project", createdAt: 0, updatedAt: 0 }],
    conversations: [],
    activity: { items: [], running: 0, waitingApproval: 0, problems: 0 },
  } as unknown as DesktopState["snapshot"],
};
test("new conversation uses the product logo, project sentence and inline workspace controls without a title form", () => {
  const html = renderToStaticMarkup(
    <NewConversation
      api={api}
      state={state}
      value={{ projectId: id, workspace: "" }}
      draft={newConversationDraft(api)}
      change={() => {}}
      created={async () => {}}
      busyChanged={() => {}}
    />,
  );
  for (const text of [
    "HarnessHub Logo",
    "HarnessHub",
    "中构建什么",
    'aria-label="项目"',
    'aria-label="分支"',
    'aria-label="创建工作树"',
    'aria-label="消息输入"',
    'aria-label="发送消息"',
  ])
    expect(html).toContain(text);
  expect(html).not.toContain("会话名称");
  expect(html).not.toContain("<dialog");
});
test("conversation row has only rename and archive actions tied to the row title", () => {
  const conversation = {
    id,
    title: "修复登录",
    selectedHarnessId: "codex",
    runtimeStatus: "IDLE",
    archivedAt: null,
  } as Conversation;
  const render = (archivedAt: number | null) =>
    renderToStaticMarkup(
      <ConversationItem
        value={{ ...conversation, archivedAt }}
        active={false}
        disabled={false}
        onSelect={() => {}}
        rename={() => {}}
        archive={() => {}}
      />,
    );
  expect(render(null)).toContain('aria-label="重命名 修复登录"');
  expect(render(null)).toContain('aria-label="归档 修复登录"');
  expect(render(1)).toContain('aria-label="恢复 修复登录"');
  expect(render(null)).not.toContain("删除");
  expect((render(null).match(/<button/g) ?? []).length).toBe(3);
});
test("standalone conversation marks its ownership within the row", () => {
  const html = renderToStaticMarkup(
    <ConversationItem
      value={
        {
          id,
          projectId: null,
          title: "独立任务",
          runtimeStatus: "IDLE",
          selectedHarnessId: "codex",
        } as Conversation
      }
      active={false}
      disabled={false}
      onSelect={() => {}}
      rename={() => {}}
      archive={() => {}}
    />,
  );
  expect(html).toContain('<span class="standalone-label">独立会话</span>');
  expect(html).not.toContain("project-heading");
});
test("Desktop creates unnamed project and standalone conversations and forwards the worktree starting branch", async () => {
  const calls: unknown[] = [];
  const client = {
    request: async (...args: unknown[]) => {
      calls.push(args);
    },
  } as unknown as Parameters<typeof performAction>[0];
  for (const request of [
    { type: "conversation.create", projectId: id },
    {
      type: "conversation.create",
      projectId: id,
      workspaceMode: "worktree",
      baseBranch: "feature/start",
    },
    { type: "conversation.standalone", workspacePath: "/project" },
    { type: "project.branches", projectId: id },
  ])
    await performAction(client, desktopRequest.parse(request));
  expect(calls).toEqual([
    [
      `/v1/projects/${id}/conversations`,
      "POST",
      { title: undefined, workspaceMode: undefined, baseBranch: undefined },
    ],
    [
      `/v1/projects/${id}/conversations`,
      "POST",
      { title: undefined, workspaceMode: "worktree", baseBranch: "feature/start" },
    ],
    ["/v1/conversations", "POST", { title: undefined, workspacePath: "/project" }],
    [`/v1/projects/${id}/branches`],
  ]);
  expect(
    desktopRequest.safeParse({ type: "conversation.create", projectId: id, title: "" }).success,
  ).toBe(false);
});
test("new-page draft survives a new editor and rejects a stale window without losing local text", async () => {
  let saved = { conversationId: "desktop-new", text: "", revision: 0, pendingSubmission: null };
  const backend: DesktopApi = {
    subscribe: () => () => {},
    request: async (request) => {
      if (request.type === "new-draft.save") {
        if (request.draft.revision !== saved.revision)
          return { ok: false, status: 409, error: "Draft changed" };
        saved = { ...saved, text: request.draft.text, revision: saved.revision + 1 };
      } else if (request.type !== "new-draft.load") throw new Error("Unexpected request");
      return { ok: true, state, data: structuredClone(saved) };
    },
  };
  const first = newConversationDraft(backend);
  await first.load();
  first.update("未发送首条消息");
  await first.flush();
  const reopened = newConversationDraft(backend);
  await reopened.load();
  expect(reopened.text).toBe("未发送首条消息");
  reopened.update("另一个窗口编辑");
  await reopened.flush();
  first.update("本地未保存文字");
  await expect(first.flush()).rejects.toThrow("Draft changed");
  expect(first.text).toBe("本地未保存文字");
  expect(saved.text).toBe("另一个窗口编辑");
});
