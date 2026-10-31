import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
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
    worktrees: join(data, "worktrees"),
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
  for (const dir of [p.config, p.data, p.state, p.logs, p.worktrees]) privateDir(dir);
  for (const file of [p.db, `${p.db}-wal`, `${p.db}-shm`, p.instance, p.lock])
    if (lstatExists(file)) secureFile(file);
  for (const name of readdirSync(p.logs))
    if (/^(daemon|startup)\.log(?:\.\d+)?$/.test(name)) secureFile(join(p.logs, name));
}
function lstatExists(path: string) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
/** Enforce that a persisted HarnessHub file is owned by this user and has no group/other bits. */
export function secureFile(path: string, mode = 0o600) {
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.uid !== process.getuid?.() ||
    stat.nlink !== 1
  )
    throw new Error(`Unsafe HarnessHub file: ${path}`);
  if ((stat.mode & 0o077) !== 0 || (stat.mode & 0o777) !== mode) chmodSync(path, mode);
}
export function privateWrite(path: string, text: string) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
  renameSync(temp, path);
}

/** Append a short diagnostic line and retain a bounded number of private log files. */
export function appendPrivateLog(path: string, line: string, maxBytes = 1024 * 1024, retain = 5) {
  try {
    if (lstatExists(path)) secureFile(path);
    if (existsSync(path) && statSync(path).size >= maxBytes) {
      const oldest = `${path}.${retain}`;
      if (existsSync(oldest)) unlinkSync(oldest);
      for (let index = retain - 1; index >= 1; index--) {
        const from = `${path}.${index}`;
        if (existsSync(from)) renameSync(from, `${path}.${index + 1}`);
      }
      renameSync(path, `${path}.1`);
    }
    const fd = openSync(
      path,
      constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fchmodSync(fd, 0o600);
      writeSync(fd, line.endsWith("\n") ? line : `${line}\n`);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Diagnostics must never bring down the daemon or leak a secret in an exception.
  }
}
