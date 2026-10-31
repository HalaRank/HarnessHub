import { spawn } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  existsSync,
  fchmodSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Projects, Runtime } from "@harnesshub/core";
import {
  AppError,
  type ChangeEvent,
  conversationInput,
  type Instance,
  PROTOCOL_VERSION,
  projectInput,
  projectPatch,
  VERSION,
} from "@harnesshub/shared";
import { paths, privateWrite, securePaths } from "@harnesshub/shared/paths";
import { openStore } from "@harnesshub/storage";
import { serve, upgradeWebSocket, type WebSocketServerLike } from "@hono/node-server";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { WSContext } from "hono/ws";
import { WebSocketServer } from "ws";
import { ZodError, z } from "zod";
import { runtimeRoutes } from "./runtime-routes";

process.umask(0o077);
const p = paths();
securePaths(p);
// flock is held by the Node process itself after exec; crashes release it automatically.
if (!process.argv.includes("--lock-held")) {
  const child = spawn(
    "flock",
    [
      "--no-fork",
      "--nonblock",
      "--conflict-exit-code",
      "73",
      p.lock,
      process.execPath,
      fileURLToPath(import.meta.url),
      "--lock-held",
    ],
    { stdio: "inherit" },
  );
  child.on("error", () => {
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
} else {
  try {
    await main();
  } catch {
    console.error(
      "HarnessHub daemon startup failed; check runtime, database schema and private directory permissions.",
    );
    process.exitCode = 1;
  }
}

async function main() {
  const store = await openStore(p.db, fileURLToPath(new URL("./migrations/", import.meta.url)));
  const projects = new Projects(store);
  const token = randomBytes(32).toString("hex");
  const instanceId = randomUUID();
  const peers = new Set<WSContext>();
  let stopping = false;
  let instance: Instance;
  const app = new Hono();
  app.use("*", bodyLimit({ maxSize: 64 * 1024 }));
  app.use("*", async (c, next) => {
    // CLI clients have no browser Origin. Reject browser access, including WS upgrades.
    if (c.req.header("origin")) return c.json({ error: "Browser origins are not allowed" }, 403);
    const auth = c.req.header("authorization") ?? "";
    const expected = `Bearer ${token}`;
    if (
      Buffer.byteLength(auth) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))
    )
      return c.json({ error: "Unauthorized" }, 401);
    if (stopping) return c.json({ error: "Daemon is stopping" }, 503);
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof ZodError || error instanceof SyntaxError)
      return c.json({ error: "Invalid request body" }, 400);
    if (error instanceof AppError) return c.json({ error: error.message }, error.status);
    log("request_failed");
    return c.json({ error: "Internal error" }, 500);
  });
  const publish = (event: ChangeEvent | null) => {
    if (!event) return;
    for (const peer of peers) {
      try {
        peer.send(JSON.stringify({ type: "change", event }));
      } catch {
        peers.delete(peer);
      }
    }
  };
  const runtime = new Runtime(
    store,
    (event) => {
      for (const peer of peers) {
        try {
          peer.send(JSON.stringify({ type: "conversation.event", event }));
        } catch {
          peers.delete(peer);
        }
      }
    },
    publish,
  );
  runtimeRoutes(app, runtime);
  app.get("/v1/health", (c) =>
    c.json({
      product: "HarnessHub",
      version: VERSION,
      protocolVersion: PROTOCOL_VERSION,
      instanceId,
      pid: process.pid,
      runtime: process.release.name,
      nodeVersion: process.versions.node,
    }),
  );
  app.get("/v1/capabilities", (c) =>
    c.json({
      projects: true,
      conversations: true,
      metadataEvents: true,
      acp: true,
      conversationEvents: true,
    }),
  );
  app.get("/v1/snapshot", (c) => c.json(store.snapshot()));
  app.get("/v1/projects", (c) => c.json(store.listProjects()));
  app.post("/v1/projects", async (c) => {
    const data = projectInput.parse(await c.req.json());
    const result = projects.create(data.rootPath, data.name);
    publish(result.event);
    return c.json(result.value, result.event ? 201 : 200);
  });
  app.get("/v1/projects/:id", (c) => c.json(store.getProject(c.req.param("id"))));
  app.patch("/v1/projects/:id", async (c) => {
    const result = projects.update(c.req.param("id"), projectPatch.parse(await c.req.json()));
    publish(result.event);
    return c.json(result.value);
  });
  app.delete("/v1/projects/:id", (c) => {
    publish(store.deleteProject(c.req.param("id")));
    return c.json({ deleted: true, projectFilesDeleted: false });
  });
  app.get("/v1/projects/:id/conversations", (c) => {
    store.getProject(c.req.param("id"));
    return c.json(store.listConversations(c.req.param("id")));
  });
  app.post("/v1/projects/:id/conversations", async (c) => {
    const data = conversationInput.parse(await c.req.json());
    const result = projects.createConversation(c.req.param("id"), data.title);
    publish(result.event);
    return c.json(result.value, 201);
  });
  app.get("/v1/conversations/:id", (c) => c.json(store.getConversation(c.req.param("id"))));
  app.patch("/v1/conversations/:id", async (c) => {
    const result = store.updateConversation(
      c.req.param("id"),
      conversationInput.parse(await c.req.json()).title,
    );
    publish(result.event);
    return c.json(result.value);
  });
  app.delete("/v1/conversations/:id", (c) => {
    publish(store.deleteConversation(c.req.param("id")));
    return c.json({ deleted: true, projectFilesDeleted: false });
  });
  app.get("/v1/events", (c) => {
    const after = Number(c.req.query("after") ?? 0),
      limit = Number(c.req.query("limit") ?? 200);
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1000
    )
      throw new AppError(400, "Invalid event cursor or limit");
    return c.json(store.events(after, limit));
  });
  app.get(
    "/v1/ws",
    upgradeWebSocket(() => ({
      onOpen(_event, ws) {
        peers.add(ws);
        ws.send(JSON.stringify({ type: "hello", instanceId, cursor: store.snapshot().cursor }));
      },
      onClose(_event, ws) {
        peers.delete(ws);
      },
      onError(_event, ws) {
        peers.delete(ws);
      },
    })),
  );
  app.post("/v1/daemon/stop", async (c) => {
    const text = await c.req.text();
    const input = z
      .object({ cancelActive: z.boolean().default(false) })
      .strict()
      .parse(text ? JSON.parse(text) : {});
    await runtime.shutdown(input.cancelActive);
    stopping = true;
    setTimeout(() => {
      void shutdown(true);
    }, 25);
    return c.json({ stopping: true });
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  // Hono structural ws types and @types/ws differ under exactOptionalPropertyTypes.
  // This is the official noServer adapter integration; wire behavior is tested below.
  const server = serve({
    fetch: app.fetch,
    hostname: "127.0.0.1",
    port: 0,
    websocket: { server: wss as unknown as WebSocketServerLike },
  });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No TCP address");
  instance = {
    pid: process.pid,
    port: address.port,
    token,
    instanceId,
    version: VERSION,
    protocolVersion: PROTOCOL_VERSION,
  };
  privateWrite(p.instance, JSON.stringify(instance));
  log("started");
  let shutdownStarted = false;
  async function shutdown(prepared = false) {
    if (shutdownStarted) return;
    shutdownStarted = true;
    if (!prepared) {
      try {
        await runtime.shutdown(true);
      } catch {
        shutdownStarted = false;
        log("shutdown_refused_active_or_unconfirmed_worker");
        return;
      }
    }
    stopping = true;
    for (const peer of wss.clients) peer.close(1001, "Daemon stopping");
    const timer = setTimeout(() => {
      for (const peer of wss.clients) peer.terminate();
    }, 500);
    if ("closeIdleConnections" in server) server.closeIdleConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    clearTimeout(timer);
    store.close();
    try {
      if (JSON.parse(readFileSync(p.instance, "utf8")).instanceId === instance.instanceId)
        unlinkSync(p.instance);
    } catch {
      /* Instance is already gone. */
    }
    log("stopped");
  }
  process.on("SIGTERM", () => {
    void shutdown();
  });
  process.on("SIGINT", () => {
    void shutdown();
  });
}

function log(event: string) {
  const file = join(p.logs, "daemon.log");
  if (existsSync(file) && statSync(file).size > 1024 * 1024) renameSync(file, `${file}.1`);
  const fd = openSync(file, "a", 0o600);
  fchmodSync(fd, 0o600);
  try {
    writeSync(fd, `${new Date().toISOString()} ${event} pid=${process.pid}\n`);
  } finally {
    closeSync(fd);
  }
}
