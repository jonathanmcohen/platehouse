import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

// The package is consumed by name (build plan Task 8: apps/server imports
// extractMakerWorld, htmlToMarkdown and mapLicense from @platehouse/makerworld)
// and the server runs under plain node in the app image (Task 24). Vitest and
// tsc both map a ".js" import to the ".ts" file beside it; node does not. So
// this builds the package with its own build command (tsc -b, as
// packages/threemf does) and imports it by name in a separate, plain node
// process, the way the server will.
const PKG = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")) as {
  name: string;
  scripts?: Record<string, string>;
  exports?: Record<string, unknown>;
};

const EXPORTS = ["extractMakerWorld", "htmlToMarkdown", "mapLicense", "renderMarkdown"];

// Runs in the child: import the package by its own name (Node's package
// self-reference, which goes through "exports" like any other consumer) and
// print what it exports, plus two calls that need no DOM.
const PROBE = `
const m = await import(${JSON.stringify(manifest.name)});
console.log(JSON.stringify({
  exports: Object.keys(m).sort().map((k) => [k, typeof m[k]]),
  license: m.mapLicense("BY"),
  markdown: m.htmlToMarkdown("<p>Hello <strong>there</strong></p>"),
}));
`;

describe("the built package under plain node", () => {
  beforeAll(() => {
    // TypeScript's own entry script, run with this node, so no shell, pnpm or
    // PATH lookup is involved. The build writes dist/, which git ignores.
    const require = createRequire(import.meta.url);
    const tsc = join(dirname(require.resolve("typescript/package.json")), "bin", "tsc");
    execFileSync(process.execPath, [tsc, "-b"], { cwd: PKG, stdio: "pipe", timeout: 120_000 });
  }, 150_000);

  it("is built by tsc -b, as packages/threemf is", () => {
    expect(manifest.scripts?.build).toBe("tsc -b");
  });

  it("points its entry at the build output, and the build writes those files", () => {
    expect(manifest.exports).toEqual({
      ".": { types: "./dist/src/index.d.ts", default: "./dist/src/index.js" },
    });
    expect(existsSync(join(PKG, "dist/src/index.d.ts"))).toBe(true);
    expect(existsSync(join(PKG, "dist/src/index.js"))).toBe(true);
  });

  it("imports by package name in plain node and exports the Task 7 functions", () => {
    let out: string;
    try {
      out = execFileSync(process.execPath, ["--input-type=module", "--eval", PROBE], {
        cwd: PKG,
        encoding: "utf8",
        stdio: "pipe",
        timeout: 60_000,
      });
    } catch (err) {
      const e = err as { stderr?: string; message: string };
      throw new Error(`plain node could not import the package:\n${e.stderr ?? e.message}`);
    }
    expect(JSON.parse(out)).toEqual({
      exports: EXPORTS.map((name) => [name, "function"]),
      license: { spdx: "CC-BY-4.0" },
      markdown: "Hello **there**",
    });
  });
});
