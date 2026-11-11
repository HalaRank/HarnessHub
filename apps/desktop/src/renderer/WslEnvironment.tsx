import { useEffect, useState } from "react";
import type { DesktopState, Distribution } from "../contracts";
import { Select } from "./Select";

const connectionLabels = {
  idle: "未连接",
  starting: "连接中…",
  connected: "已连接",
  disconnected: "已断开",
  incompatible: "版本不兼容",
  error: "连接失败",
};

export function WslEnvironment({
  state,
  distributions,
  discovering,
  connect,
  discover,
}: {
  state: DesktopState;
  distributions: Distribution[];
  discovering: boolean;
  connect: (distribution: string) => void;
  discover: () => void;
}) {
  const [choice, setChoice] = useState(state.distribution ?? "");
  const [editing, setEditing] = useState(false);
  const starting = state.status === "starting";
  const fixed = !!state.distribution && !editing;
  const available = distributions.some((d) => d.name === choice && d.version === 2);

  useEffect(() => {
    if (state.distribution) setChoice(state.distribution);
  }, [state.distribution]);
  useEffect(() => {
    if (state.status === "connected") setEditing(false);
  }, [state.status]);

  return (
    <section className={`wsl-environment${fixed ? " is-fixed" : ""}`} aria-label="WSL 执行环境">
      {!fixed && (
        <div className="wsl-heading">
          <span>WSL 执行环境</span>
        </div>
      )}
      {fixed ? (
        <div className={`wsl-current ${state.status}`}>
          <div className="wsl-identity">
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <rect x="2" y="3" width="16" height="14" rx="3" />
              <path d="m6 7 3 3-3 3m5 0h3" />
            </svg>
            <strong title={state.distribution ?? undefined}>{state.distribution}</strong>
          </div>
          <button
            type="button"
            className="text-button"
            aria-label="切换 WSL 执行环境"
            disabled={starting}
            onClick={() => setEditing(true)}
          >
            切换
          </button>
          <div className="wsl-state" role="status">
            <span className="wsl-state-mark" aria-hidden="true">
              {state.status === "connected" ? "✓" : "●"}
            </span>
            {connectionLabels[state.status]}
            <span className="wsl-version">· WSL2</span>
          </div>
        </div>
      ) : (
        <>
          {editing && state.distribution && (
            <p className="wsl-editing-current" title={state.distribution}>
              当前环境 · {state.distribution}
            </p>
          )}
          <div className={`distribution-row ${choice ? "has-choice" : ""}`}>
            <Select
              id="distribution"
              aria-label="WSL 发行版"
              value={choice}
              disabled={starting}
              onChange={(event) => setChoice(event.target.value)}
            >
              <option value="">{discovering ? "正在发现…" : "选择 WSL2 发行版"}</option>
              {choice && !distributions.some((d) => d.name === choice) && (
                <option value={choice} disabled>
                  {choice} · 未发现
                </option>
              )}
              {distributions.map((d) => (
                <option key={d.name} value={d.name} disabled={d.version !== 2}>
                  {d.name} · WSL{d.version}
                </option>
              ))}
            </Select>
            <button type="button" disabled={!available || starting} onClick={() => connect(choice)}>
              {starting ? "连接中…" : "连接"}
            </button>
          </div>
          <div className="wsl-actions">
            <button
              type="button"
              className="text-button"
              disabled={discovering || starting}
              onClick={discover}
            >
              刷新发行版
            </button>
            {editing && state.distribution && (
              <button
                type="button"
                className="text-button"
                disabled={starting}
                onClick={() => {
                  setChoice(state.distribution ?? "");
                  setEditing(false);
                }}
              >
                取消
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
