import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export const sha256 = (file: string) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
export type PayloadEntry = { sha256: string; mode: number } | { link: string };
export type ReleaseManifest = {
  product: "HarnessHub";
  version: string;
  platform: "linux";
  arch: "x64";
  libc: "glibc";
  protocolVersion: number;
  runtimes: { node: string; bun: string };
  files: Record<string, PayloadEntry>;
};

export function inside(root: string, path: string) {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}

// Inventory doubles as the installer's verification contract. Links must remain in the payload.
export function inventory(root: string): Record<string, PayloadEntry> {
  const files: Record<string, PayloadEntry> = {};
  const walk = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const rel = relative(root, path);
      if (rel === "release-manifest.json") continue;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        const link = readlinkSync(path);
        if (isAbsolute(link) || !inside(root, realpathSync(path)))
          throw new Error(`External payload link: ${rel}`);
        files[rel] = { link };
      } else if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) files[rel] = { sha256: sha256(path), mode: stat.mode & 0o777 };
      else throw new Error(`Unsupported payload entry: ${rel}`);
    }
  };
  walk(root);
  return files;
}

type Package = {
  name: string;
  version: string;
  license?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

// Preserve each package's dependency resolution, including multiple SDK versions and npm aliases.
// Only traverse production edges; never copy the developer's node_modules or workspace links.
export function copyDependencies(source: string, target: string, names: string[]) {
  const copied = new Map<string, string>();
  const packages: { name: string; version: string; license: string; path: string }[] = [];
  const find = (from: string, name: string): string | undefined => {
    let current = from;
    while (inside(source, current)) {
      const candidate = join(current, "node_modules", name);
      if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
      if (current === source) break;
      current = dirname(current);
    }
    return undefined;
  };
  const copy = (path: string): string => {
    if (!inside(source, path)) throw new Error(`Dependency escaped clean installation: ${path}`);
    const previous = copied.get(path);
    if (previous) return previous;
    const pkg = JSON.parse(readFileSync(join(path, "package.json"), "utf8")) as Package;
    const destination = join(
      target,
      "node_modules/.hhu",
      String(copied.size),
      "node_modules",
      pkg.name,
    );
    copied.set(path, destination);
    cpSync(path, destination, {
      recursive: true,
      filter: (entry) => entry !== join(path, "node_modules"),
      verbatimSymlinks: true,
    });
    packages.push({
      name: pkg.name,
      version: pkg.version,
      license: pkg.license ?? "See package notices",
      path: relative(target, destination),
    });
    const dependencies = {
      ...pkg.peerDependencies,
      ...pkg.dependencies,
      ...pkg.optionalDependencies,
    };
    for (const name of Object.keys(dependencies).sort()) {
      const dependency = find(path, name);
      if (!dependency) {
        if (name in (pkg.optionalDependencies ?? {}) || pkg.peerDependenciesMeta?.[name]?.optional)
          continue;
        throw new Error(`Missing runtime dependency: ${pkg.name} -> ${name}`);
      }
      link(copy(dependency), join(destination, "node_modules", name));
    }
    return destination;
  };
  const link = (to: string, at: string) => {
    mkdirSync(dirname(at), { recursive: true });
    symlinkSync(relative(dirname(at), to), at);
  };
  for (const name of names.sort()) {
    const path = find(source, name);
    if (!path) throw new Error(`Missing root runtime dependency: ${name}`);
    link(copy(path), join(target, "node_modules", name));
  }
  return packages;
}

export function launchScript(release: string, args = "") {
  return `#!/bin/sh
# HarnessHub release launcher
export PATH=${shellQuote(join(release, "runtime"))}:"$PATH"
exec ${shellQuote(join(release, "runtime/bun"))} --no-env-file ${shellQuote(join(release, "dist/cli/hhu.js"))} ${args}"$@"
`;
}

export function validateManifest(root: string): ReleaseManifest {
  const manifest = JSON.parse(
    readFileSync(join(root, "release-manifest.json"), "utf8"),
  ) as ReleaseManifest;
  if (
    manifest.product !== "HarnessHub" ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?$/.test(manifest.version) ||
    manifest.platform !== "linux" ||
    manifest.arch !== "x64" ||
    manifest.libc !== "glibc"
  )
    throw new Error("Unsupported HarnessHub release manifest");
  const actual = inventory(resolve(root));
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files))
    throw new Error("Payload integrity check failed; download the complete release again");
  for (const name of [
    "runtime/node",
    "runtime/bun",
    "dist/cli/hhu.js",
    "dist/daemon/index.js",
    "lib/install.js",
  ])
    if (!actual[name]) throw new Error(`Missing payload: ${name}`);
  return manifest;
}
