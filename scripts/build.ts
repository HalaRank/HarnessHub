import { cpSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import solidPlugin from "@opentui/solid/bun-plugin";

const external = Object.keys((await Bun.file("package.json").json()).dependencies);
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--outdir"))
  throw new Error("Usage: build.ts [--outdir directory]");
const output = resolve(args[1] ?? "dist");
mkdirSync(output, { recursive: true });
const daemon = await Bun.build({
  entrypoints: ["apps/daemon/src/index.ts"],
  target: "node",
  outdir: join(output, "daemon"),
  external,
  sourcemap: "external",
});
if (!daemon.success) throw new AggregateError(daemon.logs, "Daemon build failed");
// Bundle internal packages; external native/runtime dependencies remain resolved through node_modules.
const cli = await Bun.build({
  entrypoints: ["apps/cli/src/index.ts"],
  target: "bun",
  outdir: join(output, "cli"),
  naming: "hhu.js",
  plugins: [solidPlugin],
  external: external.filter((name) => !["solid-js", "@opentui/solid"].includes(name)),
  sourcemap: "external",
});
if (!cli.success) throw new AggregateError(cli.logs, "CLI build failed");
cpSync("packages/storage/migrations", join(output, "daemon/migrations"), { recursive: true });
console.log("Built HarnessHub CLI (Bun) and Daemon (Node)");

for (const [entry, outdir] of [
  ["packages/storage/src/index.ts", "storage"],
  ["packages/shared/src/client.ts", "client"],
  ["packages/shared/src/paths.ts", "paths"],
  ["packages/acp/src/index.ts", "acp"],
] as const) {
  const result = await Bun.build({
    entrypoints: [entry],
    target: "node",
    outdir: join(output, outdir),
    external,
  });
  if (!result.success) throw new AggregateError(result.logs, "Library build failed");
}
