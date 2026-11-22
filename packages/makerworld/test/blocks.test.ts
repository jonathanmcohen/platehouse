import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "../src/index.js";

// A block boundary must never join the words on either side of it (#357).
// MakerWorld puts a "Boost Me" box in a description as its own elements,
// <boostme><boosttitle>...</boosttitle><boostcontent>...</boostcontent>
// </boostme>, which its site shows as a title above a line of text. The
// converter knew none of the three, dropped the tags and kept their text, so
// the title ran straight into the text after it: "Boost MeWant more?", or
// "Boost Me" followed by CJK text with no break at all, in 66 stored
// descriptions. The fixtures below follow that markup exactly, with words of
// our own.

const boost = (title: string, content: string): string =>
  `<boostme><boosttitle>${title}</boosttitle><boostcontent>${content}</boostcontent></boostme>`;

describe("MakerWorld's Boost Me box", () => {
  it("puts a paragraph break between the title and its text", () => {
    expect(htmlToMarkdown(boost("Boost Me", "Want more? Give it a boost."))).toBe(
      "Boost Me\n\nWant more? Give it a boost.",
    );
  });

  it("puts a paragraph break before CJK text", () => {
    const cjk = String.fromCodePoint(0x8c22, 0x8c22, 0x652f, 0x6301);
    expect(htmlToMarkdown(boost("Boost Me", cjk))).toBe(`Boost Me\n\n${cjk}`);
  });

  it("keeps the box apart from the paragraphs around it", () => {
    const html = `<p>Print at 0.2 mm.</p>${boost("Boost Me", "Thanks")}<p>Update: a new lid.</p>`;
    expect(htmlToMarkdown(html)).toBe(
      "Print at 0.2 mm.\n\nBoost Me\n\nThanks\n\nUpdate: a new lid.",
    );
  });

  it("keeps the box apart from text with no paragraph of its own", () => {
    expect(htmlToMarkdown(`Before${boost("Boost Me", "Thanks")}After`)).toBe(
      "Before\n\nBoost Me\n\nThanks\n\nAfter",
    );
  });

  it("reads the tag names in any ASCII case", () => {
    expect(
      htmlToMarkdown("<BoostMe><BoostTitle>Boost Me</BoostTitle><BoostContent>Hi</BoostContent>"),
    ).toBe("Boost Me\n\nHi");
  });

  it("keeps emphasis inside the box", () => {
    expect(htmlToMarkdown(boost("<strong>Boost Me</strong>", "<em>Thanks</em> a lot"))).toBe(
      "**Boost Me**\n\n*Thanks* a lot",
    );
  });

  it("is a space inside a list item, so the list stays one list", () => {
    expect(htmlToMarkdown(`<ul><li>${boost("Boost Me", "Thanks")}</li><li>Next</li></ul>`)).toBe(
      "- Boost Me Thanks\n- Next",
    );
  });

  it("is a space inside a table cell, so the row stays one row", () => {
    const html = `<table><tr><td>${boost("Boost Me", "Thanks")}</td><td>B</td></tr></table>`;
    expect(htmlToMarkdown(html)).toBe("| Boost Me Thanks | B |\n| --- | --- |");
  });
});

// The same fault for every element HTML itself displays as a block and the
// converter did not know: their text ran into the next block's.
describe("HTML's other block elements", () => {
  const BLOCKS = [
    "address",
    "aside",
    "center",
    "details",
    "dialog",
    "dd",
    "dl",
    "dt",
    "fieldset",
    "figcaption",
    "form",
    "hgroup",
    "legend",
    "main",
    "nav",
    "search",
    "summary",
  ];

  it.each(BLOCKS)("<%s> ends its block", (tag) => {
    expect(htmlToMarkdown(`<${tag}>First</${tag}>Second`)).toBe("First\n\nSecond");
  });

  it("writes a definition list one paragraph per term and definition", () => {
    expect(
      htmlToMarkdown("<dl><dt>Nozzle</dt><dd>0.4 mm</dd><dt>Layer</dt><dd>0.2 mm</dd></dl>"),
    ).toBe(
      // A line that begins "0.4" is escaped, so it cannot start a numbered list.
      "Nozzle\n\n0\\.4 mm\n\nLayer\n\n0\\.2 mm",
    );
  });

  it("writes a details box with its summary first", () => {
    expect(htmlToMarkdown("<details><summary>Settings</summary>Use PETG.</details>")).toBe(
      "Settings\n\nUse PETG.",
    );
  });
});
