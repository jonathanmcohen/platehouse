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

  it("tells onScan of every character before it looks, an unfinished tag counted each time it is looked at", () => {
    const seen: number[] = [];
    const scanner = new TagScanner(
      () => undefined,
      (chars) => seen.push(chars),
    );
    scanner.write(Buffer.from('<vertex x="1', "utf8"));
    scanner.write(Buffer.from('" y="2"/><a/>', "utf8"));
    scanner.end();
    // 12 new, then the 12 carried over again with 13 new, then the end.
    expect(seen).toEqual([12, 25, 0]);
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

/**
 * The attribute regex attrs() used before it walked the tag itself. It reads
 * the same attributes, but backtracks over a long run with no = after it
 * (review of PR #368), so it is kept here only as the reference for what
 * attrs() must read, on short tags.
 */
function attrsByRegex(raw: string): Map<string, string> {
  const re = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  const out = new Map<string, string>();
  for (let m = re.exec(raw); m !== null; m = re.exec(raw)) {
    const qualified = m[1] ?? "";
    const colon = qualified.indexOf(":");
    const name = colon < 0 ? qualified : qualified.slice(colon + 1);
    if (!out.has(name)) out.set(name, m[2] ?? m[3] ?? "");
  }
  return out;
}

describe("attrs", () => {
  it("reads what the old attribute regex read, on every shape of short tag", () => {
    // Seeded, so a failing tag can be found again; no entities, which the
    // regex left to decodeEntities just as attrs() does.
    const alphabet = ["a", "b", ":", "=", '"', "'", " ", "\t", "\n", "/", "\u00a0", "x="];
    let seed = 12345;
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return (seed >>> 8) % n;
    };
    for (let k = 0; k < 20_000; k++) {
      let raw = "";
      const length = next(24);
      for (let i = 0; i < length; i++) raw += alphabet[next(alphabet.length)];
      expect(Object.fromEntries(attrs(raw)), JSON.stringify(raw)).toEqual(
        Object.fromEntries(attrsByRegex(raw)),
      );
    }
  });

  // Each shape below is a tag the size MAX_TAG_CHARS lets through. Read in
  // time that grows with the square of its length, as the old regex did,
  // one such tag took minutes; in one pass it takes milliseconds.
  it.each([
    ["a run with no = after it", `object ${"a".repeat(MAX_TAG_CHARS)}`],
    ["a quote never closed", `object x="${"a".repeat(MAX_TAG_CHARS)}`],
    ["spaces with no = after them", `object a${" ".repeat(MAX_TAG_CHARS)}`],
    ["= with no quote after it", `object a=${" ".repeat(MAX_TAG_CHARS)}b`],
    ["many short names with no =", `object ${"a ".repeat(MAX_TAG_CHARS / 2)}`],
    ["many names and = with no quote", `object ${"a=".repeat(MAX_TAG_CHARS / 2)}`],
  ])("reads a megabyte tag of %s in one pass", (_, raw) => {
    const started = performance.now();
    const read = attrs(raw);
    const took = performance.now() - started;
    expect(read.size).toBe(0);
    expect(took).toBeLessThan(1000);
  });
});

describe("named entities", () => {
  const value = (v: string) => attrs(`<a x="${v}"/>`).get("x");

  it("decodes the five XML names", () => {
    expect(value("a &amp; b &lt;&gt; &quot;&apos;")).toBe("a & b <> \"'");
  });

  it("leaves a name that is not one of them as written, Object.prototype's included", () => {
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(value(`&${name};`)).toBe(`&${name};`);
    }
  });
});
