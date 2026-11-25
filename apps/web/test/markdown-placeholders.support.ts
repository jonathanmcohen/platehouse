// The bare-placeholder check of markdown-placeholders.test.ts, apart from
// vitest so a script can run it over other text too (a PR body before it is
// posted). Plain TypeScript that Node runs as it is (type stripping).
//
// The Markdown is parsed, not matched with regexes (issue #308): a
// CommonMark parser with GitHub's extensions (mdast-util-from-markdown with
// micromark-extension-gfm and mdast-util-gfm) builds the same tree GitHub
// renders from, and every raw HTML node in it is reported. GitHub drops raw
// HTML it does not allow, so a placeholder written bare, such as <id> or
// <run number>, is an html node and is lost on the page. Text inside a code
// span or a code block is code, never html, wherever the span starts and ends
// (across lines, list items and headings alike), and an autolink such as
// <https://example.com> parses as a link, so neither needs a rule here.
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

/**
 * HTML tags a tracked Markdown file uses on purpose, by tag name, each with
 * its reason. Keep it short: a placeholder never belongs here.
 */
export const ALLOWED_TAGS: Record<string, string> = {
  img: "README.md's first line shows the logo at a fixed size, which Markdown image syntax cannot set",
};

/** One raw HTML node: its line and its text (the first line, for a block). */
export interface HtmlNode {
  line: number;
  html: string;
  /** The tag name, lowercased, or "" for a comment or other markup. */
  tag: string;
  /**
   * True when the node is one tag and nothing else. An HTML block that opens
   * with a complete tag alone on its line runs to the next blank line, so it
   * can carry text, a bare placeholder included, after that first tag.
   */
  single: boolean;
}

interface TreeNode {
  type: string;
  value?: string;
  position?: { start: { line: number; column: number } };
  children?: TreeNode[];
}

/** Every raw HTML node GitHub's Markdown parser finds in a text, in document order. */
export function htmlNodes(markdown: string): HtmlNode[] {
  const tree = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  }) as TreeNode;
  const found: Array<HtmlNode & { column: number }> = [];
  const walk = (node: TreeNode) => {
    if (node.type === "html") {
      const whole = (node.value ?? "").trim();
      const html = whole.split("\n")[0]?.trim() ?? "";
      found.push({
        single: /^<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>$/.test(whole),
        line: node.position?.start.line ?? 0,
        column: node.position?.start.column ?? 0,
        html,
        tag: html.match(/^<\/?([A-Za-z][A-Za-z0-9-]*)/)?.[1]?.toLowerCase() ?? "",
      });
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree);
  return found
    .sort((a, b) => a.line - b.line || a.column - b.column)
    .map(({ line, html, tag, single }) => ({ line, html, tag, single }));
}

/** Each raw HTML node GitHub would strip from a Markdown text, as "label:line: <tag>". */
export function barePlaceholders(label: string, markdown: string): string[] {
  return (
    htmlNodes(markdown)
      // Object.hasOwn, not "in": "in" also finds Object.prototype's keys, so
      // a bare <constructor> would pass as an allowed tag.
      .filter((n) => !(n.single && Object.hasOwn(ALLOWED_TAGS, n.tag)))
      .map((n) => `${label}:${n.line}: ${n.html}${n.single ? "" : " ..."}`)
  );
}
