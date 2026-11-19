// The shipped web app and server name none of Jon's machines or his home
// network (PR #230). Platehouse is published as public images, so text a user
// sees, such as a placeholder or a help line, must be generic. Every
// non-comment line of apps/web/src, apps/web/index.html and apps/server/src is
// checked. Comment lines are left out: they are history, not UI text.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// Joined from parts, so a search of the tree for these names finds the
// shipped code only.
const NAMES = [
  ["mini", "0[0-9]"].join(""),
  ["m", "ba"].join(""),
  ["Ha", "des"].join(""),
  ["jonco", "\\.dev"].join(""),
  ["Claude", " Code"].join(""),
];
const PERSONAL = new RegExp(`\\b(?:${NAMES.join("|")})\\b`, "i");

/** A line that is only a comment: //, a block comment's lines, or a JSX comment. */
const COMMENT = /^\s*(?:\/\/|\/\*|\*|\{\s*\/\*)/;

/** Each non-comment line that names a machine or the home network, as "file:line: text". */
function personalLines(file: string, source: string): string[] {
  return source
    .split("\n")
    .flatMap((line, i) =>
      !COMMENT.test(line) && PERSONAL.test(line) ? [`${file}:${i + 1}: ${line.trim()}`] : [],
    );
}

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(name)) files.push(path);
  }
  return files;
}

describe("no machine or home-network name in shipped text", () => {
  test("the check finds each name, and skips comments", () => {
    const sample = [
      'placeholder="Script on mini01"',
      "label: 'from the mba'",
      "const host = 'hades';",
      'const issuer = "https://id.local.jonco.dev";',
      "<p>Each client, such as Claude Code, gets a token.</p>",
      "// a comment that names mini01",
      " * a block comment that names Hades",
      "{/* a JSX comment that names mba */}",
      'const fine = "an ambassador, minimal, shades";',
    ].join("\n");
    expect(personalLines("sample", sample)).toEqual([
      'sample:1: placeholder="Script on mini01"',
      "sample:2: label: 'from the mba'",
      "sample:3: const host = 'hades';",
      'sample:4: const issuer = "https://id.local.jonco.dev";',
      "sample:5: <p>Each client, such as Claude Code, gets a token.</p>",
    ]);
  });

  test("apps/web and apps/server name none", () => {
    const web = fileURLToPath(new URL("../src", import.meta.url));
    const server = fileURLToPath(new URL("../../server/src", import.meta.url));
    const files = [
      ...sourceFiles(web),
      ...sourceFiles(server),
      fileURLToPath(new URL("../index.html", import.meta.url)),
    ];
    // Both trees were read: a file from each is in the list.
    expect(files.some((f) => f.endsWith(join("settings", "Tokens.tsx")))).toBe(true);
    expect(files.some((f) => f.endsWith(join("server", "src", "config.ts")))).toBe(true);
    const found = files.flatMap((file) => personalLines(file, readFileSync(file, "utf8")));
    expect(found).toEqual([]);
  });
});
