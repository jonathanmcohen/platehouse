import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONVERTER_VERSION, earlierConversions, htmlToMarkdown } from "../src/index.js";
import { htmlToMarkdownRc } from "../src/legacy/markdown-rc.js";
import { htmlToMarkdown010 } from "../src/markdown.js";

// The earlier converters (#357). The description re-conversion proves a
// stored description is one a converter wrote, untouched, by writing it
// again with the converter that wrote it. These fixtures hold what the
// released converters themselves wrote: each was made by running the
// converter as tagged (v0.1.0-rc.3 for rc.1 to rc.3, v0.1.0 for rc.4 and
// 0.1.0) over the same inputs, so they test the copies here against the
// real thing, not against themselves. Every input is synthetic.

interface Pair {
  html: string;
  markdown: string;
}

const fixture = (name: string): Pair[] =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as Pair[];

const RC = fixture("converter-rc.json");
const V010 = fixture("converter-0.1.0.json");

describe("the fixtures", () => {
  it("hold the same inputs for both converters, and enough of them differ", () => {
    expect(RC.map((p) => p.html)).toEqual(V010.map((p) => p.html));
    expect(RC.length).toBeGreaterThan(200);
    const differ = RC.filter((p, i) => p.markdown !== V010[i]?.markdown).length;
    expect(differ).toBeGreaterThan(50);
  });

  it("include the Boost Me box", () => {
    expect(RC.some((p) => p.html.includes("<boostme>"))).toBe(true);
  });
});

describe("htmlToMarkdownRc, the converter of 0.1.0-rc.1 to rc.3", () => {
  it.each(RC.map((p, i) => [i, p] as const))("writes what rc.3 wrote for input %i", (_i, p) => {
    expect(htmlToMarkdownRc(p.html)).toBe(p.markdown);
  });

  it("keeps the marks 0.1.0 learned to drop", () => {
    expect(htmlToMarkdownRc("<p><b>Note:</b>Use</p>")).toBe("**Note:**Use");
  });
});

describe("htmlToMarkdown010, the converter of 0.1.0-rc.4 and 0.1.0", () => {
  it.each(V010.map((p, i) => [i, p] as const))("writes what 0.1.0 wrote for input %i", (_i, p) => {
    expect(htmlToMarkdown010(p.html)).toBe(p.markdown);
  });

  it("still runs a Boost Me box together", () => {
    expect(
      htmlToMarkdown010(
        "<boostme><boosttitle>Boost Me</boosttitle><boostcontent>Hi</boostcontent></boostme>",
      ),
    ).toBe("Boost MeHi");
  });
});

describe("earlierConversions", () => {
  it("gives every earlier converter's text, oldest first, trimmed as ingest stores it", () => {
    const html =
      "<p><b>Note:</b>Use</p><boostme><boosttitle>Boost Me</boosttitle><boostcontent>Hi</boostcontent></boostme>";
    expect(earlierConversions(html)).toEqual([
      { version: 1, markdown: "**Note:**Use\n\nBoost MeHi" },
      { version: 2, markdown: "Note:Use\n\nBoost MeHi" },
    ]);
  });

  it("is empty for no description", () => {
    expect(earlierConversions("")).toEqual([
      { version: 1, markdown: "" },
      { version: 2, markdown: "" },
    ]);
  });
});

describe("CONVERTER_VERSION", () => {
  it("is the version after the earlier ones", () => {
    expect(CONVERTER_VERSION).toBe(3);
    expect(
      htmlToMarkdown("<boostme><boosttitle>A</boosttitle><boostcontent>B</boostcontent></boostme>"),
    ).toBe("A\n\nB");
  });
});
