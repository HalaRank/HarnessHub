import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DesktopState, Distribution } from "../src/contracts";
import { WslEnvironment } from "../src/renderer/WslEnvironment";

const distributions: Distribution[] = [
  { name: "Ubuntu-26.04", version: 2, state: "Running", isDefault: true },
  { name: "Legacy", version: 1, state: "Stopped", isDefault: false },
];
const initial: DesktopState = {
  revision: 0,
  status: "idle",
  detail: "",
  distribution: null,
  snapshot: null,
  conversationId: null,
  events: [],
  historyLoading: false,
};
function render(update: Partial<DesktopState>) {
  return renderToStaticMarkup(
    <WslEnvironment
      state={{ ...initial, ...update }}
      distributions={distributions}
      discovering={false}
      connect={() => {
        throw new Error("Rendering must not connect");
      }}
      discover={() => {
        throw new Error("Rendering must not discover");
      }}
    />,
  );
}

test("unselected WSL environment offers a selector and disables WSL1 and connect", () => {
  const html = render({});
  expect(html).toContain('aria-label="WSL 发行版"');
  expect(html).toContain('<option value="Legacy" disabled="">');
  expect(html).toContain('<button type="button" disabled="">连接</button>');
  expect(html).not.toContain("wsl-current");
  expect(html).not.toContain("已连接");
});

test("connected WSL environment is a fixed summary with a checkmark and explicit switch", () => {
  const html = render({ status: "connected", distribution: "Ubuntu-26.04" });
  expect(html).toContain('class="wsl-current connected"');
  expect(html).toContain('title="Ubuntu-26.04">Ubuntu-26.04</strong>');
  expect(html).toContain("WSL2");
  expect(html).toContain("✓");
  expect(html).toContain("已连接");
  expect(html).toContain('aria-label="切换 WSL 执行环境"');
  expect(html).not.toContain("<select");
  expect(html).not.toContain("刷新发行版");
});

test("WSL summary retains the bound environment and reports actual connection failures", () => {
  for (const [status, label] of [
    ["starting", "连接中…"],
    ["disconnected", "已断开"],
    ["incompatible", "版本不兼容"],
    ["error", "连接失败"],
  ] as const) {
    const html = render({ status, distribution: "Ubuntu-26.04" });
    expect(html).toContain(`class="wsl-current ${status}"`);
    expect(html).toContain("Ubuntu-26.04");
    expect(html).toContain(label);
    expect(html).not.toContain("已连接");
    expect(html).not.toContain("✓");
    if (status === "starting") expect(html).toContain('aria-label="切换 WSL 执行环境" disabled=""');
  }
});
