import { chmodSync, lstatSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export function paths(env: NodeJS.ProcessEnv = process.env) {
  const base = (key: string, fallback: string) => {
    const value = env[key];
    if (value && !isAbsolute(value)) throw new Error(`${key} must be an absolute path`);
    return value || join(homedir(), fallback);
  };
  const config = join(base("XDG_CONFIG_HOME", ".config"), "harnesshub");
  const data = join(base("XDG_DATA_HOME", ".local/share"), "harnesshub");
  const state = join(base("XDG_STATE_HOME", ".local/state"), "harnesshub");
  return {
    config,
    data,
    state,
    logs: join(state, "logs"),
    db: join(data, "harnesshub.db"),
    instance: join(state, "instance.json"),
    lock: join(state, "daemon.lock"),
  };
}
export type Paths = ReturnType<typeof paths>;
export function privateDir(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) {
    throw new Error(`Unsafe HarnessHub directory: ${path}`);
  }
  chmodSync(path, 0o700);
}
export function securePaths(p: Paths) {
  for (const dir of [p.config, p.data, p.state, p.logs]) privateDir(dir);
}
export function privateWrite(path: string, text: string) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
  renameSync(temp, path);
}
