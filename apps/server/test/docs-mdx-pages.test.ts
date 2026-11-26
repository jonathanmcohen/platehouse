// Six docs pages are MDX, so they can render the shared allowlist warning
// (docs/reverse-proxy/_allowlist-warning.md). MDX turns {expressions},
// import and export lines and JSX into JavaScript that runs when the site is
// built and again in every reader's browser, and a CommonMark guard sees none
// of it as code. So each of the six pages is parsed with MDX's own parser, the
// one Docusaurus compiles them with, and may hold exactly one import of the
// warning and one <AllowlistWarning /> with no attributes, and nothing else
// that MDX would run. No other docs page may switch to MDX, and no docs page
// may use front matter or a fence that would let it in by another door.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { createProcessor } from "@mdx-js/mdx";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const MDX_PAGES: Record<string, string> = {
  "docs/security.md": 'import AllowlistWarning from "./reverse-proxy/_allowlist-warning.md";',
  "docs/reverse-proxy/nginx.md": 'import AllowlistWarning from "./_allowlist-warning.md";',
  "docs/reverse-proxy/caddy.md": 'import AllowlistWarning from "./_allowlist-warning.md";',
  "docs/reverse-proxy/traefik.md": 'import AllowlistWarning from "./_allowlist-warning.md";',
  "docs/reverse-proxy/apache.md": 'import AllowlistWarning from "./_allowlist-warning.md";',
  "docs/reverse-proxy/checklist.md": 'import AllowlistWarning from "./_allowlist-warning.md";',
};

interface MdxNode {
  type: string;
  value?: string;
  name?: string | null;
  attributes?: unknown[];
  children?: MdxNode[];
  position?: { start: { line: number } };
}

/**
 * A page's front matter as gray-matter, which Docusaurus reads it with, finds
 * it: from an opening "---" at the very start to the next line that starts
 * with "---". Null when the page has none. The end is where the page's body
 * starts. The opening line itself is checked by frontMatterProblems.
 */
function frontMatter(text: string): { opener: string; yaml: string; end: number } | null {
  if (!text.startsWith("---") || text.charAt(3) === "-") return null;
  const firstBreak = text.indexOf("\n");
  const opener = firstBreak === -1 ? text : text.slice(0, firstBreak);
  const close = text.indexOf("\n---", opener.length);
  if (close === -1) return { opener, yaml: text.slice(opener.length), end: text.length };
  const lineEnd = text.indexOf("\n", close + 1);
  return {
    opener,
    yaml: text.slice(opener.length, close),
    end: lineEnd === -1 ? text.length : lineEnd + 1,
  };
}

/**
 * Why a docs page's front matter or fences could let MDX in, as a list; empty
 * when it is plain. Every page: no carriage return or byte order mark (either
 * changes how gray-matter splits the page), an opening line of exactly "---"
 * (gray-matter takes ---json, ---js and others as an engine, and eval's ---js
 * while the site builds), front matter that parses as YAML, and no
 * mdx-code-block fence (Docusaurus unwraps those before MDX compiles the
 * page). The YAML is parsed, so a quoted key, a tag, an alias or an escape
 * still shows as an mdx key: a page not allowed MDX has none, and an allowed
 * page's is exactly { format: "mdx" }.
 */
function frontMatterProblems(text: string, mdxAllowed: boolean): string[] {
  const problems: string[] = [];
  if (text.includes("\r")) problems.push("holds a carriage return");
  if (text.startsWith("\uFEFF")) problems.push("starts with a byte order mark");
  if (text.includes("mdx-code-block")) problems.push("holds an mdx-code-block fence");
  const front = frontMatter(text);
  if (text.startsWith("---") && front?.opener !== "---") {
    problems.push(`its first line is ${JSON.stringify(text.split("\n")[0])}, not exactly ---`);
    return problems;
  }
  let data: unknown = null;
  try {
    data = front ? parseYaml(front.yaml) : null;
  } catch (e) {
    problems.push(
      `its front matter is not YAML: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`,
    );
    return problems;
  }
  const hasMdx = typeof data === "object" && data !== null && Object.hasOwn(data, "mdx");
  if (!mdxAllowed && hasMdx) problems.push("its front matter has an mdx key");
  if (
    mdxAllowed &&
    !(hasMdx && isDeepStrictEqual((data as { mdx: unknown }).mdx, { format: "mdx" }))
  )
    problems.push("its front matter's mdx key is not exactly { format: mdx }");
  return problems;
}

/**
 * Each MDX construct in a page that is not the one allowed import or the one
 * bare <AllowlistWarning />, as "line N: what". Empty when the page is clean.
 */
function mdxProblems(text: string, allowedImport: string): string[] {
  const front = text.slice(0, frontMatter(text)?.end ?? 0);
  // Blank lines keep the line numbers the same as in the file.
  const body = "\n".repeat(front.split("\n").length - 1) + text.slice(front.length);
  const tree = createProcessor().parse(body) as MdxNode;
  const problems: string[] = [];
  let imports = 0;
  let warnings = 0;
  const walk = (node: MdxNode) => {
    const at = `line ${node.position?.start.line ?? 0}`;
    if (node.type === "mdxjsEsm") {
      if (node.value?.trim() === allowedImport && imports === 0) imports++;
      else problems.push(`${at}: import or export ${JSON.stringify(node.value)}`);
    } else if (node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") {
      const bare =
        node.type === "mdxJsxFlowElement" &&
        node.name === "AllowlistWarning" &&
        node.attributes?.length === 0 &&
        (node.children ?? []).length === 0;
      if (bare && warnings === 0) warnings++;
      else problems.push(`${at}: JSX <${node.name ?? ""}>`);
    } else if (node.type.startsWith("mdx")) {
      problems.push(`${at}: ${node.type} ${JSON.stringify(node.value)}`);
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree);
  if (imports !== 1) problems.push(`the import ${allowedImport} is missing`);
  if (warnings !== 1) problems.push("<AllowlistWarning /> is missing");
  return problems;
}

/** Every file under docs/, as paths from the repo root. */
function docsFiles(dir = join(ROOT, "docs")): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? docsFiles(path) : [relative(ROOT, path)];
  });
}

const PAGE = [
  "---",
  "description: A page.",
  "mdx:",
  "  format: mdx",
  "---",
  "",
  'import AllowlistWarning from "./_allowlist-warning.md";',
  "",
  "Some prose with `{{.Server.Version}}` in a code span.",
  "",
  "```sh",
  "docker version --format '{{.Server.Version}}'",
  "```",
  "",
  "<AllowlistWarning />",
  "",
].join("\n");
const IMPORT = 'import AllowlistWarning from "./_allowlist-warning.md";';

describe("the MDX docs pages", () => {
  it("a page with only the import and the bare warning is clean, code spans and blocks included", () => {
    expect(mdxProblems(PAGE, IMPORT)).toEqual([]);
  });

  it.each([
    ["an expression in prose", "A line with {fetch('https://x.example')} in it.\n"],
    ["an expression on its own line", "{(() => 1)()}\n"],
    ["an export", "export const x = 1;\n"],
    ["a second import", 'import Other from "./other.md";\n'],
    ["another component", "<Other />\n"],
    ["inline JSX", "Text with <span>inline</span> JSX.\n"],
    ["a second warning", "<AllowlistWarning />\n"],
  ])("refuses %s", (_name, extra) => {
    expect(mdxProblems(`${PAGE}\n${extra}`, IMPORT)).not.toEqual([]);
  });

  it.each([
    ["an attribute", '<AllowlistWarning tone="loud" />'],
    ["an attribute expression", "<AllowlistWarning {...props} />"],
    ["children", "<AllowlistWarning>text</AllowlistWarning>"],
  ])("refuses the warning with %s", (_name, element) => {
    expect(mdxProblems(PAGE.replace("<AllowlistWarning />", element), IMPORT)).not.toEqual([]);
  });

  it("refuses an import of anything else in place of the warning's", () => {
    const page = PAGE.replace(IMPORT, 'import AllowlistWarning from "https://x.example/w.js";');
    expect(mdxProblems(page, IMPORT)).not.toEqual([]);
  });

  it("a page without an mdx key, or an allowed page with mdx: format: mdx, passes the front matter check", () => {
    expect(frontMatterProblems("---\ndescription: A page.\n---\n\nText.\n", false)).toEqual([]);
    expect(frontMatterProblems("No front matter.\n", false)).toEqual([]);
    expect(frontMatterProblems(PAGE, true)).toEqual([]);
  });

  // Docusaurus reads front matter with gray-matter, which takes any of these
  // as mdx.format: "mdx", or runs another engine (---js is eval'd while the
  // site builds). Each one must be refused on a page not allowed MDX.
  it.each([
    ["the plain spelling", "---\nmdx:\n  format: mdx\n---\n"],
    ["a quoted key in a flow map", '---\nmdx: {"format": "mdx"}\n---\n'],
    ["a single-quoted key", "---\nmdx:\n  'format': mdx\n---\n"],
    ["a YAML tag", "---\nmdx:\n  format: !!str mdx\n---\n"],
    ["an alias", "---\nkind: &a mdx\nmdx:\n  format: *a\n---\n"],
    ["an escaped value", '---\nmdx:\n  format: "\\x6ddx"\n---\n'],
    ["an escaped key", '---\n"\\x6ddx": {format: mdx}\n---\n'],
    ["an mdx key with no format", "---\nmdx: {}\n---\n"],
    ["CRLF line endings", "---\r\nmdx:\r\n  format: mdx\r\n---\r\n"],
    ["a carriage return anywhere", "---\ndescription: A page.\n---\n\nText.\r\n"],
    ["JSON front matter", '---json\n{"mdx": {"format": "mdx"}}\n---\n'],
    ["JavaScript front matter", '---js\n{ mdx: { format: "mdx" } }\n---\n'],
    ["a byte order mark before the front matter", "\uFEFF---js\n{}\n---\n"],
    ["front matter that is not valid YAML", "---\nmdx: [\n---\n"],
  ])("refuses %s on a page not allowed MDX", (_name, text) => {
    expect(frontMatterProblems(text, false)).not.toEqual([]);
  });

  it("refuses an allowed page whose mdx key says anything but format: mdx", () => {
    expect(
      frontMatterProblems(PAGE.replace("  format: mdx", "  format: mdx\n  other: 1"), true),
    ).not.toEqual([]);
    expect(
      frontMatterProblems(PAGE.replace("---\ndescription", "---js\ndescription"), true),
    ).not.toEqual([]);
  });

  // Docusaurus unwraps mdx-code-block fences before MDX compiles a page, so
  // code in one runs though it looks like a code block. No docs page needs
  // one, so the fence is refused outright, in every docs file.
  it("refuses an mdx-code-block fence holding an export and an onClick element", () => {
    const hidden = [
      "```mdx-code-block",
      "export const x = 1;",
      "",
      "<div onClick={() => alert(1)}>Click</div>",
      "```",
      "",
    ].join("\n");
    expect(
      mdxProblems(`${PAGE}\n${hidden}`, IMPORT),
      "the raw parse sees only a code block",
    ).toEqual([]);
    expect(frontMatterProblems(`${PAGE}\n${hidden}`, true)).not.toEqual([]);
    expect(
      frontMatterProblems(
        `Text.\n\n${hidden.replace("```mdx", "````mdx").replace(/```\n$/, "````\n")}`,
        false,
      ),
    ).not.toEqual([]);
  });

  it.each(Object.entries(MDX_PAGES))("%s holds no MDX but the warning", (path, allowedImport) => {
    const text = readFileSync(join(ROOT, path), "utf8");
    expect(frontMatterProblems(text, true)).toEqual([]);
    expect(mdxProblems(text, allowedImport)).toEqual([]);
  });

  it("no other docs page is MDX, and every docs page's front matter is plain YAML", () => {
    const pages = docsFiles().filter((path) => path.endsWith(".md") || path.endsWith(".mdx"));
    expect(pages.filter((path) => path.endsWith(".mdx"))).toEqual([]);
    const problems = pages.flatMap((path) =>
      frontMatterProblems(readFileSync(join(ROOT, path), "utf8"), path in MDX_PAGES).map(
        (p) => `${path}: ${p}`,
      ),
    );
    expect(problems).toEqual([]);
  });

  it("Docusaurus reads every other page as CommonMark", () => {
    const config = readFileSync(join(ROOT, "apps/docs/docusaurus.config.mjs"), "utf8");
    expect(config).toMatch(/\n {2}markdown: \{\n {4}format: "detect",\n/);
  });
});
