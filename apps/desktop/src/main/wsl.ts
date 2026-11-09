import { execFile } from "node:child_process";
import { join } from "node:path";
import { type Instance, PROTOCOL_VERSION, VERSION } from "@harnesshub/shared";
import { instanceSchema } from "@harnesshub/shared/client";
import type { Distribution } from "../contracts";

export class BridgeError extends Error {
  constructor(
    readonly code:
      | "WSL_MISSING"
      | "DISCOVERY"
      | "NOT_INSTALLED"
      | "INCOMPATIBLE"
      | "START_FAILED"
      | "NETWORK"
      | "IDENTITY",
    message: string,
  ) {
    super(message);
  }
}
export type RunResult = { stdout: Buffer; stderr: Buffer; code: number };
export type Run = (args: string[]) => Promise<RunResult>;
export function decodeWsl(buffer: Buffer): string {
  // wsl.exe emits UTF-16LE on redirected Windows stdout; Linux commands emit UTF-8.
  const utf16 = (buffer[0] === 0xff && buffer[1] === 0xfe) || buffer.subarray(0, 128).includes(0);
  return buffer.toString(utf16 ? "utf16le" : "utf8").replace(/^\uFEFF/, "");
}
export function parseDistributions(output: string): Distribution[] {
  const rows: Distribution[] = [];
  for (const line of output.split(/\r?\n/)) {
    // Match columns from the right; state/header labels may be localized.
    const match = /^\s*(\*)?\s*(.+?)\s{2,}(\S.*?)\s{2,}([12])\s*$/.exec(line);
    if (!match) continue;
    const name = match[2]?.trim();
    if (!name || Array.from(name).some((char) => char.charCodeAt(0) < 32)) continue;
    rows.push({
      name,
      state: match[3]?.trim() ?? "",
      version: Number(match[4]) as 1 | 2,
      isDefault: !!match[1],
    });
  }
  return rows;
}
export const runWsl: Run = (args) =>
  new Promise((resolve, reject) => {
    // Absolute system executable, no PATH lookup or cmd.exe / shell interpolation.
    const binary = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wsl.exe");
    execFile(
      binary,
      args,
      { encoding: "buffer", windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && (typeof error.code !== "number" || error.killed)) {
          reject(
            new BridgeError(
              error.code === "ENOENT" ? "WSL_MISSING" : "DISCOVERY",
              error.code === "ENOENT"
                ? "未找到 WSL。请安装 WSL2 与 Linux 发行版后重试。"
                : "WSL 命令超时或无法执行。请在 PowerShell 检查 wsl --status。",
            ),
          );
          return;
        }
        resolve({ stdout, stderr, code: error ? Number(error.code) : 0 });
      },
    );
  });
// Fixed script; distro and version are argv, never interpolated shell source. HOME is supplied
// by WSL's selected default Linux user, not the Windows process. No login shell/dotfiles.
export const BOOTSTRAP =
  'bridge="$HOME/.local/lib/harnesshub/desktop-bridge"; if [ ! -x "$bridge" ]; then printf \'{"bridgeVersion":1,"error":"NOT_INSTALLED"}\\n\'; exit 44; fi; exec "$bridge" "$@"';
export class WslBridge {
  constructor(private readonly run: Run = runWsl) {}
  async discover(): Promise<Distribution[]> {
    const result = await this.run(["--list", "--verbose"]);
    if (result.code !== 0)
      throw new BridgeError(
        "WSL_MISSING",
        "WSL 不可用或尚未安装发行版。请在 PowerShell 检查 wsl --status 和 wsl --list --verbose。",
      );
    const distributions = parseDistributions(decodeWsl(result.stdout));
    if (!distributions.length)
      throw new BridgeError(
        "DISCOVERY",
        "未找到可识别的 WSL 发行版。请安装 WSL2，并检查 wsl --list --verbose。",
      );
    return distributions;
  }
  async connect(distribution: string): Promise<Instance> {
    const rows = await this.discover();
    if (!rows.some((row) => row.name === distribution && row.version === 2))
      throw new BridgeError("DISCOVERY", "请选择已安装的 WSL2 发行版；WSL1 不受支持。");
    const result = await this.run([
      "--distribution",
      distribution,
      "--cd",
      "~",
      "--exec",
      "/bin/sh",
      "-c",
      BOOTSTRAP,
      "hhu-desktop",
      VERSION,
      String(PROTOCOL_VERSION),
    ]);
    let envelope: { bridgeVersion?: number; error?: string; instance?: unknown };
    try {
      envelope = JSON.parse(decodeWsl(result.stdout));
    } catch {
      throw new BridgeError(
        "START_FAILED",
        "WSL Bridge 返回无效响应。请在选中发行版运行 hhu doctor，检查安装版本及启动日志。",
      );
    }
    if (envelope.error === "NOT_INSTALLED")
      throw new BridgeError(
        "NOT_INSTALLED",
        "该发行版尚未安装 Desktop Bridge。请在 WSL 中按 Desktop 指南执行 bun run install:local；无需每次手动启动 hhu。",
      );
    if (envelope.error === "INCOMPATIBLE")
      throw new BridgeError(
        "INCOMPATIBLE",
        "HarnessHub 或 Daemon 版本不兼容。任务未停止。请等待任务结束，再按升级指南使用匹配版本安全停止并更新。",
      );
    if (result.code !== 0 || envelope.bridgeVersion !== 1 || envelope.error)
      throw new BridgeError(
        "START_FAILED",
        "WSL Daemon 无法启动。请在选中发行版运行 hhu doctor / hhu daemon logs；不会强制终止已有任务。",
      );
    const parsed = instanceSchema.safeParse(envelope.instance);
    if (!parsed.success) throw new BridgeError("IDENTITY", "WSL Bridge 实例信息无效；连接已拒绝。");
    if (parsed.data.version !== VERSION || parsed.data.protocolVersion !== PROTOCOL_VERSION)
      throw new BridgeError(
        "INCOMPATIBLE",
        "Desktop 与 WSL Daemon 版本不匹配；请完成任务后安全更新到相同版本。",
      );
    return parsed.data;
  }
}
