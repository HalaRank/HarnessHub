import type { WorkspaceLocation } from "@harnesshub/shared";
import { useRef, useState } from "react";
import type { DesktopApi } from "../contracts";
import { call } from "./drafts";
import { Copy } from "./Markdown";
export function PathActions({
  api,
  conversationId,
  path,
  location,
}: {
  api: DesktopApi;
  conversationId: string;
  path: string;
  location: WorkspaceLocation;
}) {
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  return (
    <span className="path-actions">
      <Copy text={path} api={api} />
      <button
        type="button"
        title="在 Windows Explorer 打开 WSL 文件夹"
        onClick={() => {
          if (lock.current) return;
          lock.current = true;
          setError("");
          setOpened(false);
          void call(api, { type: "workspace.open", conversationId, location })
            .then(() => setOpened(true))
            .catch((e) => setError(String(e)))
            .finally(() => {
              lock.current = false;
            });
        }}
      >
        打开文件夹
      </button>
      {opened && <span role="status">已打开</span>}
      {error && <span role="alert">{error}</span>}
    </span>
  );
}
