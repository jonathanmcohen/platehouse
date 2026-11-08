import * as makerworld from "@platehouse/makerworld";
import { describe, expect, it } from "vitest";

// The package is consumed by name (build plan Task 8: apps/server imports
// extractMakerWorld, htmlToMarkdown and mapLicense from @platehouse/makerworld),
// so its package.json must give an entry point. This imports the package by
// its own name, which resolves through the "exports" field in Vitest and in
// tsc -b alike; with no entry point both fail.
describe("the package entry point", () => {
  it("exports the Task 7 functions by package name", () => {
    expect(typeof makerworld.extractMakerWorld).toBe("function");
    expect(typeof makerworld.fieldsHiddenByCap).toBe("function");
    expect(typeof makerworld.htmlToMarkdown).toBe("function");
    expect(typeof makerworld.mapLicense).toBe("function");
    expect(typeof makerworld.renderMarkdown).toBe("function");
  });
});
