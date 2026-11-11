import { resolve } from "node:path";
import { changes, patch, type Runtime, workspaceFolder } from "@harnesshub/core";
import {
  AppError,
  decisionInput,
  handoffAction,
  harnessSelection,
  profileInput,
  sensitiveEnvKeys,
  settingInput,
  turnInput,
  workspaceLocationInput,
} from "@harnesshub/shared";
import { object } from "@harnesshub/shared/event-projection";
import type { Context, Hono } from "hono";
import { z } from "zod";

export function runtimeRoutes(app: Hono, runtime: Runtime) {
  app.put("/v1/conversations/:id/harness", async (c) =>
    c.json(
      runtime.handoffs.select(
        c.req.param("id"),
        harnessSelection.parse(await c.req.json()).harnessId,
      ),
    ),
  );
  app.get("/v1/conversations/:id/handoffs", (c) => {
    runtime.store.getConversation(c.req.param("id"));
    return c.json(runtime.handoffs.data.list(c.req.param("id")));
  });
  const exportConversation = (c: Context) => {
    const requested = c.req.query("format") ?? "chat";
    const format = requested === "readable" ? "chat" : requested === "raw" ? "debug" : requested;
    if (format !== "chat" && format !== "debug")
      throw new AppError(400, "Export format must be chat or debug");
    return c.json(
      runtime.data.exportConversation(c.req.param("id") ?? "", format as "chat" | "debug"),
    );
  };
  app.get("/v1/conversations/:id/export", exportConversation);
  app.get("/v1/export/conversations/:id", exportConversation);
  app.post("/v1/conversations/:id/handoff/action", async (c) => {
    const input = handoffAction.parse(await c.req.json());
    return c.json(runtime.handoffs.action(c.req.param("id"), input.handoffId, input.action));
  });
  app.post("/v1/conversations/:id/workspace/location", async (c) => {
    const id = c.req.param("id");
    const workspace = runtime.store.getConversation(id).workspacePath;
    const input = workspaceLocationInput.parse(await c.req.json());
    let path: string | undefined;
    if (input.kind === "change") {
      const state = await changes(workspace);
      if (!state.repository || !state.files.some((f) => f.path === input.path))
        throw new AppError(404, "Change no longer exists; refresh Changes");
      if (input.path.split("/").some((p) => p === ".." || p === "."))
        throw new AppError(400, "Unsafe Git path");
      path = resolve(state.repository, input.path);
    } else if (input.kind === "tool") {
      const event = runtime.data.events(id, input.seq - 1, 1)[0];
      if (
        !event ||
        event.seq !== input.seq ||
        !["tool_call", "tool_call_update", "approval.requested"].includes(event.kind)
      )
        throw new AppError(404, "Native tool event not found");
      const payload =
        event.kind === "approval.requested"
          ? object(object(object(event.payload).request).toolCall)
          : object(event.payload);
      const entries = payload[input.collection];
      const entry = object(Array.isArray(entries) ? entries[input.index] : null);
      if (input.collection === "content" && entry.type !== "diff")
        throw new AppError(400, "Not a native Diff location");
      if (typeof entry.path !== "string" || !entry.path.startsWith("/"))
        throw new AppError(400, "Native tool did not provide an absolute Linux path");
      path = entry.path;
    }
    return c.json(await workspaceFolder(workspace, path));
  });
  app.get("/v1/conversations/:id/changes", async (c) => {
    const workspace = runtime.store.getConversation(c.req.param("id")).workspacePath;
    const path = c.req.query("path");
    return c.json(path === undefined ? await changes(workspace) : await patch(workspace, path));
  });
  const sessionInput = z.object({ harnessId: z.string().min(1) }).strict();
  const closeInput = z
    .object({ force: z.boolean().default(false), confirmed: z.boolean().default(false) })
    .strict();
  app.get("/v1/harness-profiles", (c) =>
    c.json(
      runtime.profiles().map(({ envOverrides, ...profile }) => ({
        ...profile,
        envOverrideKeys: Object.keys(envOverrides),
        sensitiveEnvOverrideKeys: sensitiveEnvKeys({ ...profile, envOverrides }),
      })),
    ),
  );
  app.post("/v1/harness-profiles", async (c) => {
    const profile = runtime.saveProfile(profileInput.parse(await c.req.json()));
    return c.json(
      { ...profile, envOverrides: undefined, envOverrideKeys: Object.keys(profile.envOverrides) },
      201,
    );
  });
  app.get("/v1/diagnostics", (c) => c.json(runtime.diagnostics()));
  app.get("/v1/harness-profiles/:id/capabilities", (c) => {
    runtime.profile(c.req.param("id"));
    return c.json(
      [...runtime.live.values()]
        .filter((l) => l.harnessId === c.req.param("id"))
        .map((l) => ({ conversationId: l.conversationId, ...runtime.capabilities(l) })),
    );
  });
  app.post("/v1/conversations/:id/sessions", async (c) => {
    const id = c.req.param("id");
    const { harnessId } = sessionInput.parse(await c.req.json());
    if (runtime.closing || runtime.data.active(id).length)
      throw new AppError(409, "Conversation has an active operation");
    if (runtime.store.getConversation(id).runtimeStatus === "UNCERTAIN")
      throw new AppError(409, "Previous execution is UNCERTAIN");
    const live = await runtime.ensure(id, harnessId);
    return c.json(runtime.data.session(live.id));
  });
  app.get("/v1/conversations/:id/sessions", (c) => {
    runtime.store.getConversation(c.req.param("id"));
    return c.json(
      runtime.data.sessions(c.req.param("id")).map((session) => ({
        ...session,
        exitConfirmed: runtime.data.workerExitConfirmed(session.id),
      })),
    );
  });
  app.post("/v1/conversations/:id/session/recover", async (c) => {
    const input = z
      .object({
        nativeSessionId: z.string().uuid(),
        confirmed: z.literal(true),
        acknowledgeUncertain: z.literal(true).optional(),
        externalWorkerStopped: z.literal(true).optional(),
      })
      .strict()
      .parse(await c.req.json());
    return c.json(await runtime.recoverSession(c.req.param("id"), input.nativeSessionId, input));
  });
  app.post("/v1/conversations/:id/session/stop", async (c) => {
    const input = closeInput.parse(await c.req.json());
    if (input.force && !input.confirmed)
      throw new AppError(400, "Force stop requires explicit confirmed=true");
    await runtime.closeSession(c.req.param("id"), input.force);
    return c.json({ stopped: true });
  });
  app.post("/v1/conversations/:id/settings", async (c) =>
    c.json(await runtime.settings(c.req.param("id"), settingInput.parse(await c.req.json()))),
  );
  app.post("/v1/conversations/:id/turns", async (c) =>
    c.json(runtime.submit(c.req.param("id"), turnInput.parse(await c.req.json())), 202),
  );
  app.get("/v1/conversations/:id/inputs", (c) => {
    runtime.store.getConversation(c.req.param("id"));
    return c.json(runtime.inputs.list(c.req.param("id")));
  });
  app.post("/v1/conversations/:id/inputs", async (c) =>
    c.json(runtime.inputs.accept(c.req.param("id"), turnInput.parse(await c.req.json())), 202),
  );
  app.post("/v1/conversations/:id/inputs/resume", (c) =>
    c.json(runtime.inputs.resume(c.req.param("id"))),
  );
  app.delete("/v1/conversations/:id/inputs/:requestId", (c) =>
    c.json(runtime.inputs.remove(c.req.param("id"), c.req.param("requestId"))),
  );
  app.get("/v1/turns/:id", (c) => c.json(runtime.data.turn(c.req.param("id"))));
  app.get("/v1/requests/:requestId", (c) => {
    const requestId = z.string().uuid().parse(c.req.param("requestId"));
    const turn =
      runtime.data.byRequest(requestId) ??
      runtime.data.inputs().find((input) => input.requestId === requestId);
    if (!turn) throw new AppError(404, "Request has not been recorded; it was not resent");
    return c.json(turn);
  });
  app.post("/v1/turns/:id/cancel", async (c) => c.json(await runtime.cancel(c.req.param("id"))));
  app.get("/v1/conversations/:id/approvals", (c) => {
    runtime.store.getConversation(c.req.param("id"));
    return c.json(runtime.data.pending(c.req.param("id")));
  });
  app.post("/v1/approvals/:id/decision", async (c) =>
    c.json(runtime.decide(c.req.param("id"), decisionInput.parse(await c.req.json()).optionId)),
  );
  app.get("/v1/conversations/:id/events", (c) => {
    const id = c.req.param("id");
    runtime.store.getConversation(id);
    const after = Number(c.req.query("after_seq") ?? 0),
      limit = Number(c.req.query("limit") ?? 200);
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1000
    )
      throw new AppError(400, "Invalid Conversation event cursor or limit");
    return c.json({
      events: runtime.data.events(id, after, limit),
      cursor: runtime.data.cursor(id),
    });
  });
}
