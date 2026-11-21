import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The build plan's Global Constraints: ASCII only in code and comments. A
// character outside ASCII is written as an escape (\u2018, not the quote
// itself). Biome does not check this, so this test does.
const PKG = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|json)$/.test(entry.name) ? [path] : [];
  });
}

const FILES = [
  ...sourceFiles(join(PKG, "src")),
  ...sourceFiles(join(PKG, "test")),
  join(PKG, "package.json"),
  join(PKG, "tsconfig.json"),
].map((path) => relative(PKG, path));

describe("the package source is ASCII only", () => {
  it("finds the files it checks", () => {
    expect(FILES).toContain("src/extract.ts");
    expect(FILES).toContain("test/ascii.test.ts");
  });

  it.each(FILES)("%s", (file) => {
    const lines = readFileSync(join(PKG, file), "utf8").split("\n");
    const bad = lines.flatMap((line, i) =>
      /[\u0080-\uffff]/.test(line) ? [`${i + 1}: ${line}`] : [],
    );
    expect(bad).toEqual([]);
  });
});
