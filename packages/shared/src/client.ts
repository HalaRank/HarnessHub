import { lstatSync, readFileSync, statSync } from "node:fs";
import { Agent, request as httpRequest } from "node:http";
import WebSocket from "ws";
import { z } from "zod";
import { type Instance, PROTOCOL_VERSION, type Snapshot, VERSION } from "./index";
import { paths } from "./paths";

const instanceSchema = z.object({
  pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65535),
  token: z.string().regex(/^[a-f0-9]{64}$/),
  instanceId: z.string().uuid(),
  version: z.string(),
  protocolVersion: z.number().int(),
});
export function readInstance(): Instance | null {
  try {
    const path = paths().instance;
    const link = lstatSync(path);
    const stat = statSync(path);
    if (
      link.isSymbolicLink() ||
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0
    )
      return null;
    return instanceSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
// Always connect directly to the local Daemon, including when the shell configures an HTTP proxy.
const localAgent = new Agent({ keepAlive: true });
export class Client {
  constructor(readonly instance: Instance) {}
  get base() {
    return `http://127.0.0.1:${this.instance.port}`;
  }
  async request<T>(path: string, method = "GET", body?: unknown, timeoutMs = 4000): Promise<T> {
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    return new Promise<T>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: "127.0.0.1",
          port: this.instance.port,
          path,
          method,
          agent: localAgent,
          headers: {
            authorization: `Bearer ${this.instance.token}`,
            ...(serialized === undefined
              ? {}
              : {
                  "content-type": "application/json",
                  "content-length": Buffer.byteLength(serialized),
                }),
          },
          signal: AbortSignal.timeout(timeoutMs),
        },
        (response) => {
          const chunks: string[] = [];
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => chunks.push(chunk));
          response.on("error", reject);
          response.on("end", () => {
            try {
              const result = JSON.parse(chunks.join("")) as T;
              const status = response.statusCode ?? 503;
              if (status < 200 || status >= 300)
                reject(
                  new HttpError(status, (result as { error?: string }).error ?? `HTTP ${status}`),
                );
              else resolve(result);
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.on("error", reject);
      req.end(serialized);
    });
  }
  async health() {
    const health = await this.request<{
      instanceId: string;
      pid: number;
      version: string;
      protocolVersion: number;
      runtime: string;
      nodeVersion: string;
    }>("/v1/health", "GET", undefined, 750);
    if (health.instanceId !== this.instance.instanceId || health.pid !== this.instance.pid)
      throw new Error("Daemon instance identity mismatch");
    if (health.version !== VERSION || health.protocolVersion !== PROTOCOL_VERSION)
      throw new Error("Daemon version mismatch; stop it before installing this build");
    return health;
  }
}
export async function connect(): Promise<Client | null> {
  const instance = readInstance();
  if (!instance) return null;
  const client = new Client(instance);
  try {
    await client.health();
    return client;
  } catch {
    return null;
  }
}

// Metadata subscriptions refresh canonical SQLite state on every connection and invalidation.
// This closes the read/subscribe race and reconnect gaps without replaying any user command.
export function watchSnapshot(
  onSnapshot: (snapshot: Snapshot) => void,
  onState: (state: string) => void,
) {
  let disposed = false;
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let refreshing = false;
  let dirty = false;
  let current: Client;
  let generation = 0;
  const refresh = async (epoch: number) => {
    dirty = true;
    if (refreshing) return;
    refreshing = true;
    try {
      while (dirty && !disposed && epoch === generation) {
        dirty = false;
        const snapshot = await current.request<Snapshot>("/v1/snapshot");
        if (!disposed && epoch === generation) onSnapshot(snapshot);
      }
    } catch {
      if (epoch === generation) {
        dirty = false;
        socket?.terminate();
      }
    } finally {
      refreshing = false;
      if (dirty && !disposed) void refresh(generation);
    }
  };
  const retryLater = () => {
    if (disposed || retry) return;
    onState("Disconnected · reconnecting");
    retry = setTimeout(() => {
      retry = undefined;
      void open();
    }, 500);
  };
  const open = async () => {
    const client = await connect();
    if (disposed) return;
    if (!client) {
      retryLater();
      return;
    }
    current = client;
    const epoch = ++generation;
    const ws = new WebSocket(`${client.base.replace("http:", "ws:")}/v1/ws`, {
      headers: { Authorization: `Bearer ${client.instance.token}` },
      handshakeTimeout: 4000,
    });
    socket = ws;
    ws.onmessage = (packet) => {
      const message = JSON.parse(String(packet.data));
      if (message.type !== "hello" && message.type !== "change") return;
      onState("Connected");
      void refresh(epoch);
    };
    ws.onclose = () => retryLater();
    ws.onerror = () => ws.close();
  };
  const poll = setInterval(() => {
    if (socket?.readyState === WebSocket.OPEN) void refresh(generation);
  }, 3000);
  void open();
  return () => {
    disposed = true;
    generation++;
    if (retry) clearTimeout(retry);
    clearInterval(poll);
    socket?.close();
  };
}

// Subscribe first, then page committed events. WS is an invalidation hint; SQLite is authoritative.
// Reconnect only reads history. It never replays prompt/approval commands.
export function watchConversation(
  conversationId: string,
  onEvent: (event: import("./runtime").ConversationEvent) => void,
  onState: (state: string) => void,
  afterSeq = 0,
  onBatch?: (events: import("./runtime").ConversationEvent[]) => void,
) {
  let cursor = afterSeq;
  let disposed = false;
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let reading = false;
  let dirty = false;
  let current: Client;
  const refresh = async (epoch: number) => {
    dirty = true;
    if (reading) return;
    reading = true;
    try {
      while (dirty && !disposed && epoch === generation) {
        dirty = false;
        const page = await current.request<{
          events: import("./runtime").ConversationEvent[];
          cursor: number;
        }>(`/v1/conversations/${conversationId}/events?after_seq=${cursor}&limit=200`);
        if (disposed || epoch !== generation) break;
        let nextCursor = cursor;
        const batch = [];
        for (const event of page.events) {
          if (event.seq <= nextCursor) continue;
          if (event.conversationId !== conversationId || event.seq !== nextCursor + 1)
            throw new Error("Conversation history has a sequence gap");
          batch.push(event);
          nextCursor = event.seq;
        }
        if (onBatch) onBatch(batch);
        else for (const event of batch) onEvent(event);
        cursor = nextCursor;
        onState("Connected");
        if (cursor < page.cursor) {
          if (!page.events.length) throw new Error("Conversation history is incomplete");
          dirty = true;
        }
      }
    } catch {
      if (epoch === generation) {
        dirty = false;
        socket?.terminate();
      }
    } finally {
      reading = false;
      if (dirty && !disposed) void refresh(generation);
    }
  };
  const reconnect = () => {
    if (disposed || retry) return;
    onState("Disconnected · reconnecting");
    retry = setTimeout(() => {
      retry = undefined;
      void open();
    }, 500);
  };
  const open = async () => {
    const client = await connect();
    if (disposed) return;
    if (!client) {
      reconnect();
      return;
    }
    current = client;
    const epoch = ++generation;
    const ws = new WebSocket(`${client.base.replace("http:", "ws:")}/v1/ws`, {
      headers: { Authorization: `Bearer ${client.instance.token}` },
      handshakeTimeout: 4000,
    });
    socket = ws;
    ws.onmessage = (packet) => {
      const message = JSON.parse(String(packet.data));
      if (
        message.type === "hello" ||
        (message.type === "conversation.event" && message.event.conversationId === conversationId)
      ) {
        void refresh(epoch);
      }
    };
    ws.onclose = reconnect;
    ws.onerror = () => ws.close();
  };
  const poll = setInterval(() => {
    if (socket?.readyState === WebSocket.OPEN) void refresh(generation);
  }, 3000);
  void open();
  return () => {
    disposed = true;
    generation++;
    clearTimeout(retry);
    clearInterval(poll);
    socket?.close();
  };
}
