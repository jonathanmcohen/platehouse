// The streaming tag scanner the plate mesh reader reads model parts with
// (issue #358). The same text must give the same tags however the inflated
// stream happens to be cut into chunks, a cut inside a tag, a quote, a
// comment or a multi-byte character included.
import { describe, expect, it } from "vitest";
import { Damaged } from "../src/errors.js";
import { attrSpan, attrs, MAX_TAG_CHARS, type Tag, TagScanner } from "../src/xml-scan.js";

function scan(text: string, chunk = Number.POSITIVE_INFINITY): Tag[] {
  const tags: Tag[] = [];
  const scanner = new TagScanner((t) => tags.push(t));
  const bytes = Buffer.from(text, "utf8");
  const step = Math.min(chunk, bytes.length || 1);
  for (let i = 0; i < bytes.length; i += step) scanner.write(bytes.subarray(i, i + step));
  scanner.end();
  return tags;
}

/** The same, given the text already decoded. */
function scanText(text: string): Tag[] {
  const tags: Tag[] = [];
  const scanner = new TagScanner((t) => tags.push(t));
  scanner.writeText(text);
  scanner.end();
  return tags;
}

/** Each tag's slice of the text it came from, by its offsets. */
const slices = (text: string, tags: Tag[]) => tags.map((t) => text.slice(t.start, t.end));

const brief = (tags: Tag[]) =>
  tags.map((t) => `${t.closing ? "/" : ""}${t.name}${t.selfClosing ? "/" : ""}`);

/** Non-ASCII from a code point, so this file stays ASCII. */
const E_ACUTE = String.fromCodePoint(0xe9);
/** Four bytes in UTF-8 and two units in a JavaScript string. */
const EMOJI = String.fromCodePoint(0x1f600);

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

  it.each([1, 2, 3, 7, 64])(
    "gives the same tags and offsets when the text comes %i bytes at a time",
    (n) => {
      const whole = scan(DOC);
      expect(whole[0]?.start).toBe(DOC.indexOf("<model"));
      expect(scan(DOC, n)).toEqual(whole);
    },
  );

  it("gives each tag the offsets of its < and just past its >, counted in characters", () => {
    const text = `${E_ACUTE}<!-- <x/> --><a x="${E_ACUTE}"><![CDATA[<y/>]]><b k='>'/>${EMOJI}</a>`;
    expect(slices(text, scanText(text))).toEqual([`<a x="${E_ACUTE}">`, "<b k='>'/>", "</a>"]);
  });

  it("slices every tag of the document exactly from its offsets", () => {
    const tags = scan(DOC);
    expect(slices(DOC, tags)).toEqual(
      tags.map((t) =>
        t.closing ? DOC.slice(t.start, t.end) : `<${t.raw}${t.selfClosing ? "/" : ""}>`,
      ),
    );
    for (const t of tags.filter((t) => t.closing)) {
      expect(DOC.slice(t.start, t.end)).toMatch(new RegExp(`^</(?:[^:>]+:)?${t.name}>$`));
    }
  });

  it.each([1, 7, 64])(
    "gives from writeText the tags and offsets write gives for the UTF-8 bytes, cut every %i bytes",
    (n) => {
      const text = `<model><object id="1" name="caf${E_ACUTE} ${EMOJI}"/><item objectid="1"/></model>`;
      const tags = scanText(text);
      expect(tags).toEqual(scan(text, n));
      expect(slices(text, tags)[2]).toBe('<item objectid="1"/>');
    },
  );

  it("is settled up to the start of a tag still open at the end of a write", () => {
    const tags: Tag[] = [];
    const scanner = new TagScanner((t) => tags.push(t));
    scanner.writeText(`<a/>${E_ACUTE}<b x="1`);
    const settled = scanner.settled;
    expect(settled).toBe(5);
    scanner.writeText('"/>text');
    expect(tags[1]?.start).toBe(settled);
    expect(scanner.settled).toBe(5 + '<b x="1"/>text'.length);
    scanner.end();
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

  it("finds the same value attrSpan finds, on every shape of short tag", () => {
    // The same seeded tags as above. No entities, so the span's text is the value.
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
      const read = attrs(raw);
      for (const name of new Set([...read.keys(), "a", "b", "x", "ab", ""])) {
        const span = attrSpan(raw, name);
        const found = span === null ? undefined : raw.slice(span.start, span.end);
        expect(found, `${JSON.stringify(raw)} ${JSON.stringify(name)}`).toBe(read.get(name));
      }
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

describe("attrSpan", () => {
  const value = (raw: string, name: string) => {
    const span = attrSpan(raw, name);
    return span === null ? null : raw.slice(span.start, span.end);
  };

  it("gives the range of a value in double quotes, undecoded", () => {
    const raw = 'item objectid="1" transform="1 0 0 0 1 0 0 0 1 5 &amp; 0" printable="1"';
    expect(value(raw, "transform")).toBe("1 0 0 0 1 0 0 0 1 5 &amp; 0");
    expect(attrSpan(raw, "transform")).toEqual({ start: 29, end: 56 });
  });

  it("gives the range of a value in single quotes", () => {
    expect(value("item transform='1 0 0 0 1 0 0 0 1 2 3 4'", "transform")).toBe(
      "1 0 0 0 1 0 0 0 1 2 3 4",
    );
  });

  it("finds an attribute by its local name", () => {
    expect(value('item p:transform = "9 8"', "transform")).toBe("9 8");
  });

  it("gives the first of a repeated name, as attrs does", () => {
    const raw = 'item transform="first" p:transform="second" transform="third"';
    expect(value(raw, "transform")).toBe("first");
    expect(attrs(raw).get("transform")).toBe("first");
  });

  it("gives null for a value whose quote is never closed, as attrs skips it", () => {
    const raw = 'item transform="1 0 0';
    expect(attrSpan(raw, "transform")).toBeNull();
    expect(attrs(raw).has("transform")).toBe(false);
  });

  it("gives null for a name the tag does not have", () => {
    expect(attrSpan('item objectid="1"', "transform")).toBeNull();
  });
});
