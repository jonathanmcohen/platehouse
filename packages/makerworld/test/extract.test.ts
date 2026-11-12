import { describe, expect, it } from "vitest";
import { decodeEntities, extractMakerWorld } from "../src/extract.js";
import { htmlToMarkdown } from "../src/markdown.js";

// Ported by behaviour from automation Manyfold/makerworld-metadata
// test/metadata.test.mjs at 1ce8c57 (the extraction cases). Every value here
// is synthetic: no designer's file, title or name is copied into the repo.
//
// The shape Bambu Studio writes at the top of 3D/3dmodel.model, cut where the
// zip reader stops (before <resources). MakerWorld's fields arrive already
// escaped and are escaped again for XML, so the title's & is &amp;amp; and the
// description's tags are &amp;lt;...&amp;gt;. The apostrophe is MakerWorld's
// own &#39;.
const PREFIX = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">
 <metadata name="Application">BambuStudio-01.02.03.04</metadata>
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <metadata name="CopyRight">[]</metadata>
 <metadata name="CreationDate">2001-02-03</metadata>
 <metadata name="Description">&amp;lt;h2&amp;gt;Example Kit Alpha&amp;lt;/h2&amp;gt;&amp;lt;p&amp;gt;isn&amp;amp;#39;t&amp;lt;/p&amp;gt;</metadata>
 <metadata name="Designer">Example Designer</metadata>
 <metadata name="License">MakerWorld Exclusive License</metadata>
 <metadata name="Origin">profile</metadata>
 <metadata name="Title">Example Kit Alpha | Part A &amp;amp; Part B</metadata>
 `;

describe("extractMakerWorld", () => {
  it("extracts title, designer, description and license from a real-shaped prefix", () => {
    const mw = extractMakerWorld(PREFIX);
    expect(mw).not.toBeNull();
    expect(mw?.title).toBe("Example Kit Alpha | Part A & Part B");
    expect(mw?.designer).toBe("Example Designer");
    expect(mw?.license).toBe("MakerWorld Exclusive License");
    expect(mw?.descriptionHtml).toBe("<h2>Example Kit Alpha</h2><p>isn&#39;t</p>");
  });

  it("the description becomes Markdown with the double-encoded apostrophe decoded once", () => {
    const mw = extractMakerWorld(PREFIX);
    expect(htmlToMarkdown(mw?.descriptionHtml)).toBe("## Example Kit Alpha\n\nisn't");
  });

  it("a description escaped only once gives the same Markdown", () => {
    const mw = extractMakerWorld(
      '<metadata name="Designer">D</metadata><metadata name="Description">&lt;h2&gt;Example Kit Alpha&lt;/h2&gt;&lt;p&gt;isn&amp;#39;t&lt;/p&gt;</metadata>',
    );
    expect(htmlToMarkdown(mw?.descriptionHtml)).toBe("## Example Kit Alpha\n\nisn't");
  });

  it("a non-breaking space escaped twice disappears from the Markdown", () => {
    const mw = extractMakerWorld(
      '<metadata name="Designer">D</metadata><metadata name="Description">&amp;lt;p&amp;gt;Rinse 2 times.&amp;amp;nbsp;&amp;lt;/p&amp;gt;&amp;lt;p&amp;gt;&amp;amp;nbsp;&amp;lt;/p&amp;gt;</metadata>',
    );
    expect(htmlToMarkdown(mw?.descriptionHtml)).toBe("Rinse 2 times.");
  });

  it("a double-encoded title is decoded to the real character", () => {
    const mw = extractMakerWorld(
      '<metadata name="Designer">D</metadata><metadata name="Title">Can&amp;#39;t Stop &amp;amp; Glue</metadata>',
    );
    expect(mw?.title).toBe("Can't Stop & Glue");
  });

  it("a title MakerWorld stored with an entity in it reads as text", () => {
    const mw = extractMakerWorld(
      '<metadata name="Designer">D</metadata><metadata name="Title">&amp;amp;quot;Widget&amp;amp;quot; Holder</metadata>',
    );
    expect(mw?.title).toBe('"Widget" Holder');
  });

  it("returns null without a Designer: Jon's own designs and other tools' exports", () => {
    expect(
      extractMakerWorld('<model><metadata name="Application">BambuStudio</metadata>'),
    ).toBeNull();
    expect(extractMakerWorld("")).toBeNull();
    // A MakerLab parametric export: no Designer, no Title.
    expect(
      extractMakerWorld(
        '<metadata name="Designer"></metadata><metadata name="MakerLab">Sample Generator</metadata><metadata name="Title"></metadata>',
      ),
    ).toBeNull();
    // Another tool's export: a placeholder Title and nothing else.
    expect(
      extractMakerWorld(
        '<metadata name="Copyright">Copyright (c) 2001 Example Tool.</metadata><metadata name="Designer"></metadata><metadata name="License"></metadata><metadata name="Title">Placeholder Part</metadata>',
      ),
    ).toBeNull();
  });

  it("returns null when the Designer is the Gridfinity Layout Tool generator, case and spacing folded", () => {
    expect(
      extractMakerWorld(
        '<metadata name="Designer">Gridfinity Layout Tool</metadata><metadata name="Title">Sample Tray</metadata>',
      ),
    ).toBeNull();
    expect(
      extractMakerWorld(
        '<metadata name="Designer">  gridfinity   LAYOUT tool </metadata><metadata name="Title">Sample Tray</metadata>',
      ),
    ).toBeNull();
    // A person's name that merely contains the words is still a designer.
    expect(
      extractMakerWorld('<metadata name="Designer">Gridfinity Layout Tool Fan</metadata>')
        ?.designer,
    ).toBe("Gridfinity Layout Tool Fan");
  });

  it("empty or whitespace-only values count as absent", () => {
    expect(
      extractMakerWorld(
        '<metadata name="Designer">  </metadata><metadata name="Title">T</metadata>',
      ),
    ).toBeNull();
    const mw = extractMakerWorld(
      '<metadata name="Designer">Jane</metadata><metadata name="License"/><metadata name="Title"> </metadata>',
    );
    expect(mw).toEqual({ title: null, designer: "Jane", descriptionHtml: null, license: null });
  });

  it("a self-closing or single-quoted metadata element is read", () => {
    const mw = extractMakerWorld(
      "<metadata name='Designer'>Single</metadata><metadata name=\"Title\" />",
    );
    expect(mw?.designer).toBe("Single");
    expect(mw?.title).toBeNull();
  });

  it("designer is trimmed and inner whitespace collapsed", () => {
    const mw = extractMakerWorld('<metadata name="Designer">\n  Example   Designer \n</metadata>');
    expect(mw?.designer).toBe("Example Designer");
  });

  it("a twice-escaped tag-like word in a real description reaches the Markdown escaped", () => {
    const mw = extractMakerWorld(
      '<metadata name="Description">&amp;lt;p&amp;gt;Fit &amp;amp;lt;Q7&amp;amp;gt; pins&amp;lt;/p&amp;gt;</metadata><metadata name="Designer">D</metadata>',
    );
    // CommonMark form: the < and > are backslash-escaped, so markdown-it shows
    // them as text and never reads an autolink or a tag.
    expect(htmlToMarkdown(mw?.descriptionHtml)).toBe("Fit \\<Q7\\> pins");
  });

  it("decodeEntities leaves invalid numeric references alone", () => {
    expect(decodeEntities("&#0; &#xD800; &#1114112; &#65;")).toBe("&#0; &#xD800; &#1114112; A");
  });

  // Pins the named-entity table, so writing its non-ASCII values as escapes
  // (the file is ASCII only) cannot change a character.
  it.each([
    ["nbsp", " "],
    ["lsquo", "\u2018"],
    ["rsquo", "\u2019"],
    ["ldquo", "\u201c"],
    ["rdquo", "\u201d"],
    ["ndash", "\u2013"],
    ["mdash", "\u2014"],
    ["hellip", "\u2026"],
    ["bull", "\u2022"],
    ["middot", "\u00b7"],
    ["copy", "\u00a9"],
    ["reg", "\u00ae"],
    ["trade", "\u2122"],
    ["deg", "\u00b0"],
    ["times", "\u00d7"],
    ["plusmn", "\u00b1"],
    ["micro", "\u00b5"],
  ])("decodeEntities reads &%s; as its character", (name, char) => {
    expect(decodeEntities(`a&${name};b`)).toBe(`a${char}b`);
  });

  // Not in the port: the first occurrence of a field wins, as in the source.
  it("the first occurrence of a field wins", () => {
    const mw = extractMakerWorld(
      '<metadata name="Designer">First</metadata><metadata name="Designer">Second</metadata>',
    );
    expect(mw?.designer).toBe("First");
  });

  // What the source's regular expression read, pinned before it was replaced
  // by a forward-only scan (PR #24 review): the scan must read the same
  // elements the same way.
  describe("reads elements as the source's expression did", () => {
    const designer = (xml: string): string | null | undefined => extractMakerWorld(xml)?.designer;

    it("an element's text runs to the first close tag, start tags included", () => {
      expect(designer('<metadata name="Designer">D<metadata name="Title">T</metadata>')).toBe(
        'D<metadata name="Title">T',
      );
      // So the Designer inside an element left open is part of its text.
      expect(
        extractMakerWorld('<metadata name="Title">open <metadata name="Designer">D</metadata>'),
      ).toBeNull();
    });

    it("an element with no close tag after it is skipped", () => {
      expect(designer('<metadata name="Designer">D</metadata><metadata name="Designer">E')).toBe(
        "D",
      );
      expect(
        designer('<metadata name="Title">T</metadata><metadata name="Designer">D'),
      ).toBeUndefined();
    });

    it("a close tag may hold whitespace before its >, and only that", () => {
      expect(designer('<metadata name="Designer">D</metadata  >')).toBe("D");
      expect(designer('<metadata name="Designer">D</metadata\n>')).toBe("D");
      expect(designer('<metadata name="Designer">D</metadataX></metadata>')).toBe("D</metadataX>");
      expect(designer('<metadata name="Designer">D</metadata x></metadata>')).toBe(
        "D</metadata x>",
      );
    });

    it("the start tag: whitespace, other attributes, and quotes", () => {
      expect(designer('<metadata\n  name = "Designer" type="x">D</metadata>')).toBe("D");
      expect(designer("<metadata name='Designer' a=\"1\">D</metadata>")).toBe("D");
      expect(designer('<metadata name="Designer" a=">">D</metadata>')).toBe('">D');
      // Only "/>" closes the tag itself; "/ >" opens an element with text.
      expect(designer('<metadata name="Designer" / >D</metadata>')).toBe("D");
      expect(
        designer('<metadata name="Designer" x="1"/><metadata name="Designer">D</metadata>'),
      ).toBeUndefined();
    });

    it("a tag that is not a named metadata element is not read", () => {
      expect(designer('<metadatax name="Designer">D</metadata>')).toBeUndefined();
      expect(designer("<metadata name=Designer>D</metadata>")).toBeUndefined();
      expect(designer('<metadata id="1" name="Designer">D</metadata>')).toBeUndefined();
      expect(designer('<Metadata name="Designer">D</metadata>')).toBeUndefined();
    });
  });

  // New with the forward-only scan: like the converter's tag pattern, a start
  // tag cannot run past a <, so a tag left without its > ends at the next
  // tag instead of borrowing that tag's >. XML allows no < in a tag.
  it("a start tag whose attributes or name hold a < is not read", () => {
    const designer = (xml: string): string | null | undefined => extractMakerWorld(xml)?.designer;
    expect(designer('<metadata name="Designer" <x>D</metadata>')).toBeUndefined();
    expect(designer('<metadata name="Desi<gner">D</metadata>')).toBeUndefined();
    expect(designer('<metadata name="Title" <metadata name="Designer">D</metadata>')).toBe("D");
  });

  // Postgres text cannot hold a NUL, and every field here is stored (#78):
  // the title as the caption, the designer as the creator's name, the
  // description as Markdown and the licence as an id or a note. A NUL is
  // dropped from each; a field that was only NUL reads as absent.
  describe("a NUL in a field is dropped", () => {
    const NUL = "\u0000";

    it("from every field it returns", () => {
      const mw = extractMakerWorld(
        `<metadata name="Designer">Jane${NUL} Doe</metadata>` +
          `<metadata name="Title">Desk${NUL} Tidy</metadata>` +
          `<metadata name="Description">&amp;lt;p&amp;gt;Fits${NUL} a desk&amp;lt;/p&amp;gt;</metadata>` +
          `<metadata name="License">BY${NUL}-NC</metadata>`,
      );
      expect(mw).toEqual({
        title: "Desk Tidy",
        designer: "Jane Doe",
        descriptionHtml: "<p>Fits a desk</p>",
        license: "BY-NC",
      });
    });

    it("so a designer that was only NUL is no designer, and the file is not MakerWorld's", () => {
      expect(
        extractMakerWorld(
          `<metadata name="Designer">${NUL}</metadata><metadata name="Title">T</metadata>`,
        ),
      ).toBeNull();
    });

    it("so the generator's name split by a NUL is still the generator", () => {
      expect(
        extractMakerWorld(`<metadata name="Designer">Gridfinity${NUL} Layout Tool</metadata>`),
      ).toBeNull();
    });

    it("so other fields that were only NUL read as absent", () => {
      expect(
        extractMakerWorld(
          `<metadata name="Designer">Jane</metadata><metadata name="Title">${NUL}</metadata>` +
            `<metadata name="Description">${NUL}</metadata><metadata name="License">${NUL}</metadata>`,
        ),
      ).toEqual({ title: null, designer: "Jane", descriptionHtml: null, license: null });
    });
  });
});
