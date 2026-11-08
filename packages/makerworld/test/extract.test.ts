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
 <metadata name="Application">BambuStudio-02.08.02.61</metadata>
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <metadata name="CopyRight">[]</metadata>
 <metadata name="CreationDate">2026-10-26</metadata>
 <metadata name="Description">&amp;lt;h2&amp;gt;Spool Helper Kit&amp;lt;/h2&amp;gt;&amp;lt;p&amp;gt;won&amp;amp;#39;t&amp;lt;/p&amp;gt;</metadata>
 <metadata name="Designer">Example Designer</metadata>
 <metadata name="License">MakerWorld Exclusive License</metadata>
 <metadata name="Origin">profile</metadata>
 <metadata name="Title">Spool Helper Kit | Card &amp;amp; Empty Spool Fix</metadata>
 `;

describe("extractMakerWorld", () => {
  it("extracts title, designer, description and license from a real-shaped prefix", () => {
    const mw = extractMakerWorld(PREFIX);
    expect(mw).not.toBeNull();
    expect(mw?.title).toBe("Spool Helper Kit | Card & Empty Spool Fix");
    expect(mw?.designer).toBe("Example Designer");
    expect(mw?.license).toBe("MakerWorld Exclusive License");
    expect(mw?.descriptionHtml).toBe("<h2>Spool Helper Kit</h2><p>won&#39;t</p>");
  });

  it("the description becomes Markdown with the double-encoded apostrophe decoded once", () => {
    const mw = extractMakerWorld(PREFIX);
    expect(htmlToMarkdown(mw?.descriptionHtml)).toBe("## Spool Helper Kit\n\nwon't");
  });

  it("a description escaped only once gives the same Markdown", () => {
    const mw = extractMakerWorld(
      '<metadata name="Designer">D</metadata><metadata name="Description">&lt;h2&gt;Spool Helper Kit&lt;/h2&gt;&lt;p&gt;won&amp;#39;t&lt;/p&gt;</metadata>',
    );
    expect(htmlToMarkdown(mw?.descriptionHtml)).toBe("## Spool Helper Kit\n\nwon't");
  });

  it("a non-breaking space escaped twice disappears from the Markdown", () => {
    const mw = extractMakerWorld(
      '<metadata name="Designer">D</metadata><metadata name="Description">&amp;lt;p&amp;gt;Print 3 times.&amp;amp;nbsp;&amp;lt;/p&amp;gt;&amp;lt;p&amp;gt;&amp;amp;nbsp;&amp;lt;/p&amp;gt;</metadata>',
    );
    expect(htmlToMarkdown(mw?.descriptionHtml)).toBe("Print 3 times.");
  });

  it("a double-encoded title is decoded to the real character", () => {
    const mw = extractMakerWorld(
      '<metadata name="Designer">D</metadata><metadata name="Title">Don&amp;#39;t Panic &amp;amp; Print</metadata>',
    );
    expect(mw?.title).toBe("Don't Panic & Print");
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
        '<metadata name="Designer"></metadata><metadata name="MakerLab">Parametric Model Maker</metadata><metadata name="Title"></metadata>',
      ),
    ).toBeNull();
    // Another tool's export: a placeholder Title and nothing else.
    expect(
      extractMakerWorld(
        '<metadata name="Copyright">Copyright (c) 2023. All rights reserved.</metadata><metadata name="Designer"></metadata><metadata name="License"></metadata><metadata name="Title">Exported 3D Model</metadata>',
      ),
    ).toBeNull();
  });

  it("returns null when the Designer is the Gridfinity Layout Tool generator, case and spacing folded", () => {
    expect(
      extractMakerWorld(
        '<metadata name="Designer">Gridfinity Layout Tool</metadata><metadata name="Title">Untitled Bin</metadata>',
      ),
    ).toBeNull();
    expect(
      extractMakerWorld(
        '<metadata name="Designer">  gridfinity   LAYOUT tool </metadata><metadata name="Title">Untitled Bin</metadata>',
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
      '<metadata name="Description">&amp;lt;p&amp;gt;Use &amp;amp;lt;M3x8&amp;amp;gt; screws&amp;lt;/p&amp;gt;</metadata><metadata name="Designer">D</metadata>',
    );
    // CommonMark form: the < and > are backslash-escaped, so markdown-it shows
    // them as text and never reads an autolink or a tag.
    expect(htmlToMarkdown(mw?.descriptionHtml)).toBe("Use \\<M3x8\\> screws");
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
});
