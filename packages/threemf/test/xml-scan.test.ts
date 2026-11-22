// The streaming tag scanner the plate mesh reader reads model parts with
// (issue #358). The same text must give the same tags however the inflated
// stream happens to be cut into chunks, a cut inside a tag, a quote, a
// comment or a multi-byte character included.
import { describe, expect, it } from "vitest";
import { Damaged } from "../src/errors.js";
import { attrs, MAX_TAG_CHARS, type Tag, TagScanner } from "../src/xml-scan.js";

function scan(text: string, chunk = Number.POSITIVE_INFINITY): Tag[] {
  const tags: Tag[] = [];
  const scanner = new TagScanner((t) => tags.push(t));
  const bytes = Buffer.from(text, "utf8");
  const step = Math.min(chunk, bytes.length || 1);
  for (let i = 0; i < bytes.length; i += step) scanner.write(bytes.subarray(i, i + step));
  scanner.end();
  return tags;
}

const brief = (tags: Tag[]) =>
  tags.map((t) => `${t.closing ? "/" : ""}${t.name}${t.selfClosing ? "/" : ""}`);

/** Non-ASCII from a code point, so this file stays ASCII. */
const E_ACUTE = String.fromCodePoint(0xe9);

const DOC = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!-- a comment with <vertex x="9"/> inside -->',
  `<model xmlns:p="urn:x"><metadata name="Title">Caf${E_ACUTE} &amp; <![CDATA[<b>not a tag</b>]]></metadata>`,
  '<resources><object id="1" name="a > b"><mesh><vertices>',
  '<vertex x="1.5" y=\'2\' z="-3e2"/><vertex x="0" y="0" z="0" />',
  "</vertices></mesh></object>",
  '<object id="2"><components><p:component p:path="/3D/Objects/a&amp;b.model" objectid="1"/></components></object>',
  "</resources></model>",
].join("\n");

const EXPECTED = [
  "model",
  "metadata",
  "/metadata",
  "resources",
  "object",
  "mesh",
  "vertices",
  "vertex/",
  "vertex/",
  "/vertices",
  "/mesh",
  "/object",
  "object",
  "components",
  "component/",
  "/components",
  "/object",
  "/resources",
  "/model",
];

describe("TagScanner", () => {
  it("hands over the tags, skipping comments, CDATA, processing instructions and text", () => {
    expect(brief(scan(DOC))).toEqual(EXPECTED);
  });

  it.each([1, 2, 3, 7, 64])("gives the same tags when the text comes %i bytes at a time", (n) => {
    expect(scan(DOC, n)).toEqual(scan(DOC));
  });

  it("does not end a tag at a > inside a quoted value", () => {
    const object = scan(DOC).find((t) => t.name === "object");
    expect(attrs(object?.raw ?? "").get("name")).toBe("a > b");
  });

  it("reads attributes by local name, decoding entities, in either quote", () => {
    const tags = scan(DOC);
    const vertex = tags.find((t) => t.name === "vertex");
    expect(Object.fromEntries(attrs(vertex?.raw ?? ""))).toEqual({ x: "1.5", y: "2", z: "-3e2" });
    const component = tags.find((t) => t.name === "component");
    expect(attrs(component?.raw ?? "").get("path")).toBe("/3D/Objects/a&b.model");
  });

  it("refuses a DOCTYPE as damage, wherever the chunk cuts it", () => {
    for (const n of [1, 4, 100]) {
      expect(() => scan('<?xml version="1.0"?><!DOCTYPE m [<!ENTITY a "b">]><m/>', n)).toThrow(
        Damaged,
      );
    }
  });

  it("refuses text that ends inside a tag", () => {
    expect(() => scan('<model><vertex x="1')).toThrow(Damaged);
  });

  it("refuses a tag longer than the limit rather than holding it", () => {
    const scanner = new TagScanner(() => undefined);
    const quoteOpen = Buffer.from('<vertex x="', "utf8");
    scanner.write(quoteOpen);
    expect(() => scanner.write(Buffer.alloc(MAX_TAG_CHARS, 0x31))).toThrow(Damaged);
  });
});
