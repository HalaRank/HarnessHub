import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";

const root = mkdtempSync(join(tmpdir(), "hhu-inputs-"));
const env = {
  ...process.env,
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_STATE_HOME: join(root, "state"),
};
const cli = (...args) =>
  execFileSync(process.env.HARNESSHUB_BUN, [resolve("dist/cli/hhu.js"), ...args], {
    env,
    timeout: 30000,
  });
const instance = () =>
  JSON.parse(readFileSync(join(env.XDG_STATE_HOME, "harnesshub/instance.json")));
async function response(path, method = "GET", body) {
  const current = instance();
  return fetch(`http://127.0.0.1:${current.port}${path}`, {
    method,
    headers: { authorization: `Bearer ${current.token}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10000),
  });
}
async function api(path, method, body) {
  const result = await response(path, method, body);
  assert.ok(result.ok, `${result.status} ${await result.clone().text()}`);
  return result.json();
}
async function until(check) {
  for (let i = 0; i < 500; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("Input state timeout");
}
let project;
before(async () => {
  cli("daemon", "start");
  project = await api("/v1/projects", "POST", { rootPath: root });
  for (const [id, steering] of [
    ["steer", "yes"],
    ["plain", ""],
    ["idle", "idle"],
    ["unknown", "disconnect"],
    ["images", "yes"],
  ])
    await api("/v1/harness-profiles", "POST", {
      id,
      name: id,
      command: "node",
      args: [resolve("tests/fixtures/mock-acp/server.mjs")],
      envOverrides: {
        ...(steering ? { HHU_MOCK_STEERING: steering } : {}),
        ...(id === "images" ? { HHU_MOCK_IMAGES: "1" } : {}),
      },
    });
});
after(() => {
  cli("daemon", "stop", "--cancel-active");
  console.log(`Input evidence ${root}`);
});
async function setup(harnessId = "steer", message = "timed") {
  const c = await api(`/v1/projects/${project.id}/conversations`, "POST", {});
  const turn = await api(`/v1/conversations/${c.id}/turns`, "POST", {
    harnessId,
    message,
    requestId: randomUUID(),
  });
  await until(async () =>
    ["RUNNING", "WAITING_APPROVAL"].includes(
      (await api(`/v1/conversations/${c.id}`)).runtimeStatus,
    ),
  );
  return { c, turn, harnessId };
}
const input = (context, delivery, message) => ({
  harnessId: context.harnessId,
  delivery,
  message,
  requestId: randomUUID(),
});
const send = (context, value) => api(`/v1/conversations/${context.c.id}/inputs`, "POST", value);
const inputs = (context) => api(`/v1/conversations/${context.c.id}/inputs`);
const history = async (context) =>
  (await api(`/v1/conversations/${context.c.id}/events?limit=1000`)).events;
const state = (context, requestId, expected) =>
  until(async () => {
    const value = (await inputs(context)).find((item) => item.requestId === requestId);
    return value?.state === expected && value;
  });
const done = (turn) =>
  until(async () => {
    const value = await api(`/v1/turns/${turn.id}`);
    return value.endedAt && value;
  });

test("Enter follow-up uses advertised steering, keeps one active turn and deduplicates request IDs", async () => {
  const context = await setup();
  const value = input(context, "steer", "additional direction 世界");
  await send(context, value);
  await state(context, value.requestId, "SENT");
  assert.equal((await api(`/v1/turns/${context.turn.id}`)).endedAt, null);
  await send(context, value);
  assert.equal(
    (
      await response(`/v1/conversations/${context.c.id}/inputs`, "POST", {
        ...value,
        message: "different",
      })
    ).status,
    409,
  );
  await done(context.turn);
  const events = await history(context);
  const requests = events.filter(
    (event) => event.origin === "client" && event.raw?.method === "_session/steering",
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].raw.params._meta.steering.idleBehavior, "promptRequired");
  assert.equal(
    events.filter(
      (event) => event.kind === "user.message" && event.payload.requestId === value.requestId,
    ).length,
    1,
  );
  assert.equal((await api(`/v1/requests/${value.requestId}`)).state, "SENT");
});

test("Tab queue persists FIFO and sends each follow-up once after normal completion", async () => {
  const context = await setup();
  const values = [input(context, "queue", "first"), input(context, "queue", "second")];
  for (const value of values) {
    await send(context, value);
    await send(context, value);
  }
  assert.equal(
    (await history(context)).filter((event) => event.raw?.method === "session/prompt").length,
    1,
  );
  await done(context.turn);
  for (const value of values) {
    const sent = await state(context, value.requestId, "SENT");
    await done({ id: sent.turnId });
    await send(context, value);
  }
  const events = await history(context);
  assert.deepEqual(
    events.filter((event) => event.kind === "user.message").map((event) => event.payload.text),
    ["timed", "first", "second"],
  );
  assert.equal(events.filter((event) => event.raw?.method === "session/prompt").length, 3);
});

test("Agents without steering advertise a visible queue fallback and receive no steering request", async () => {
  const context = await setup("plain");
  const value = input(context, "steer", "fallback");
  const queued = await send(context, value);
  assert.match(queued.reason, /steering unavailable/);
  assert.equal(queued.state, "QUEUED");
  await done(context.turn);
  const sent = await state(context, value.requestId, "SENT");
  await done({ id: sent.turnId });
  assert.equal(
    (await history(context)).filter((event) => event.raw?.method === "_session/steering").length,
    0,
  );
});

test("image follow-ups retain their attachment and wait for a new Turn", async () => {
  const context = await setup("images");
  const image = { name: "queued.png", mimeType: "image/png", data: "iVBORw0KGgo=" };
  const value = { ...input(context, "steer", ""), images: [image] };
  await send(context, value);
  await done(context.turn);
  const sent = await state(context, value.requestId, "SENT");
  assert.equal((await done({ id: sent.turnId })).state, "COMPLETED");
  const events = await history(context);
  assert.equal(events.filter((e) => e.raw?.method === "_session/steering").length, 0);
  const prompt = events.filter((e) => e.raw?.method === "session/prompt").at(-1);
  assert.deepEqual(
    prompt.raw.params.prompt.filter((block) => block.type === "image"),
    [{ type: "image", mimeType: image.mimeType, data: image.data }],
  );
});

test("Esc cancellation holds queued work until explicit resume and retains cancel tail events", async () => {
  const context = await setup("steer", "wait");
  const value = input(context, "queue", "after cancellation");
  await send(context, value);
  await api(`/v1/turns/${context.turn.id}/cancel`, "POST");
  assert.equal((await done(context.turn)).state, "CANCELLED");
  await state(context, value.requestId, "HELD");
  assert.equal(
    (await history(context)).filter((event) => event.raw?.method === "session/prompt").length,
    1,
  );
  assert.ok(
    (await history(context)).some(
      (event) => event.payload?.content?.text === "native tail after cancellation",
    ),
  );
  await api(`/v1/conversations/${context.c.id}/inputs/resume`, "POST");
  const sent = await state(context, value.requestId, "SENT");
  await done({ id: sent.turnId });
});

test("Follow-ups while waiting for native permission never approve it and queue removal is explicit", async () => {
  const context = await setup("steer", "permission");
  await until(async () => (await api(`/v1/conversations/${context.c.id}/approvals`)).length);
  const value = input(context, "steer", "permission context");
  await send(context, value);
  await state(context, value.requestId, "SENT");
  assert.equal((await api(`/v1/conversations/${context.c.id}/approvals`)).length, 1);
  const queued = input(context, "queue", "remove me");
  await send(context, queued);
  await api(`/v1/conversations/${context.c.id}/inputs/${queued.requestId}`, "DELETE");
  await state(context, queued.requestId, "CANCELLED");
  await api(`/v1/turns/${context.turn.id}/cancel`, "POST");
  await done(context.turn);
  assert.equal(
    (await history(context)).filter((event) => event.kind === "approval.decided").length,
    0,
  );
});

test("Idle steering race waits for original prompt completion and starts one host-owned next turn", async () => {
  const context = await setup("idle");
  const value = input(context, "steer", "idle race");
  await send(context, value);
  await state(context, value.requestId, "QUEUED");
  await done(context.turn);
  const sent = await state(context, value.requestId, "SENT");
  await done({ id: sent.turnId });
  assert.equal(
    (await history(context)).filter((event) => event.raw?.method === "session/prompt").length,
    2,
  );
});

test("Lost steering acknowledgement becomes UNCERTAIN, survives restart, and is never replayed", async () => {
  const context = await setup("unknown", "wait");
  const value = input(context, "steer", "unknown delivery");
  await send(context, value);
  await state(context, value.requestId, "UNCERTAIN");
  await done(context.turn);
  await send(context, value);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(
    (
      await response(
        `/v1/conversations/${context.c.id}/inputs`,
        "POST",
        input(context, "queue", "must not send"),
      )
    ).status,
    409,
  );
  cli("daemon", "stop");
  cli("daemon", "start");
  await state(context, value.requestId, "UNCERTAIN");
  const events = await history(context);
  assert.equal(events.filter((event) => event.raw?.method === "_session/steering").length, 1);
  const old = (await api(`/v1/conversations/${context.c.id}/sessions`))[0];
  await api(`/v1/conversations/${context.c.id}/session/recover`, "POST", {
    nativeSessionId: old.id,
    confirmed: true,
    acknowledgeUncertain: true,
    ...(old.exitConfirmed ? {} : { externalWorkerStopped: true }),
  });
  await state(context, value.requestId, "ACKNOWLEDGED");
  await send(context, value);
  assert.equal(
    (await history(context)).filter((event) => event.raw?.method === "_session/steering").length,
    1,
  );
  assert.equal((await api(`/v1/conversations/${context.c.id}`)).runtimeStatus, "IDLE");
  cli("daemon", "stop");
  cli("daemon", "start");
  await state(context, value.requestId, "ACKNOWLEDGED");
});

test("Daemon crash holds unsubmitted queue entries and reconnect GET never dispatches them", async () => {
  const context = await setup("plain", "wait");
  const value = input(context, "queue", "must remain held");
  await send(context, value);
  // Fault injection is confined to this test's temporary Daemon and Mock Worker.
  process.kill(instance().pid, "SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 250));
  cli("daemon", "start");
  await state(context, value.requestId, "HELD");
  await api(`/v1/requests/${value.requestId}`);
  assert.equal(
    (await history(context)).filter((event) => event.raw?.method === "session/prompt").length,
    1,
  );
  const old = (await api(`/v1/conversations/${context.c.id}/sessions`))[0];
  const recovery = { nativeSessionId: old.id, confirmed: true, acknowledgeUncertain: true };
  assert.equal(
    (await response(`/v1/conversations/${context.c.id}/session/recover`, "POST", recovery)).status,
    409,
  );
  const recovered = await api(`/v1/conversations/${context.c.id}/session/recover`, "POST", {
    ...recovery,
    externalWorkerStopped: true,
  });
  assert.notEqual(recovered.id, old.id);
  assert.equal((await api(`/v1/turns/${context.turn.id}`)).state, "UNCERTAIN");
  assert.equal((await api(`/v1/conversations/${context.c.id}`)).runtimeStatus, "IDLE");
  await state(context, value.requestId, "HELD");
  assert.equal(
    (await history(context)).filter((event) => event.raw?.method === "session/prompt").length,
    1,
  );
  const later = input(context, "queue", "wait behind paused message");
  assert.equal((await send(context, later)).state, "HELD");
  assert.equal(
    (await api("/v1/snapshot")).pendingInputs.find((i) => i.requestId === later.requestId).state,
    "HELD",
  );
  await api(`/v1/conversations/${context.c.id}/inputs/resume`, "POST");
  await state(context, value.requestId, "SENT");
  const last = await state(context, later.requestId, "SENT");
  await done({ id: last.turnId });
  assert.deepEqual(
    (await history(context))
      .filter((event) => event.kind === "user.message")
      .map((event) => event.payload.text),
    ["wait", "must remain held", "wait behind paused message"],
  );
});

test("confirmed Worker exit allows explicit continuation while keeping old uncertain results and request deduplication", async () => {
  const context = await setup("plain", "crash");
  await done(context.turn);
  const old = await until(async () => {
    const session = (await api(`/v1/conversations/${context.c.id}/sessions`))[0];
    return session?.exitConfirmed && session;
  });
  const recovery = { nativeSessionId: old.id, confirmed: true, acknowledgeUncertain: true };
  const replies = await Promise.all(
    [1, 2].map(() =>
      response(`/v1/conversations/${context.c.id}/session/recover`, "POST", recovery),
    ),
  );
  assert.deepEqual(replies.map((reply) => reply.status).sort(), [200, 409]);
  assert.equal((await api(`/v1/turns/${context.turn.id}`)).state, "UNCERTAIN");
  assert.equal((await api(`/v1/conversations/${context.c.id}/sessions`)).length, 2);
  const next = await api(`/v1/conversations/${context.c.id}/turns`, "POST", {
    harnessId: context.harnessId,
    requestId: randomUUID(),
    message: "continue explicitly",
  });
  await done(next);
  const prompts = (await history(context)).filter(
    (event) => event.raw?.method === "session/prompt",
  );
  assert.equal(prompts.length, 2);
  assert.equal((await api(`/v1/requests/${context.turn.requestId}`)).state, "UNCERTAIN");
});

test("Harness switching holds the queue and duplicate explicit resumes cannot dispatch twice", async () => {
  const context = await setup();
  const value = input(context, "queue", "original harness queue");
  await send(context, value);
  await api(`/v1/conversations/${context.c.id}/harness`, "PUT", { harnessId: "plain" });
  await state(context, value.requestId, "HELD");
  await done(context.turn);
  await api(`/v1/conversations/${context.c.id}/inputs/resume`, "POST");
  await state(context, value.requestId, "HELD");
  assert.equal(
    (await history(context)).filter((event) => event.raw?.method === "session/prompt").length,
    1,
  );
  await api(`/v1/conversations/${context.c.id}/harness`, "PUT", { harnessId: "steer" });
  await Promise.all(
    [1, 2].map(() => api(`/v1/conversations/${context.c.id}/inputs/resume`, "POST")),
  );
  const sent = await state(context, value.requestId, "SENT");
  await done({ id: sent.turnId });
  assert.equal(
    (await history(context)).filter((event) => event.raw?.method === "session/prompt").length,
    2,
  );
});

test("a request ID reserved by the queue cannot be reused as a normal turn in another conversation", async () => {
  const context = await setup("plain", "wait");
  const value = input(context, "queue", "reserved across clients");
  await send(context, value);
  const other = await api(`/v1/projects/${project.id}/conversations`, "POST", {});
  const { delivery: _, ...prompt } = value;
  assert.equal((await response(`/v1/conversations/${other.id}/turns`, "POST", prompt)).status, 409);
  await api(`/v1/turns/${context.turn.id}/cancel`, "POST");
  await done(context.turn);
  await api(`/v1/conversations/${context.c.id}/inputs/${value.requestId}`, "DELETE");
});
