import type { Element, RootContent } from "hast";
import { common, createLowlight } from "lowlight";
import { createElement, memo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { DesktopApi } from "../contracts";
import { call } from "./drafts";

const highlighter = createLowlight(common);
function highlightNode(node: RootContent, index: number): ReactNode {
  if (node.type === "text") return node.value;
  if (node.type !== "element") return null;
  const element = node as Element;
  // lowlight emits spans/text only; no HTML injection or user-provided attributes.
  return createElement(
    "span",
    {
      key: index,
      className: Array.isArray(element.properties.className)
        ? element.properties.className.join(" ")
        : undefined,
    },
    element.children.map(highlightNode),
  );
}
export function Copy({ text, api }: { text: string; api: DesktopApi }) {
  return (
    <button
      type="button"
      title="复制完整原文"
      onClick={(event) => {
        const button = event.currentTarget;
        void call(api, { type: "clipboard.copy", text }).then(
          () => {
            button.textContent = "已复制";
          },
          () => {
            button.textContent = "复制失败";
          },
        );
      }}
    >
      复制
    </button>
  );
}
export const Markdown = memo(function Markdown({ text, api }: { text: string; api: DesktopApi }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          // Links remain inert and copyable. No external navigation, requests or images.
          a: ({ children, href }) => (
            <span className="safe-link" title={href}>
              {children}
              {href ? ` (${href})` : ""}
            </span>
          ),
          img: ({ alt }) => <span>[图片：{alt ?? "ACP image"}]</span>,
          code: ({ children, className }) => {
            const source = String(children);
            const language = /language-([\w+-]+)/.exec(className ?? "")?.[1];
            const tree =
              language && highlighter.registered(language) && source.length < 100000
                ? highlighter.highlight(language, source)
                : null;
            return (
              <code className={className}>
                {tree ? tree.children.map(highlightNode) : children}
              </code>
            );
          },
          pre: ({ children }) => (
            <div className="code-block">
              <Copy text={codeText(children)} api={api} />
              <pre>{children}</pre>
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
function codeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(codeText).join("");
  if (node && typeof node === "object" && "props" in node)
    return codeText((node.props as { children?: ReactNode }).children);
  return "";
}

export const Syntax = memo(function Syntax({ text, path }: { text: string; path: string }) {
  const ext = path.split(".").at(-1)?.toLowerCase() ?? "";
  const languages: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    py: "python",
    rs: "rust",
    sh: "bash",
    css: "css",
    json: "json",
    go: "go",
    html: "xml",
    md: "markdown",
    yml: "yaml",
    yaml: "yaml",
  };
  const language = languages[ext];
  const tree =
    language && highlighter.registered(language) && text.length < 2000
      ? highlighter.highlight(language, text)
      : null;
  return <>{tree ? tree.children.map(highlightNode) : text}</>;
});
