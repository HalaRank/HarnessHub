import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  ClientApp,
  type ClientConnection,
  type InitializeResponse,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import { AppError, type HarnessProfile, VERSION } from "@harnesshub/shared";
import { ProcessGroup } from "./process-group";

export class AcpTimeoutError extends AppError {
  constructor() {
    super(503, "ACP operation timed out; it was not retried");
  }
}

export function executable(command: string, env = process.env): string | null {
  for (const candidate of command.includes("/")
    ? [command]
    : (env.PATH ?? "").split(delimiter).map((dir) => join(dir, command))) {
    if (!isAbsolute(candidate)) continue;
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* Try next PATH entry. */
    }
  }
  return null;
}
export function builtinProfiles(adapterRuntime = process.execPath): HarnessProfile[] {
  const adapter = (id: string, name: string, bin: string, pkg: string): HarnessProfile => {
    const path = executable(bin);
    return {
      id,
      name,
      command: path ?? adapterRuntime,
      args: path ? [] : [fileURLToPath(new URL("./index.js", import.meta.resolve(pkg)))],
      envOverrides: {},
    };
  };
  return [
    adapter("codex", "Codex", "codex-acp", "@agentclientprotocol/codex-acp"),
    adapter("claude", "Claude Code", "claude-agent-acp", "@agentclientprotocol/claude-agent-acp"),
    { id: "grok", name: "Grok Build", command: "grok", args: ["agent", "stdio"], envOverrides: {} },
    { id: "opencode", name: "OpenCode", command: "opencode", args: ["acp"], envOverrides: {} },
  ];
}
export type WireMessage = Record<string, unknown>;
export type WorkerHooks = {
  wire: (direction: "agent" | "client", message: WireMessage) => void;
  permission: (
    request: RequestPermissionRequest,
    requestId: string,
    signal: AbortSignal,
  ) => Promise<RequestPermissionResponse>;
  lost: () => void;
  exited?: () => void;
};
export class Worker {
  readonly child: ChildProcessWithoutNullStreams;
  readonly connection: ClientConnection;
  readonly exited: Promise<void>;
  private childClosed = false;
  private readonly group: ProcessGroup | undefined;
  closed = false;
  private stopping = false;
  stderrBytes = 0;
  constructor(
    profile: HarnessProfile,
    readonly cwd: string,
    hooks: WorkerHooks,
  ) {
    if (!isAbsolute(cwd)) throw new AppError(400, "Worker cwd must be absolute");
    const env = { ...process.env, ...profile.envOverrides };
    const command = executable(profile.command, env);
    if (!command) throw new AppError(400, `ACP executable unavailable: ${profile.command}`);
    this.child = spawn(command, profile.args, { cwd, env, stdio: "pipe", detached: true });
    this.group = this.child.pid ? new ProcessGroup(this.child.pid) : undefined;
    // Agent stderr is drained but never copied to application logs (it can contain secrets).
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrBytes += chunk.length;
    });
    const failed = () => {
      if (this.closed) return;
      this.closed = true;
      this.connection?.close();
      if (!this.stopping) hooks.lost();
    };
    this.child.on("error", failed);
    // close follows stdio drain; exit can fire while final ACP messages remain unread.
    this.child.on("close", () => {
      this.childClosed = true;
      failed();
      // Transport loss, child close and owned process-group exit are separate facts.
      // Observe remaining descendants without sending signals or assuming they exited.
      const confirm = () => {
        if (this.stopping) return;
        if (this.exitedConfirmed) hooks.exited?.();
        else setTimeout(confirm, 100).unref();
      };
      confirm();
    });
    this.child.stdin.on("error", failed);
    this.exited = new Promise((resolve) => {
      this.child.once("close", () => resolve());
    });
    const stream = ndJsonStream(
      Writable.toWeb(this.child.stdin),
      Readable.toWeb(this.child.stdout) as unknown as ReadableStream<Uint8Array>,
    );
    // Capture before SDK validation/dispatch: future or unrecognized updates cannot disappear.
    const readable = stream.readable.pipeThrough(
      new TransformStream({
        transform(message, controller) {
          hooks.wire("agent", message as unknown as WireMessage);
          controller.enqueue(message);
        },
      }),
    );
    const writer = stream.writable.getWriter();
    const writable: typeof stream.writable = new WritableStream({
      async write(message) {
        hooks.wire("client", message as unknown as WireMessage);
        await writer.write(message);
      },
      close() {
        return writer.close();
      },
      abort(reason) {
        return writer.abort(reason);
      },
    });
    this.connection = new ClientApp({ name: "HarnessHub" })
      .onNotification("*", () => {})
      .onRequest("session/request_permission", (ctx) =>
        hooks.permission(ctx.params, JSON.stringify(ctx.requestId), ctx.signal),
      )
      .onRequest("*", () => {
        throw RequestError.methodNotFound("Unsupported client capability");
      })
      .connect({ readable, writable });
    void this.connection.closed.then(failed);
  }
  get agent() {
    return this.connection.agent;
  }
  get exitedConfirmed() {
    return this.childClosed && (!this.group || this.group.empty());
  }
  async initialize(): Promise<InitializeResponse> {
    const response = await this.bounded(
      this.agent.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: "HarnessHub", version: VERSION },
        // Agents execute their own native fs/terminal tools. Do not claim unimplemented callbacks.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }),
    );
    if (response.protocolVersion !== PROTOCOL_VERSION)
      throw new AppError(400, "Agent did not negotiate ACP v1");
    return response;
  }
  async bounded<T>(promise: Promise<T>, timeout = 20000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new AcpTimeoutError()), timeout);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  beginStop() {
    this.stopping = true;
  }
  async stop(force = false) {
    this.stopping = true;
    this.connection.close();
    this.child.stdin.end();
    const wait = async (ms: number) => {
      const deadline = Date.now() + ms;
      do {
        if (this.exitedConfirmed) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
      } while (Date.now() < deadline);
      return this.exitedConfirmed;
    };
    let drained = await wait(1000);
    if (!drained) {
      this.group?.signal("SIGTERM");
      drained = await wait(4000);
      if (!drained && force) {
        this.group?.signal("SIGKILL");
        drained = await wait(1000);
      }
    }
    // Retain ownership until both stdio and the owned Linux session are quiescent.
    if (!drained || !this.exitedConfirmed)
      throw new AppError(
        409,
        "Worker has not confirmed exit; explicit force confirmation is required",
      );
    this.closed = true;
  }
}
