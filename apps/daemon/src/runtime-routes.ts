import type { Runtime } from "@harnesshub/core";
import {
  AppError,
  decisionInput,
  profileInput,
  sensitiveEnvKeys,
  settingInput,
  turnInput,
} from "@harnesshub/shared";
import type { Hono } from "hono";
import { z } from "zod";

export function runtimeRoutes(app: Hono, runtime: Runtime) {
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
    return c.json(runtime.data.sessions(c.req.param("id")));
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
  app.get("/v1/turns/:id", (c) => c.json(runtime.data.turn(c.req.param("id"))));
  app.get("/v1/requests/:requestId", (c) => {
    const requestId = z.string().uuid().parse(c.req.param("requestId"));
    const turn = runtime.data.byRequest(requestId);
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
