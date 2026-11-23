// The plate mesh code and the derived (preview) code share the memory gate
// through src/memory/ and never import each other.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(join(SRC, dir), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => join(e.parentPath, e.name));
}

function specifiers(file: string): string[] {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1] ?? "");
}

describe("the plate mesh and derived code do not depend on each other", () => {
  test.each([
    ["plate-mesh", "derived"],
    ["derived", "plate-mesh"],
  ] as const)("no file under src/%s/ imports from src/%s/", (from, to) => {
    const files = sources(from);
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter((f) =>
      specifiers(f).some((s) => new RegExp(`(^|/)${to}(/|$)`).test(s)),
    );
    expect(offenders).toEqual([]);
  });
});
