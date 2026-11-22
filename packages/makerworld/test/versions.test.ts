import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONVERTER_VERSION, earlierConversions, htmlToMarkdown } from "../src/index.js";
import { htmlToMarkdownRc } from "../src/legacy/markdown-rc.js";
import { HTML_ELEMENTS, htmlToMarkdown010, htmlToMarkdown011Rc1 } from "../src/markdown.js";

// The earlier converters (#357). The description re-conversion proves a
// stored description is one a converter wrote, untouched, by writing it
// again with the converter that wrote it. These fixtures hold what the
// released converters themselves wrote: each was made by running the
// converter as tagged (v0.1.0-rc.3 for rc.1 to rc.3, v0.1.0 for rc.4 and
// 0.1.0, v0.1.1-rc.1 for 0.1.1-rc.1) over the same inputs, so they test the
// copies here against the real thing, not against themselves. The
// 0.1.1-rc.1 fixture adds inputs with elements HTML does not define, where
// that converter and the current one differ; packages/makerworld is the same
// at v0.1.1-rc.1 as at the commit this branch began from (ab30be8), and the
// fixture was written by that code. Every input is synthetic.

interface Pair {
  html: string;
  markdown: string;
}

const fixture = (name: string): Pair[] =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as Pair[];

const RC = fixture("converter-rc.json");
const V010 = fixture("converter-0.1.0.json");
const V011RC1 = fixture("converter-0.1.1-rc.1.json");

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

  it("hold 0.1.0's inputs and more for 0.1.1-rc.1, and the current converter differs on some", () => {
    expect(V011RC1.slice(0, V010.length).map((p) => p.html)).toEqual(V010.map((p) => p.html));
    expect(V011RC1.length).toBeGreaterThan(V010.length + 15);
    expect(V011RC1.some((p) => p.html.includes("<commercialme>"))).toBe(true);
    const differ = V011RC1.filter((p) => htmlToMarkdown(p.html) !== p.markdown).length;
    expect(differ).toBeGreaterThan(10);
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

describe("htmlToMarkdown011Rc1, the converter of 0.1.1-rc.1", () => {
  it.each(V011RC1.map((p, i) => [i, p] as const))(
    "writes what 0.1.1-rc.1 wrote for input %i",
    (_i, p) => {
      expect(htmlToMarkdown011Rc1(p.html)).toBe(p.markdown);
    },
  );

  it("still runs a Membership box together", () => {
    expect(
      htmlToMarkdown011Rc1(
        "<commercialme><commercialtitle>Membership</commercialtitle><commercialcontent>Hi</commercialcontent></commercialme>",
      ),
    ).toBe("MembershipHi");
  });
});

// The current converter differs from 0.1.1-rc.1's only where an element HTML
// does not define sits: for every element HTML does define, both write the
// same, so no stored description changes for any other reason.
describe("the current converter against 0.1.1-rc.1's", () => {
  const shapes = (t: string): string[] => [
    `Alpha<${t}>Omega</${t}>Next`,
    `<p>Alpha<${t}>Omega</${t}></p><p>Next</p>`,
    `<ul><li>Alpha<${t}>Omega</${t}></li></ul>`,
    `<table><tr><td>Alpha<${t}>Omega</${t}></td></tr></table>`,
    `<h2>Alpha<${t}>Omega</${t}></h2>`,
    `<b>Alpha<${t}>Omega</${t}></b>`,
  ];

  it.each([...HTML_ELEMENTS])("writes what 0.1.1-rc.1 wrote around <%s>", (tag) => {
    for (const html of shapes(tag)) expect(htmlToMarkdown(html)).toBe(htmlToMarkdown011Rc1(html));
  });

  it("knows every element HTML defines, obsolete ones included", () => {
    for (const tag of ["span", "font", "center", "marquee", "blink", "tbody", "colgroup", "h6"]) {
      expect(HTML_ELEMENTS.has(tag)).toBe(true);
    }
    for (const tag of ["boostme", "commercialme", "oembed", "x-note"]) {
      expect(HTML_ELEMENTS.has(tag)).toBe(false);
    }
  });
});

describe("earlierConversions", () => {
  it("gives every earlier converter's text, oldest first, trimmed as ingest stores it", () => {
    const html =
      "<p><b>Note:</b>Use</p><boostme><boosttitle>Boost Me</boosttitle><boostcontent>Hi</boostcontent></boostme>";
    expect(earlierConversions(html)).toEqual([
      { version: 1, markdown: "**Note:**Use\n\nBoost MeHi" },
      { version: 2, markdown: "Note:Use\n\nBoost MeHi" },
      { version: 3, markdown: "Note:Use\n\nBoost Me\n\nHi" },
    ]);
  });

  it("gives what 0.1.1-rc.1 wrote for a Membership box", () => {
    const html =
      "<commercialme><commercialtitle>Membership</commercialtitle><commercialcontent>Hi</commercialcontent></commercialme>";
    expect(earlierConversions(html).at(-1)).toEqual({ version: 3, markdown: "MembershipHi" });
  });

  it("is empty for no description", () => {
    expect(earlierConversions("")).toEqual([
      { version: 1, markdown: "" },
      { version: 2, markdown: "" },
      { version: 3, markdown: "" },
    ]);
  });
});

describe("CONVERTER_VERSION", () => {
  it("is the version after the earlier ones", () => {
    expect(CONVERTER_VERSION).toBe(4);
    expect(
      htmlToMarkdown("<boostme><boosttitle>A</boosttitle><boostcontent>B</boostcontent></boostme>"),
    ).toBe("A\n\nB");
    expect(
      htmlToMarkdown(
        "<commercialme><commercialtitle>A</commercialtitle><commercialcontent>B</commercialcontent></commercialme>",
      ),
    ).toBe("A\n\nB");
  });
});
