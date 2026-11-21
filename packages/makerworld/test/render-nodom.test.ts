import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/index.js";

// This file runs in Vitest's default node environment, where there is no DOM.
// DOMPurify cannot sanitise without one, so renderMarkdown must refuse to run
// rather than hand back markdown-it's output unsanitised.
describe("renderMarkdown without a DOM", () => {
  it("throws instead of returning unsanitised HTML", () => {
    expect(typeof (globalThis as { window?: unknown }).window).toBe("undefined");
    expect(() => renderMarkdown("<script>alert(1)</script> [x](https://e.test)")).toThrow(/DOM/);
  });
});
