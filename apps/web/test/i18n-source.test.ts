// Checks over the source that keep the translations whole (Jon,
// 2026-11-19): every key the code names is in the English catalog, every
// English key is used somewhere, no message is set as raw HTML, and no new
// English sentence slips into a component as bare JSX text or a bare
// user-facing attribute.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const WEB_SRC = join(ROOT, "apps/web/src");
const SERVER_SRC = join(ROOT, "apps/server/src");
const EN = JSON.parse(readFileSync(join(ROOT, "packages/i18n/locales/en.json"), "utf8")) as Record<
  string,
  unknown
>;
const KEYS = Object.keys(EN).filter((k) => k !== "$meta");

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path, ext);
    return ext.test(entry.name) ? [path] : [];
  });
}

const webFiles = files(WEB_SRC, /\.(ts|tsx)$/);
const serverFiles = files(SERVER_SRC, /\.ts$/);
const source = new Map([...webFiles, ...serverFiles].map((f) => [f, readFileSync(f, "utf8")]));

describe("the catalog keys", () => {
  it("finds the source it checks", () => {
    expect(webFiles.length).toBeGreaterThan(40);
    expect(KEYS.length).toBeGreaterThan(300);
  });

  it("every key a t() or rich() call names is an English key", () => {
    const unknown: string[] = [];
    for (const [file, text] of source) {
      for (const m of text.matchAll(/\b(?:t|rich)\(\s*"([a-zA-Z0-9_.]+)"/g)) {
        if (!Object.hasOwn(EN, m[1] as string)) unknown.push(`${relative(ROOT, file)}: ${m[1]}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  it("every English key is named somewhere in the source", () => {
    const all = [...source.values()].join("\n");
    const unused = KEYS.filter((key) => !all.includes(`"${key}"`));
    expect(unused).toEqual([]);
  });
});

describe("the components", () => {
  it("set no raw HTML but the sanitised description", () => {
    const html = webFiles
      .filter((f) => (source.get(f) ?? "").includes("dangerouslySetInnerHTML"))
      .map((f) => relative(WEB_SRC, f));
    expect(html).toEqual(["model/AboutTab.tsx"]);
  });

  // Words that are names, not sentences: they stay as they are in every language.
  const NAMES = new Set([
    "Platehouse",
    "OrcaSlicer",
    "OpenSCAD",
    "Bambu Studio",
    "STL",
    "STEP",
    "SCAD",
    "3MF",
  ]);
  // The API reference's body stays English in 0.1.0 (Jon's decision 6).
  const SKIP = ["api-docs/"];

  it("show no bare English text in JSX or in a user-facing attribute", () => {
    const found: string[] = [];
    for (const file of webFiles.filter((f) => f.endsWith(".tsx"))) {
      const rel = relative(WEB_SRC, file);
      if (SKIP.some((s) => rel.startsWith(s))) continue;
      const lines = (source.get(file) ?? "").split("\n");
      lines.forEach((line, i) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
        // A JSX text line: words and punctuation only, starting with a capital.
        if (/^[A-Z][a-z]+(?: [A-Za-z][a-z]*)*[.!?]?$/.test(trimmed) && !NAMES.has(trimmed)) {
          found.push(`${rel}:${i + 1}: ${trimmed}`);
        }
        for (const m of trimmed.matchAll(
          /\b(aria-label|title|placeholder|alt|label)="([^"]*[A-Za-z]{2}[^"]*)"/g,
        )) {
          if (!NAMES.has(m[2] as string)) found.push(`${rel}:${i + 1}: ${m[0]}`);
        }
      });
    }
    expect(found).toEqual([]);
  });
});
