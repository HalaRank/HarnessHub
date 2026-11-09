// A main-frame identity check plus exact packaged document URL. Never trust only origin,
// file: scheme, a renderer-supplied URL, or a frame in another window.
export function trustedSender(
  event: { sender: unknown; senderFrame: unknown },
  expected: { contents: unknown; frame: unknown; url: string },
  frameUrl: string | undefined,
): boolean {
  return (
    event.sender === expected.contents &&
    event.senderFrame === expected.frame &&
    frameUrl === expected.url
  );
}
export const windowSecurity = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
} as const;
