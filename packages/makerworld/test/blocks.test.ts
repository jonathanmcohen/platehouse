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

// The shapes the Boost Me box takes in real downloads, beyond the one above:
// a line break inside its text, and a box with a title and no text.
describe("MakerWorld's Boost Me box, as downloads write it", () => {
  it("keeps the line breaks inside its text", () => {
    expect(
      htmlToMarkdown(
        "<boostme><boosttitle>Boost Me</boosttitle><boostcontent>Thanks<br>Enjoy</boostcontent></boostme>Next",
      ),
    ).toBe("Boost Me\n\nThanks\nEnjoy\n\nNext");
  });

  it("keeps a box with only a title apart from the text after it", () => {
    expect(htmlToMarkdown("<boostme><boosttitle>Boost Me</boosttitle></boostme>Next")).toBe(
      "Boost Me\n\nNext",
    );
  });
});

// MakerWorld's "Membership" box (the 0.1.1-rc.1 live check): the same kind
// of box as Boost Me, written as its own three elements, which the
// converter did not know, so its title ran into its text: "MembershipWant to
// sell my models...", "MembershipCommercial Licenses available", in 10
// stored descriptions. The fixtures follow the markup of the real downloads
// (a title and text, or a title alone) with words of our own.
const member = (content?: string): string =>
  `<commercialme><commercialtitle>Membership</commercialtitle>${
    content === undefined ? "" : `<commercialcontent>${content}</commercialcontent>`
  }</commercialme>`;

describe("MakerWorld's Membership box", () => {
  it("puts a paragraph break between the title and its text", () => {
    expect(htmlToMarkdown(member("Want to sell prints of this model? Join my membership."))).toBe(
      "Membership\n\nWant to sell prints of this model? Join my membership.",
    );
  });

  it("keeps the box apart from the paragraphs around it", () => {
    expect(
      htmlToMarkdown(
        `<p>Print it in PLA.</p>${member("Commercial licences available")}<p>Have fun.</p>`,
      ),
    ).toBe("Print it in PLA.\n\nMembership\n\nCommercial licences available\n\nHave fun.");
  });

  it("keeps a box with only a title apart from the text after it", () => {
    expect(htmlToMarkdown(`${member()}Commercial licences are available.`)).toBe(
      "Membership\n\nCommercial licences are available.",
    );
  });

  it("keeps it apart from a Boost Me box before it", () => {
    expect(htmlToMarkdown(`${boost("Boost Me", "Thanks")}${member("Sell my models")}`)).toBe(
      "Boost Me\n\nThanks\n\nMembership\n\nSell my models",
    );
  });

  it("reads the tag names in any ASCII case", () => {
    expect(
      htmlToMarkdown(
        "<CommercialMe><CommercialTitle>Membership</CommercialTitle><CommercialContent>Hi</CommercialContent></CommercialMe>",
      ),
    ).toBe("Membership\n\nHi");
  });

  it("keeps emphasis inside the box", () => {
    expect(
      htmlToMarkdown(
        "<commercialme><commercialtitle><strong>Membership</strong></commercialtitle><commercialcontent><em>Licences</em> here</commercialcontent></commercialme>",
      ),
    ).toBe("**Membership**\n\n*Licences* here");
  });

  it("is a space inside a list item and inside a table cell", () => {
    expect(htmlToMarkdown(`<ul><li>${member("Sell")}</li><li>Next</li></ul>`)).toBe(
      "- Membership Sell\n- Next",
    );
    expect(htmlToMarkdown(`<table><tr><td>${member("Sell")}</td><td>B</td></tr></table>`)).toBe(
      "| Membership Sell | B |\n| --- | --- |",
    );
  });
});

// MakerWorld's video embed: an <oembed> in a <figure>, which shows a player
// on its site and holds no text. The figure already ends its block; on its
// own an oembed ends one too, like every element HTML does not define.
describe("MakerWorld's video embed", () => {
  it("leaves nothing of the embed and keeps the text after it", () => {
    expect(
      htmlToMarkdown(
        '<figure class="media"><oembed url="https://video.test/watch?v=synthetic"></oembed></figure><p>Text after the video.</p>',
      ),
    ).toBe("Text after the video.");
  });

  it("keeps the text on either side of a bare embed apart", () => {
    expect(htmlToMarkdown('Before<oembed url="https://video.test/v"></oembed>After')).toBe(
      "Before\n\nAfter",
    );
  });
});

// The class, not one more name (the 0.1.1-rc.1 live check). Boost Me was
// fixed by naming its three elements, and the Membership box ran in the same
// way, because it used three other names. So every element HTML does not
// define is now a block boundary, as the Boost Me elements were: a paragraph
// break, or a space inside a list item or a table cell. A box MakerWorld adds
// later, under any name, cannot run its text into the next.
describe("an element HTML does not define", () => {
  // A seeded generator, so a failure names an input that fails again.
  function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const NAME_CHARS = `${LETTERS}0123456789-_.:`;
  // A name HTML does not define: no HTML element name is longer than 10
  // characters or holds any of - _ . :, so each name here is either 11 to 24
  // characters long or holds one of those (a custom element's hyphen, say).
  function unknownName(next: () => number): string {
    const pick = (s: string): string => s.charAt(Math.floor(next() * s.length));
    const long = next() < 0.5;
    const length = long ? 11 + Math.floor(next() * 14) : 2 + Math.floor(next() * 8);
    let name = pick(LETTERS);
    while (name.length < length) name += pick(NAME_CHARS);
    if (!long && !/[-_.:]/.test(name)) {
      const at = 1 + Math.floor(next() * (name.length - 1));
      name = `${name.slice(0, at)}${pick("-_.:")}${name.slice(at)}`;
    }
    return name;
  }
  const next = rng(0x0de1);
  const GENERATED = Array.from({ length: 200 }, () => unknownName(next));
  const NAMES = [
    // Real ones and likely ones, short, with no punctuation.
    "boostme",
    "commercialme",
    "oembed",
    "tip",
    "note",
    "card",
    "box",
    "warning",
    "x",
    ...GENERATED,
  ];
  // How the element sits between the two runs of text.
  const SHAPES: Array<[string, (n: string) => string]> = [
    ["wrapping the second run", (n) => `Alpha<${n}>Omega</${n}>`],
    ["wrapping the first run", (n) => `<${n}>Alpha</${n}>Omega`],
    ["empty, between them", (n) => `Alpha<${n}></${n}>Omega`],
    ["open, never closed", (n) => `Alpha<${n}>Omega`],
    ["a close with no open", (n) => `Alpha</${n}>Omega`],
    ["closing itself", (n) => `Alpha<${n}/>Omega`],
    ["with attributes", (n) => `Alpha<${n} class="box" data-id="7">Omega</${n}>`],
    ["inside a paragraph", (n) => `<p>Alpha<${n}>Omega</${n}></p>`],
    ["inside bold", (n) => `<b>Alpha<${n}>Omega</${n}></b>`],
  ];

  it("generates names that cannot be HTML's", () => {
    for (const name of GENERATED) expect(name).toMatch(/^.{11,}$|[-_.:]/);
    expect(new Set(GENERATED).size).toBeGreaterThan(190);
  });

  it.each(SHAPES)("never joins the text on either side of it: %s", (_shape, make) => {
    for (const name of NAMES) {
      const out = htmlToMarkdown(make(name));
      expect(out, `${name}: ${JSON.stringify(out)}`).toMatch(/Alpha\*{0,2}\s+\*{0,2}Omega/);
    }
  });

  it("is a space inside a list item, so the list stays one list", () => {
    for (const name of NAMES) {
      expect(htmlToMarkdown(`<ul><li>Alpha<${name}>Omega</${name}></li><li>Next</li></ul>`)).toBe(
        "- Alpha Omega\n- Next",
      );
    }
  });

  it("is a space inside a table cell, so the row stays one row", () => {
    for (const name of NAMES) {
      expect(
        htmlToMarkdown(`<table><tr><td>Alpha<${name}>Omega</${name}></td><td>B</td></tr></table>`),
      ).toBe("| Alpha Omega | B |\n| --- | --- |");
    }
  });

  it("is a space inside a heading, so the heading stays one line", () => {
    expect(htmlToMarkdown("<h2>Title<sub-title>Part</sub-title></h2><p>x</p>")).toBe(
      "## Title Part\n\nx",
    );
  });
});

// The elements HTML defines and the converter does not write markup for
// are dropped with their text kept, as before: none of them breaks a word.
describe("an element HTML defines as inline", () => {
  const INLINE = [
    "span",
    "font",
    "u",
    "s",
    "small",
    "big",
    "sub",
    "sup",
    "code",
    "kbd",
    "mark",
    "abbr",
    "cite",
    "q",
    "time",
    "label",
    "nobr",
    "tt",
    "strike",
    "del",
    "ins",
    "bdi",
    "bdo",
    "data",
    "dfn",
    "var",
    "samp",
    "ruby",
    "acronym",
    "blink",
  ];

  it.each(INLINE)("<%s> keeps the text around it joined", (tag) => {
    expect(htmlToMarkdown(`<p>Mem<${tag}>ber</${tag}>ship</p>`)).toBe("Membership");
  });

  it("a void element keeps the text around it joined", () => {
    expect(htmlToMarkdown('<p>Mem<img src="x.png">ber<wbr>ship</p>')).toBe("Membership");
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
