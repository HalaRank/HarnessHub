import { dirname, join } from "node:path";
import type { Paths } from "../packages/shared/src/paths";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
// Only HarnessHub's own install environment is captured. No native Harness configs are read.
export function bridgeLauncher(bun: string, release: string, linuxPath: string, paths: Paths) {
  return `#!/bin/sh
# HarnessHub desktop bridge launcher
export PATH=${quote(linuxPath)}
export XDG_CONFIG_HOME=${quote(dirname(paths.config))}
export XDG_DATA_HOME=${quote(dirname(paths.data))}
export XDG_STATE_HOME=${quote(dirname(paths.state))}
exec ${quote(bun)} ${quote(join(release, "cli/hhu.js"))} desktop-bridge "$@"
`;
}
