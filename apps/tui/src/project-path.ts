import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export function expandProjectPath(value: string): string {
  if (!value) throw new Error("Enter an existing project directory");
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  if (value.startsWith("~")) throw new Error("Use ~/ for your home directory");
  return isAbsolute(value) ? value : resolve(homedir(), value);
}

export async function completeProjectPath(prefix: string) {
  const value = prefix === "" || prefix === "~" ? "~/" : prefix;
  const slash = value.lastIndexOf("/");
  const parent = value.slice(0, slash + 1);
  const name = value.slice(slash + 1);
  const directory = expandProjectPath(parent || "~/");
  const entries = await readdir(directory, { withFileTypes: true });
  const matches = await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.name.startsWith(name) && (name.startsWith(".") || !entry.name.startsWith(".")),
      )
      .map(async (entry) => {
        const isDirectory =
          entry.isDirectory() ||
          (entry.isSymbolicLink() &&
            (await stat(join(directory, entry.name)).then(
              (s) => s.isDirectory(),
              () => false,
            )));
        return isDirectory ? `${entry.name}/` : null;
      }),
  );
  const candidates = matches.filter((match) => match !== null).sort();
  let common = candidates[0] ?? name;
  for (const candidate of candidates.slice(1)) {
    while (!candidate.startsWith(common)) common = common.slice(0, -1);
  }
  return { value: parent + common, candidates };
}
