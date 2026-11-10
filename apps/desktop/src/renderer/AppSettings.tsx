import { useEffect, useRef, useState } from "react";
import type { DesktopApi, DesktopState, Distribution } from "../contracts";
import { Environment } from "./Environment";
import { Worktrees } from "./Worktrees";
import { WslEnvironment } from "./WslEnvironment";

export function AppSettings({
  api,
  state,
  distributions,
  discovering,
  error,
  connect,
  discover,
  close,
}: {
  api: DesktopApi;
  state: DesktopState;
  distributions: Distribution[];
  discovering: boolean;
  error: string;
  connect: (distribution: string) => void;
  discover: () => void;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [section, setSection] = useState<"environment" | "worktrees">("environment");
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="app-settings"
      aria-label="应用设置"
      onCancel={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        close();
      }}
    >
      <header className="settings-header">
        <h2>应用设置</h2>
        <button type="button" className="icon" aria-label="关闭应用设置" onClick={close}>
          ×
        </button>
      </header>
      <nav className="settings-nav" aria-label="设置分类">
        <button
          type="button"
          aria-pressed={section === "environment"}
          onClick={() => setSection("environment")}
        >
          环境与安装指南
        </button>
        <button
          type="button"
          aria-pressed={section === "worktrees"}
          onClick={() => setSection("worktrees")}
        >
          工作区管理
        </button>
      </nav>
      <div className="settings-content">
        {error && <p role="alert">{error}</p>}
        {section === "environment" ? (
          <>
            <WslEnvironment
              state={state}
              distributions={distributions}
              discovering={discovering}
              connect={connect}
              discover={discover}
            />
            {state.status !== "connected" && <p role="status">{state.detail}</p>}
            <Environment state={state} />
          </>
        ) : (
          <Worktrees
            key={state.distribution}
            api={api}
            conversations={state.snapshot?.conversations ?? []}
            connected={state.status === "connected"}
          />
        )}
      </div>
    </dialog>
  );
}
