// Six docs pages are MDX, so they can render the shared allowlist warning
// (docs/reverse-proxy/_allowlist-warning.md). MDX turns {expressions},
// import and export lines and JSX into JavaScript that runs when the site is
// built and again in every reader's browser, and a CommonMark guard sees none
// of it as code. So each of the six pages is parsed with MDX's own parser, the
// one Docusaurus compiles them with, and may hold exactly one import of the
// warning and one <AllowlistWarning /> with no attributes, and nothing else
// that MDX would run. No other docs page may switch to MDX.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createProcessor } from "@mdx-js/mdx";
import { describe, expect, it } from "vitest";

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

const FRONT_MATTER = /^---\n([\s\S]*?)\n---\n/;

/** Whether a page's front matter makes Docusaurus read it as MDX. */
const asksForMdx = (text: string): boolean =>
  /\bformat\s*:\s*["']?mdx\b/.test(FRONT_MATTER.exec(text)?.[1] ?? "");

/**
 * Each MDX construct in a page that is not the one allowed import or the one
 * bare <AllowlistWarning />, as "line N: what". Empty when the page is clean.
 */
function mdxProblems(text: string, allowedImport: string): string[] {
  const front = FRONT_MATTER.exec(text)?.[0] ?? "";
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

  it("reads mdx: format: mdx in its usual spellings", () => {
    expect(asksForMdx("---\nmdx:\n  format: mdx\n---\n")).toBe(true);
    expect(asksForMdx('---\nmdx: { format: "mdx" }\n---\n')).toBe(true);
    expect(asksForMdx("---\ndescription: A page.\n---\n")).toBe(false);
  });

  it.each(Object.entries(MDX_PAGES))("%s holds no MDX but the warning", (path, allowedImport) => {
    const text = readFileSync(join(ROOT, path), "utf8");
    expect(asksForMdx(text), `${path} asks for MDX`).toBe(true);
    expect(mdxProblems(text, allowedImport)).toEqual([]);
  });

  it("no other docs page is MDX", () => {
    const others = docsFiles().filter(
      (path) =>
        !(path in MDX_PAGES) &&
        (path.endsWith(".mdx") ||
          (path.endsWith(".md") && asksForMdx(readFileSync(join(ROOT, path), "utf8")))),
    );
    expect(others).toEqual([]);
  });

  it("Docusaurus reads every other page as CommonMark", () => {
    const config = readFileSync(join(ROOT, "apps/docs/docusaurus.config.mjs"), "utf8");
    expect(config).toMatch(/\n {2}markdown: \{\n {4}format: "detect",\n/);
  });
});
