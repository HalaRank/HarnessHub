import { SyntaxStyle } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { createMemo, For, onCleanup, Show } from "solid-js";
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
  expanded?: boolean;
}) {
  const blocks = () => (Array.isArray(props.tool.content) ? props.tool.content : []);
  const preview = createMemo(() => {
    const text = [
      ...Object.values(props.terminals ?? {}).map((terminal) => terminal.output),
      ...blocks().map((entry) => {
        const content = object(object(entry).content);
        return content.type === "text" && typeof content.text === "string" ? content.text : "";
      }),
    ]
      .filter(Boolean)
      .join("\n")
      .replace(/\r\n/g, "\n")
      .replace(/\n+$/, "");
    const lines = text ? text.split("\n") : [];
    return { lines: lines.slice(-3), omitted: Math.max(0, lines.length - 3) };
  });
  const command = () => {
    const input = object(props.tool.rawInput);
    const text = typeof input.command === "string" ? input.command : String(props.tool.title ?? "");
    return text !== props.tool.title || text.includes("\n") || text.length > 120 ? text : "";
  };
  return (
    <box flexDirection="row" flexShrink={0}>
      <text width={2} flexShrink={0} fg="#8b949e">
        └
      </text>
      <box flexDirection="column" flexGrow={1} flexBasis={0} minWidth={0}>
        <Show
          when={props.expanded}
          fallback={
            <>
              <For each={preview().lines}>
                {(line) => (
                  <text fg="#8b949e" height={1} wrapMode="none" truncate selectable>
                    {line}
                  </text>
                )}
              </For>
              <text fg="#8b949e" height={1} wrapMode="none" truncate>
                {preview().omitted ? `+ ${preview().omitted} lines` : "+ Show details"}
              </text>
            </>
          }
        >
          <Show when={command()}>
            <text selectable flexShrink={0}>
              {command().slice(0, 24000)}
            </text>
          </Show>
          <For each={Object.values(props.terminals ?? {})}>
            {(value) => (
              <Show when={value.output}>
                <text selectable flexShrink={0}>
                  {value.output.slice(-24000)}
                </text>
              </Show>
            )}
          </For>
          <Show when={typeof props.tool.rawOutput === "string"}>
            <text selectable flexShrink={0}>
              {String(props.tool.rawOutput).slice(0, 24000)}
            </text>
          </Show>
          <For each={blocks()}>
            {(entry) => {
              const block = object(entry),
                content = object(block.content);
              return (
                <Show
                  when={block.type === "diff" && nativeDiff(block)}
                  fallback={
                    <Show when={content.type === "text" && typeof content.text === "string"}>
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
          <text fg="#8b949e" height={1} wrapMode="none" truncate>
            − Show less · Full source: Ctrl+R / Ctrl+Y
          </text>
        </Show>
      </box>
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
