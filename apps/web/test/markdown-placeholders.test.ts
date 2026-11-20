// GitHub renders every tracked Markdown file outside the docs site, and it
// drops anything shaped like an HTML tag it does not know. A placeholder
// written bare, such as models/<modelId>/<blobId> or orca-X.Y.Z-r<run number>,
// shows on GitHub as "models//" or "orca-X.Y.Z-r", so the text it was written
// to explain is lost. pr-review found this three times in a row on PR #302
// (issues #306 and #307), so this guards the class, not one line: every
// tracked .md file that is not under docs/ (the Docusaurus site, which is MDX,
// and whose build already fails on a bare tag) must keep each placeholder in a
// code span or a fenced block.
//
// What counts as a bare tag: "<" then a letter (or "/" and a letter), then
// anything but "<" or ">" up to ">", so a placeholder with a space in it,
// <run number>, is caught as well as <id>. URL and email autolinks
// (<https://...>, <name@example.com>) render as links and are allowed, and so
// are the real HTML tags in ALLOWED_TAGS, each with its reason.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { ALLOWED_TAGS, barePlaceholders, proseOnly } from "./markdown-placeholders.support";

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
    const all = renderedMarkdown()
      .map((f) => proseOnly(readFileSync(join(ROOT, f), "utf8")))
      .join("\n");
    for (const tag of Object.keys(ALLOWED_TAGS)) {
      expect(new RegExp(`</?${tag}\\b`, "i").test(all), tag).toBe(true);
    }
  });
});
