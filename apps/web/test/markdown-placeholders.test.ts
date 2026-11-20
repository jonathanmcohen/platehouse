// GitHub renders every tracked Markdown file outside the docs site, and it
// drops raw HTML it does not allow. A placeholder written bare, such as
// models/<modelId>/<blobId> or orca-X.Y.Z-r<run number>, is raw HTML to the
// Markdown parser, so it shows on GitHub as "models//" or "orca-X.Y.Z-r" and
// the text it was written to explain is lost. pr-review found this three
// times in a row on PR #302 (issues #306 and #307), so this guards the class,
// not one line: every tracked .md file that is not under docs/ (the
// Docusaurus site, which is MDX, and whose build already fails on a bare tag)
// must keep each placeholder in a code span or a code block.
//
// How: each file is parsed with a CommonMark parser plus GitHub's
// extensions (markdown-placeholders.support.ts), and every raw HTML node in
// the tree, block or inline, is reported with its line, except the real tags
// in ALLOWED_TAGS, each with its reason. Code spans and code blocks are code
// to the parser and autolinks are links, so no rule here has to find where a
// span starts or ends; an earlier hand-written matcher got that wrong across
// list items and headings (issue #308).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { ALLOWED_TAGS, barePlaceholders, htmlNodes } from "./markdown-placeholders.support";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** Every tracked .md file GitHub renders outside the docs site. */
function renderedMarkdown(): string[] {
  return execFileSync("git", ["ls-files", "-z", "--", "*.md"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter((f) => f !== "" && !f.startsWith("docs/") && existsSync(join(ROOT, f)));
}

describe("no bare placeholder in Markdown that GitHub renders", () => {
  test("the check finds bare placeholders, spaced ones included, and leaves code and links alone", () => {
    const sample = [
      "every blob lives under models/<modelId>/<blobId>, two ids",
      "a re-run tags orca-X.Y.Z-r<run number>.<attempt> now",
      "run it with --model <id> and </closing>",
      "in code: `models/<modelId>/<blobId>` and ``a `<x>` inside``",
      "a link: <https://example.com/x?a=1> and <name@example.com>",
      "a comparison: a < b and b > a, an arrow -> and <= 3",
      "```sh",
      "curl <url> --header <name>",
      "```",
      "~~~",
      "<inside a tilde fence>",
      "~~~",
      "a span that crosses `a line",
      "break <here>` is code",
    ].join("\n");
    expect(barePlaceholders("sample", sample)).toEqual([
      "sample:1: <modelId>",
      "sample:1: <blobId>",
      "sample:2: <run number>",
      "sample:2: <attempt>",
      "sample:3: <id>",
      "sample:3: </closing>",
    ]);
  });

  test("a stray backtick does not hide a placeholder in a later paragraph", () => {
    // CommonMark ends a code span at the end of its paragraph, so a lone
    // backtick never pairs with one past a blank line.
    const sample = [
      "press the ` key",
      "",
      "models/<id> is bare",
      "",
      "and `code` here",
      "   ",
      "a blank line of spaces ` ends one too",
      "\t",
      "so <this> is bare as well, and `<x>` is code",
    ].join("\n");
    expect(barePlaceholders("sample", sample)).toEqual(["sample:3: <id>", "sample:9: <this>"]);
  });

  // Issue #308: a code span also ends at the end of a list item or a
  // heading, with no blank line after it. Each sample has a stray backtick
  // that a hand-written span matcher would pair with a later one, hiding the
  // bare placeholder between them; GitHub still strips it.
  test("a stray backtick in a list item does not hide a placeholder in the next item", () => {
    const sample = ["- press the ` key", "- models/<id> is bare", "- and `code` here"].join("\n");
    expect(barePlaceholders("sample", sample)).toEqual(["sample:2: <id>"]);
  });

  test("a stray backtick in a heading does not hide a placeholder after it", () => {
    const sample = ["## A heading with ` stray", "models/<id> after a heading", "then `code`"].join(
      "\n",
    );
    expect(barePlaceholders("sample", sample)).toEqual(["sample:2: <id>"]);
  });

  test("a stray backtick does not reach across paragraphs either", () => {
    const sample = ["one ` here", "", "two <stripped> here", "", "three ` here"].join("\n");
    expect(barePlaceholders("sample", sample)).toEqual(["sample:3: <stripped>"]);
  });

  test("no tracked Markdown file outside docs/ writes one bare", () => {
    const files = renderedMarkdown();
    // The list really is the tree: files from several places are in it, and docs/ is not.
    for (const f of [
      "CHANGELOG.md",
      "README.md",
      "e2e/README.md",
      "tools/slicing-gate/README.md",
    ]) {
      expect(files).toContain(f);
    }
    expect(files.some((f) => f.startsWith("docs/"))).toBe(false);
    const found = files.flatMap((f) => barePlaceholders(f, readFileSync(join(ROOT, f), "utf8")));
    expect(found).toEqual([]);
  });

  test("every allowed tag is still used, so the list cannot go stale", () => {
    const used = new Set(
      renderedMarkdown().flatMap((f) =>
        htmlNodes(readFileSync(join(ROOT, f), "utf8")).map((n) => n.tag),
      ),
    );
    for (const tag of Object.keys(ALLOWED_TAGS)) {
      expect(used.has(tag), tag).toBe(true);
    }
  });
});
