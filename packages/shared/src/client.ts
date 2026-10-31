import { readFileSync } from "node:fs";
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
    return instanceSchema.parse(JSON.parse(readFileSync(paths().instance, "utf8")));
  } catch {
    return null;
  }
}
export class Client {
  constructor(readonly instance: Instance) {}
  get base() {
    return `http://127.0.0.1:${this.instance.port}`;
  }
  async request<T>(path: string, method = "GET", body?: unknown, timeoutMs = 4000): Promise<T> {
    const response = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.instance.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error((result as { error?: string }).error ?? `HTTP ${response.status}`);
    return result as T;
  }
  async health() {
    const health = await this.request<{
      instanceId: string;
      version: string;
      protocolVersion: number;
      runtime: string;
      nodeVersion: string;
    }>("/v1/health", "GET", undefined, 750);
    if (health.instanceId !== this.instance.instanceId)
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
      socket?.close();
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
    });
    socket = ws;
    ws.onmessage = () => {
      onState("Connected");
      void refresh(epoch);
    };
    ws.onclose = () => retryLater();
    ws.onerror = () => ws.close();
  };
  void open();
  return () => {
    disposed = true;
    generation++;
    if (retry) clearTimeout(retry);
    socket?.close();
  };
}
