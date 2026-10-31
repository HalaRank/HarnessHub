import { SyntaxStyle } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { For, onCleanup, Show } from "solid-js";
import { object, pretty, type TerminalContent } from "./transcript";

export function useSyntax() {
  const style = SyntaxStyle.fromStyles(
    {
      default: { fg: "#d4d4d8" },
      "markup.heading": { fg: "#a5d6ff", bold: true },
      "markup.heading.1": { fg: "#a5d6ff", bold: true },
      "markup.strong": { bold: true },
      "markup.italic": { italic: true },
      "markup.raw": { fg: "#a5d6a7" },
      "markup.link": { fg: "#80cbc4", underline: true },
      "markup.list": { fg: "#80cbc4" },
      "punctuation.special": { fg: "#90a4ae" },
      comment: { fg: "#8b949e", italic: true },
      keyword: { fg: "#c5a5ff" },
      string: { fg: "#a5d6a7" },
      number: { fg: "#ffcc80" },
      function: { fg: "#a5d6ff" },
      type: { fg: "#80cbc4" },
      operator: { fg: "#ffab91" },
    },
    useRenderer().nativeScene,
  );
  onCleanup(() => style.destroy());
  return style;
}
export function Markdown(props: { text: string; streaming?: boolean }) {
  const syntax = useSyntax();
  return (
    <markdown
      content={props.text}
      syntaxStyle={syntax}
      concealCode={false}
      streaming={props.streaming ?? false}
      flexShrink={0}
      tableOptions={{ style: "grid", selectable: true, wrapMode: "word" }}
    />
  );
}
export function UnifiedDiff(props: { value: string; path?: string }) {
  const syntax = useSyntax();
  const filetype = () =>
    ({
      ts: "typescript",
      tsx: "tsx",
      js: "javascript",
      mjs: "javascript",
      py: "python",
      json: "json",
      sh: "bash",
      md: "markdown",
    })[props.path?.split(".").at(-1) ?? ""];
  return (
    <diff
      diff={props.value}
      view="unified"
      {...(filetype() ? { filetype: filetype() as string } : {})}
      syntaxStyle={syntax}
      addedBg="#142b20"
      addedContentBg="#142b20"
      removedBg="#351b23"
      removedContentBg="#351b23"
      addedSignColor="#8fdf9f"
      removedSignColor="#ff8d96"
      showLineNumbers
      wrapMode="word"
      flexShrink={0}
    />
  );
}
export function nativeDiff(value: unknown) {
  const p = object(value);
  if (typeof p.diff === "string") return p.diff;
  if (typeof p.newText !== "string") return "";
  const old = typeof p.oldText === "string" ? p.oldText : "";
  const lines = (text: string) => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));
  const before = lines(old),
    after = lines(p.newText);
  const side = (items: string[], sign: string, text: string) =>
    items.map((line) => `${sign}${line}\n`).join("") +
    (items.length && !text.endsWith("\n") ? "\\ No newline at end of file\n" : "");
  return `--- ${String(p.path ?? "file")}\n+++ ${String(p.path ?? "file")}\n@@ -${before.length ? 1 : 0},${before.length} +${after.length ? 1 : 0},${after.length} @@\n${side(before, "-", old)}${side(after, "+", p.newText)}`;
}
export function ToolContent(props: {
  tool: Record<string, unknown>;
  terminals?: Record<string, TerminalContent>;
}) {
  return (
    <box flexDirection="column" gap={1}>
      <Show when={typeof props.tool.name === "string"}>
        <text>{String(props.tool.name)}</text>
      </Show>
      <For each={Object.entries(props.terminals ?? {})}>
        {([id, value]) => (
          <box flexDirection="column" flexShrink={0}>
            <text fg="#8b949e">{`Terminal ${id}`}</text>
            <Show when={value.info !== null}>
              <text selectable>{pretty(value.info)}</text>
            </Show>
            <text selectable flexShrink={0}>
              {value.output.slice(-24000)}
            </text>
            <Show when={value.output.length > 24000}>
              <text>
                Terminal preview: last 24,000 characters. y opens the complete original output.
              </text>
            </Show>
            <Show when={value.exit !== null}>
              <text selectable>{pretty(value.exit)}</text>
            </Show>
          </box>
        )}
      </For>
      <Show when={props.tool.rawInput !== undefined}>
        <text
          selectable
          flexShrink={0}
        >{`Parameters\n${pretty(props.tool.rawInput).slice(0, 24000)}`}</text>
      </Show>
      <Show when={props.tool.rawOutput !== undefined}>
        <text
          selectable
          flexShrink={0}
        >{`Result\n${pretty(props.tool.rawOutput).slice(0, 24000)}`}</text>
      </Show>
      <For each={Array.isArray(props.tool.content) ? props.tool.content : []}>
        {(entry) => {
          const block = object(entry),
            content = object(block.content);
          return (
            <Show
              when={block.type === "diff" && nativeDiff(block)}
              fallback={
                <Show
                  when={content.type === "text" && typeof content.text === "string"}
                  fallback={
                    <text selectable flexShrink={0}>
                      {pretty(block).slice(0, 24000)}
                    </text>
                  }
                >
                  <Markdown text={String(content.text).slice(0, 24000)} />
                </Show>
              }
            >
              <text>{String(block.path ?? "Diff")}</text>
              <UnifiedDiff
                value={nativeDiff(block).slice(0, 48000)}
                path={String(block.path ?? "")}
              />
            </Show>
          );
        }}
      </For>
      <text fg="#8b949e">
        Native details: r · Full output / code copy: y (large previews are bounded)
      </text>
    </box>
  );
}
export type SourcePart = { name: string; text: string };
export function sourceParts(
  text: string,
  tool: Record<string, unknown> | null,
  terminals: Record<string, TerminalContent> = {},
): SourcePart[] {
  const parts = [{ name: tool ? "Native tool JSON" : "Original Markdown / text", text }];
  for (const [id, terminal] of Object.entries(terminals))
    parts.push({ name: `Terminal ${id} output`, text: terminal.output });
  const blocks = tool && Array.isArray(tool.content) ? tool.content : [];
  if (tool?.rawInput !== undefined)
    parts.push({ name: "Native parameters", text: pretty(tool.rawInput) });
  if (tool?.rawOutput !== undefined)
    parts.push({ name: "Native tool output", text: pretty(tool.rawOutput) });
  for (const [i, block] of blocks.entries()) {
    const p = object(block),
      content = object(p.content);
    if (typeof content.text === "string")
      parts.push({ name: `Native content ${i + 1}`, text: content.text });
    if (p.type === "diff")
      parts.push({ name: `Diff ${String(p.path ?? i + 1)}`, text: nativeDiff(p) });
  }
  for (const source of [...parts]) {
    const regex = /^ {0,3}(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)^ {0,3}\1\s*$/gm;
    for (const match of source.text.matchAll(regex))
      parts.push({
        name: `Code ${parts.filter((p) => p.name.startsWith("Code ")).length + 1} ${match[2]?.trim() ?? ""}`,
        text: match[3] ?? "",
      });
  }
  return parts;
}
