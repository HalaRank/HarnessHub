// This conversion is solely for folder navigation, never for ACP cwd.
export function explorerFolder(distribution: string, linuxPath: string): string {
  const safe = (part: string) =>
    part.length > 0 &&
    Array.from(part).every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127) &&
    !/[\\/:*?"<>|]/.test(part) &&
    part !== "." &&
    part !== ".." &&
    !/[. ]$/.test(part);
  if (!safe(distribution) || !linuxPath.startsWith("/") || linuxPath.startsWith("//"))
    throw new Error("无法安全转换此 WSL 路径；请复制 Linux 路径。");
  const parts = linuxPath === "/" ? [] : linuxPath.slice(1).split("/");
  if (!parts.every(safe)) throw new Error("Windows 无法无歧义定位此名称；请复制 Linux 路径。");
  return `\\\\wsl.localhost\\${distribution}\\${parts.join("\\")}`;
}
