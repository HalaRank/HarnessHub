import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { z } from "zod";

const settingsSchema = z.object({ distribution: z.string().min(1).max(256) }).strict();
export function loadDistribution(path: string): string | null {
  try {
    return settingsSchema.parse(JSON.parse(readFileSync(path, "utf8"))).distribution;
  } catch {
    return null;
  }
}
export function saveDistribution(path: string, distribution: string) {
  const data = settingsSchema.parse({ distribution });
  writeFileSync(`${path}.tmp`, JSON.stringify(data), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
