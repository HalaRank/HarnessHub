import { cpSync, mkdirSync } from "node:fs";
import solidPlugin from "@opentui/solid/bun-plugin";

const external = Object.keys((await Bun.file("package.json").json()).dependencies);
mkdirSync("dist", { recursive: true });
const daemon = await Bun.build({
  entrypoints: ["apps/daemon/src/index.ts"],
  target: "node",
  outdir: "dist/daemon",
  external,
  sourcemap: "external",
});
if (!daemon.success) throw new AggregateError(daemon.logs, "Daemon build failed");
// Bundle internal packages; external native/runtime dependencies remain resolved through node_modules.
const cli = await Bun.build({
  entrypoints: ["apps/cli/src/index.ts"],
  target: "bun",
  outdir: "dist/cli",
  naming: "hhu.js",
  plugins: [solidPlugin],
  external: external.filter((name) => !["solid-js", "@opentui/solid"].includes(name)),
  sourcemap: "external",
});
if (!cli.success) throw new AggregateError(cli.logs, "CLI build failed");
cpSync("packages/storage/migrations", "dist/daemon/migrations", { recursive: true });
console.log("Built HarnessHub CLI (Bun) and Daemon (Node)");

for (const [entry, outdir] of [
  ["packages/storage/src/index.ts", "dist/storage"],
  ["packages/shared/src/client.ts", "dist/client"],
] as const) {
  const result = await Bun.build({
    entrypoints: [entry],
    target: "node",
    outdir,
    external,
  });
  if (!result.success) throw new AggregateError(result.logs, "Library build failed");
}
