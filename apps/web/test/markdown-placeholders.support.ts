// The bare-placeholder check of markdown-placeholders.test.ts, apart from
// vitest so a script can run it over other text too (a PR body before it is
// posted). Plain TypeScript that Node runs as it is (type stripping).

/**
 * HTML tags a tracked Markdown file uses on purpose, by tag name, each with
 * its reason. Keep it short: a placeholder never belongs here.
 */
export const ALLOWED_TAGS: Record<string, string> = {
  img: "README.md's first line shows the logo at a fixed size, which Markdown image syntax cannot set",
};

/** The text GitHub shows as prose: fenced code blocks and code spans taken out, line numbers kept. */
export function proseOnly(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const open = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence === null && open) {
      fence = open[1] as string;
      out.push("");
      continue;
    }
    if (fence !== null) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (close && close[1]?.[0] === fence[0] && (close[1]?.length ?? 0) >= fence.length)
        fence = null;
      out.push("");
      continue;
    }
    out.push(line);
  }
  // A code span is a run of backticks closed by a run of the same length; it
  // may hold shorter runs. Spans can cross a line break inside a paragraph.
  return out.join("\n").replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (m) => m.replace(/[^\n]/g, " "));
}

const TAG = /<\/?[A-Za-z][^<>]*>/g;
const AUTOLINK = /^<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*|[^\s<>@]+@[^\s<>@]+)>$/;

/** Each bare tag in a Markdown text, as "label:line: <tag>". */
export function barePlaceholders(label: string, markdown: string): string[] {
  const prose = proseOnly(markdown);
  const hits: string[] = [];
  for (const m of prose.matchAll(TAG)) {
    const tag = m[0];
    if (AUTOLINK.test(tag)) continue;
    const name = tag.match(/^<\/?([A-Za-z][A-Za-z0-9-]*)/)?.[1]?.toLowerCase() ?? "";
    if (name in ALLOWED_TAGS) continue;
    const line = prose.slice(0, m.index).split("\n").length;
    hits.push(`${label}:${line}: ${tag}`);
  }
  return hits;
}
