import { expect, test } from "bun:test";
import {
  attachmentInputError,
  type Draft,
  imageAttachments,
  sameImages,
  turnInput,
} from "@harnesshub/shared";
import { renderToStaticMarkup } from "react-dom/server";
import type { DesktopApi, DesktopRequest } from "../src/contracts";
import { DesktopDraft } from "../src/renderer/drafts";
import { DesktopTranscript } from "../src/renderer/history";
import { ImagePreviews } from "../src/renderer/Images";

const image = {
  name: "截图.png",
  mimeType: "image/png" as const,
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0L8AAAAASUVORK5CYII=",
};
const file = {
  kind: "file" as const,
  name: "需求.pdf",
  mimeType: "application/pdf",
  data: "JVBERg==",
};

test("file attachments validate, negotiate separately and render inert document previews", () => {
  expect(
    turnInput.safeParse({
      requestId: crypto.randomUUID(),
      harnessId: "mock",
      message: "",
      images: [file],
    }).success,
  ).toBe(true);
  expect(imageAttachments.safeParse([image, file]).success).toBe(true);
  expect(imageAttachments.safeParse([{ ...file, data: "" }]).success).toBe(true);
  expect(
    imageAttachments.safeParse([{ ...file, mimeType: "text/html; charset=utf-8" }]).success,
  ).toBe(false);
  expect(attachmentInputError([file], { image: true })).toContain("文件输入能力");
  expect(attachmentInputError([image, file], { image: true, embeddedContext: true })).toBe("");
  expect(sameImages([image], [{ ...image, kind: "file" }])).toBe(false);
  const html = renderToStaticMarkup(<ImagePreviews images={[file]} remove={() => {}} />);
  expect(html).toContain("需求.pdf");
  expect(html).toContain("移除文件 需求.pdf");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<iframe");
  expect(html).not.toContain(file.data);
});

test("attachment input accepts large files and arbitrary counts while validating content", () => {
  const input = { requestId: crypto.randomUUID(), harnessId: "mock", message: "" };
  expect(turnInput.safeParse(input).success).toBe(false);
  expect(turnInput.safeParse({ ...input, message: " " }).success).toBe(true);
  expect(turnInput.safeParse({ ...input, images: [image] }).success).toBe(true);
  expect(imageAttachments.safeParse(Array(20).fill(image)).success).toBe(true);
  const data = Buffer.alloc(6 * 1024 * 1024, 1).toString("base64");
  expect(
    imageAttachments.safeParse([
      { ...image, data },
      { ...file, data },
    ]).success,
  ).toBe(true);
  for (const patch of [
    { mimeType: "image/svg+xml" },
    { data: "file:///etc/passwd" },
    { data: "abcd=" },
  ])
    expect(imageAttachments.safeParse([{ ...image, ...patch }]).success).toBe(false);
});

function backend() {
  let saved: Draft = { conversationId: "test", text: "", revision: 0, pendingSubmission: null };
  const submissions: DesktopRequest[] = [];
  const api: DesktopApi = {
    subscribe: () => () => {},
    request: async (request) => {
      const ok = (data: unknown) => ({
        ok: true as const,
        state: {} as never,
        data: structuredClone(data),
      });
      if (request.type === "draft.load") return ok(saved);
      if (request.type === "draft.save") {
        if (request.draft.revision !== saved.revision)
          return { ok: false, status: 409, error: "CAS" };
        saved = { ...request.draft, conversationId: "test", revision: saved.revision + 1 };
        return ok(saved);
      }
      if (request.type === "turn.submit") {
        submissions.push(request);
        throw new Error("lost ACK");
      }
      return { ok: false, error: "Unexpected request" };
    },
  };
  return { api, submissions, saved: () => saved };
}

test("images persist across editors and unknown send outcomes retain the same attachment and request ID", async () => {
  const store = backend();
  const editor = new DesktopDraft(store.api, "test");
  await editor.load();
  editor.updateImages([image, file]);
  await editor.flush();
  const reopened = new DesktopDraft(store.api, "test");
  await reopened.load();
  expect(reopened.images).toEqual([image, file]);
  expect(reopened.hasContent).toBe(true);
  await reopened.submit("mock");
  const pending = reopened.value.pendingSubmission;
  expect(pending?.images).toEqual([image, file]);
  await reopened.submit("mock");
  expect(store.submissions).toHaveLength(1);
  expect(reopened.value.pendingSubmission?.requestId).toBe(pending?.requestId);
  reopened.updateImages([]);
  expect(reopened.images).toEqual([image, file]);
});

test("close-time flush waits for image reading, removal persists, CAS retains local images", async () => {
  const store = backend();
  const editor = new DesktopDraft(store.api, "test");
  await editor.load();
  let finish!: (images: (typeof image)[]) => void;
  const reading = editor.readImages(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  let flushed = false;
  const flush = editor.flush().then(() => {
    flushed = true;
  });
  await Promise.resolve();
  expect(flushed).toBe(false);
  finish([image]);
  await Promise.all([reading, flush]);
  expect(store.saved().images).toEqual([image]);
  editor.updateImages([]);
  await editor.flush();
  expect(store.saved().images).toEqual([]);
  const stale = new DesktopDraft(store.api, "test");
  await stale.load();
  editor.update("advance revision");
  await editor.flush();
  stale.updateImages([image]);
  await expect(stale.flush()).rejects.toThrow();
  expect(stale.images).toEqual([image]);
});

test("image-only history renders local previews and accessible removal controls", () => {
  const transcript = new DesktopTranscript();
  transcript.append([
    {
      id: "image",
      conversationId: "test",
      turnId: "turn",
      nativeSessionId: null,
      seq: 1,
      kind: "user.message",
      payload: { text: "", images: [image] },
      raw: null,
      origin: "client",
      createdAt: 0,
    },
  ]);
  expect(transcript.rows[0]?.images).toEqual([image]);
  const html = renderToStaticMarkup(<ImagePreviews images={[image]} remove={() => {}} />);
  expect(html).toContain("data:image/png;base64,");
  expect(html).toContain("移除图片 截图.png");
});
