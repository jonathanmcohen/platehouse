// AC-033: estimating happens in the background and must not block an upload.
// Ingest meets that by having no way to reach the slicer at all, which this
// test checks from the source: ingest.ts, and every server module it imports
// directly or through another, imports nothing that talks to the slicer or to
// the network, never calls fetch, and never reads the configuration or the
// environment, which is where the slicer's address (SLICER_URL) lives.
// Estimates are queued after the commit by Task 12, outside ingest.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");
const ENTRY = resolve(SRC, "ingest/ingest.ts");

const IMPORT =
  /(?:import|export)\s[^"';]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;

/**
 * Each server source file ingest.ts reaches at run time, with what it
 * imports. A type-only import (import type, export type) is left out: it is
 * erased at build and runs nothing.
 */
function moduleGraph(entry: string): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const pending = [entry];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (graph.has(file)) continue;
    const source = readFileSync(file, "utf8");
    const specifiers = [...source.matchAll(IMPORT)]
      .filter((m) => !/^(import|export)\s+type\s/.test(m[0]))
      .map((m) => m[1] ?? m[2] ?? m[3] ?? "");
    graph.set(file, specifiers);
    for (const spec of specifiers) {
      if (spec.startsWith(".")) pending.push(resolve(dirname(file), spec.replace(/\.js$/, ".ts")));
    }
  }
  return graph;
}

const graph = moduleGraph(ENTRY);

/** Modules that would let ingest reach the slicer: its contract, or any network client. */
const REACHES_THE_SLICER =
  /slicer|^(node:)?(http|https|http2|net|tls|dgram)$|^undici$|^axios$|^got$|^node-fetch$/i;

describe("ingest has no way to reach the slicer (AC-033)", () => {
  test("the module walk sees ingest.ts and the server modules it uses", () => {
    const files = [...graph.keys()].map((f) => f.slice(SRC.length + 1));
    expect(files).toContain("ingest/ingest.ts");
    expect(files).toContain("ingest/detect.ts");
    expect(files).toContain("storage/s3.ts");
    expect(files.length).toBeGreaterThan(5);
  });

  test("no module ingest reaches imports the slicer contract or a network client", () => {
    const found = [...graph].flatMap(([file, specs]) =>
      specs.filter((s) => REACHES_THE_SLICER.test(s)).map((s) => `${file}: ${s}`),
    );
    expect(found).toEqual([]);
  });

  test("no module ingest reaches calls fetch or reads the configuration, where the slicer's address is", () => {
    const found = [...graph.keys()].filter((file) =>
      /\bfetch\s*\(|SLICER_URL|loadConfig|process\.env/.test(readFileSync(file, "utf8")),
    );
    expect(found).toEqual([]);
  });
});
