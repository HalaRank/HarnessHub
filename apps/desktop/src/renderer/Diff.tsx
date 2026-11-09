import { memo, useMemo, useState } from "react";
import type { DesktopApi } from "../contracts";
import { Copy, Syntax } from "./Markdown";

export type DiffBlock = { title: string; lines: string[] };
export function diffBlocks(text: string): DiffBlock[] {
  const blocks: DiffBlock[] = [];
  for (const line of text.split("\n")) {
    if (!blocks.length || line.startsWith("@@"))
      blocks.push({ title: line.startsWith("@@") ? line : "文件头", lines: [] });
    blocks.at(-1)?.lines.push(line);
  }
  return blocks;
}
export const DiffLines = memo(function DiffLines({
  lines,
  path,
  unified = true,
}: {
  lines: string[];
  path: string;
  unified?: boolean;
}) {
  const [page, setPage] = useState(0);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(lines.length / 200) - 1));
  const start = currentPage * 200;
  return (
    <>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must scroll the code region. */}
      <section className="diff-code" tabIndex={0} aria-label="Diff 代码，可滚动">
        {lines.slice(start, start + 200).map((line, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: Immutable line positions, no row state.
            key={`${start + i}`}
            className={`diff-line ${unified && line.startsWith("+") ? "added" : unified && line.startsWith("-") ? "deleted" : ""}`}
          >
            <span className="line-number">{start + i + 1}</span>
            <code>
              <Syntax text={line} path={path} />
            </code>
          </div>
        ))}
      </section>
      {lines.length > 200 && (
        <div className="diff-pages">
          <button type="button" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>
            上一页行
          </button>
          <span>
            {start + 1}–{Math.min(start + 200, lines.length)} / {lines.length}
          </span>
          <button
            type="button"
            disabled={start + 200 >= lines.length}
            onClick={() => setPage(currentPage + 1)}
          >
            下一页行
          </button>
        </div>
      )}
    </>
  );
});
function Block({ block, path, initial }: { block: DiffBlock; path: string; initial: boolean }) {
  const [open, setOpen] = useState(initial);
  return (
    <section className="diff-block">
      <button
        type="button"
        className="diff-hunk"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? "⌄" : "›"} {block.title} · {block.lines.length} 行
      </button>
      {open && <DiffLines lines={block.lines} path={path} />}
    </section>
  );
}
export function UnifiedDiff({
  text,
  path,
  api,
  source,
}: {
  text: string;
  path: string;
  api: DesktopApi;
  source: string;
}) {
  const blocks = useMemo(() => diffBlocks(text), [text]);
  const [page, setPage] = useState(0);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(blocks.length / 30) - 1));
  return (
    <section className="diff-view" aria-label={source}>
      <div className="diff-heading">
        <strong>{source}</strong>
        <Copy text={text} api={api} />
      </div>
      <p className="file-path">{path}</p>
      {blocks.slice(currentPage * 30, currentPage * 30 + 30).map((block, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: Stable block positions within one file revision.
        <Block key={`${currentPage}:${i}`} block={block} path={path} initial={i < 2} />
      ))}
      {blocks.length > 30 && (
        <div className="diff-pages">
          <button type="button" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>
            上一组块
          </button>
          <span>
            {currentPage + 1} / {Math.ceil(blocks.length / 30)}
          </span>
          <button
            type="button"
            disabled={(currentPage + 1) * 30 >= blocks.length}
            onClick={() => setPage(currentPage + 1)}
          >
            下一组块
          </button>
        </div>
      )}
    </section>
  );
}
export function NativeDiff({
  content,
  api,
}: {
  content: Record<string, unknown>;
  api: DesktopApi;
}) {
  const path = String(content.path ?? "未提供路径");
  return (
    <section className="native-diff" aria-label="原生 ACP Diff（Agent 提供）">
      <strong>原生 ACP Diff（Agent 提供）</strong>
      <p className="file-path">{path}</p>
      {(["oldText", "newText"] as const).map((key) => (
        <details key={key}>
          <summary>{key === "oldText" ? "修改前 · oldText" : "修改后 · newText"}</summary>
          {typeof content[key] === "string" ? (
            <>
              <Copy text={content[key]} api={api} />
              <DiffLines lines={content[key].split("\n")} path={path} unified={false} />
            </>
          ) : (
            <p>Agent 未提供此内容</p>
          )}
        </details>
      ))}
    </section>
  );
}
