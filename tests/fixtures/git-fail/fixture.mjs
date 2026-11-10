import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Inject faults into a test-owned executable, not the production Git environment.
export function gitFixture(directory, settings) {
  mkdirSync(directory, { recursive: true });
  const source = readFileSync(new URL("./git", import.meta.url), "utf8");
  writeFileSync(
    join(directory, "git"),
    source.replace(
      "#!/usr/bin/env node\n",
      `#!/usr/bin/env node\nObject.assign(process.env, ${JSON.stringify(settings)});\n`,
    ),
    { mode: 0o700 },
  );
  return directory;
}
