import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function checkVersions(root: string) {
  const canonical = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string;
  const files = [
    "package.json",
    ...["apps", "packages"].flatMap((dir) =>
      readdirSync(join(root, dir)).map((name) => `${dir}/${name}/package.json`),
    ),
  ];
  for (const file of files) {
    if (JSON.parse(readFileSync(join(root, file), "utf8")).version !== canonical)
      throw new Error(`Version drift: ${file}; run bun scripts/version.ts ${canonical}`);
  }
  const shared = readFileSync(join(root, "packages/shared/src/index.ts"), "utf8");
  if (!shared.includes(`export const VERSION = "${canonical}";`))
    throw new Error("Shared VERSION differs from package.json");
  return { canonical, files, shared };
}
if (import.meta.main) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const next = process.argv[2];
  if (next && next !== "--check") {
    if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?$/.test(next))
      throw new Error("Expected semantic version");
    const files = [
      "package.json",
      ...["apps", "packages"].flatMap((dir) =>
        readdirSync(join(root, dir)).map((name) => `${dir}/${name}/package.json`),
      ),
    ];
    for (const file of files) {
      const path = resolve(root, file);
      const data = JSON.parse(readFileSync(path, "utf8"));
      data.version = next;
      writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
    }
    const shared = join(root, "packages/shared/src/index.ts");
    writeFileSync(
      shared,
      readFileSync(shared, "utf8").replace(
        /export const VERSION = "[^"]+";/,
        `export const VERSION = "${next}";`,
      ),
    );
    console.log("Update bun.lock with bun install --ignore-scripts before committing the version.");
  }
  console.log(`Unified version: ${checkVersions(root).canonical}`);
}
