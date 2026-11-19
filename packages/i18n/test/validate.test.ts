import { describe, expect, it } from "vitest";
import { checkCatalog, checkEnglish, MAX_MESSAGE } from "../src/validate.js";

const EN = {
  "nav.library": "Library",
  "card.plates": "{count, plural, one {# plate} other {# plates}}",
  "trash.after": "Deleted for good after <time>{date}</time>.",
  "row.rename": "Rename {name}",
};

const goodFr = {
  $meta: { locale: "fr", status: "machine-draft" },
  "nav.library": "Biblioth\u00e8que",
  "card.plates": "{count, plural, one {# plateau} many {# de plateaux} other {# plateaux}}",
  "trash.after": "Supprim\u00e9 d\u00e9finitivement apr\u00e8s le <time>{date}</time>.",
  "row.rename": "Renommer {name}",
};

describe("checkCatalog, strict (the built-in catalogs)", () => {
  it("passes a complete catalog with the same placeholders, tags and plural cases", () => {
    const out = checkCatalog("fr", goodFr, EN, { strict: true });
    expect(out.problems).toEqual([]);
    expect(Object.keys(out.messages).sort()).toEqual(Object.keys(EN).sort());
    expect(out.meta.status).toBe("machine-draft");
  });

  // Every way a built-in catalog can break; each must be refused.
  it.each<[string, Record<string, unknown>, string]>([
    ["a missing key", { "nav.library": undefined }, "nav.library"],
    ["an unknown key", { "nav.libary": "x" }, "nav.libary"],
    ["a non-string value", { "row.rename": 3 }, "row.rename"],
    ["a dropped placeholder", { "row.rename": "Renommer" }, "row.rename"],
    ["a new placeholder", { "row.rename": "Renommer {nom}" }, "row.rename"],
    ["a dropped tag", { "trash.after": "Apr\u00e8s le {date}." }, "trash.after"],
    ["a new tag", { "trash.after": "Apr\u00e8s <b>le</b> <time>{date}</time>." }, "trash.after"],
    ["raw HTML", { "trash.after": 'Apr\u00e8s <a href="x">{date}</a>' }, "trash.after"],
    [
      "a missing plural case the locale has",
      { "card.plates": "{count, plural, one {# p} other {# ps}}" },
      "card.plates",
    ],
    [
      "a plural case the locale lacks",
      { "card.plates": "{count, plural, one {a} two {b} many {c} other {d}}" },
      "card.plates",
    ],
    ["a bidi override", { "nav.library": "Bib\u202eli" }, "nav.library"],
    ["a control character", { "nav.library": "Bib\nli" }, "nav.library"],
    ["a message too long", { "nav.library": "x".repeat(MAX_MESSAGE + 1) }, "nav.library"],
    ["a syntax error", { "row.rename": "Renommer {name" }, "row.rename"],
  ])("refuses %s", (_what, change, key) => {
    const data: Record<string, unknown> = { ...goodFr, ...change };
    for (const [k, v] of Object.entries(change)) if (v === undefined) delete data[k];
    const out = checkCatalog("fr", data, EN, { strict: true });
    expect(out.problems.map((p) => p.key)).toContain(key);
  });

  it("refuses a catalog with no $meta", () => {
    const { $meta: _, ...rest } = goodFr;
    expect(checkCatalog("fr", rest, EN, { strict: true }).problems).toContainEqual({
      key: "$meta",
      problem: "is missing",
    });
  });
});

describe("checkCatalog, lenient (a LOCALES_DIR file)", () => {
  it("keeps what passes, drops unknown keys and lists missing ones", () => {
    const out = checkCatalog(
      "de",
      { "nav.library": "Bibliothek", "nav.gone": "x", "row.rename": "Umbenennen {name}" },
      EN,
      { strict: false },
    );
    expect(out.messages).toEqual({ "nav.library": "Bibliothek", "row.rename": "Umbenennen {name}" });
    expect(out.unknown).toEqual(["nav.gone"]);
    expect(out.missing.sort()).toEqual(["card.plates", "trash.after"]);
    expect(out.problems).toEqual([]);
  });

  it("accepts a placeholder or tag left out, and plural cases the locale has", () => {
    const out = checkCatalog(
      "de",
      {
        "trash.after": "Endg\u00fcltig gel\u00f6scht nach {date}.",
        "card.plates": "{count, plural, one {# Platte} other {# Platten}}",
      },
      EN,
      { strict: false },
    );
    expect(Object.keys(out.messages).sort()).toEqual(["card.plates", "trash.after"]);
  });

  it("still refuses markup, new placeholders and bidi characters in a message", () => {
    const out = checkCatalog(
      "de",
      {
        "nav.library": "<b>Bibliothek</b>",
        "row.rename": "{evil}",
        "trash.after": "\u2066x\u2069",
      },
      EN,
      { strict: false },
    );
    expect(out.messages).toEqual({});
    expect(out.problems.map((p) => p.key).sort()).toEqual(["nav.library", "row.rename", "trash.after"]);
  });

  it.each([["an array", []], ["a string", "x"], ["null", null]])(
    "refuses a file that is %s",
    (_what, data) => {
      const out = checkCatalog("de", data, EN, { strict: false });
      expect(out.messages).toEqual({});
      expect(out.problems[0]?.problem).toBe("the file is not a JSON object");
    },
  );
});

describe("checkEnglish", () => {
  it("passes messages that parse and flags those that do not", () => {
    expect(checkEnglish(EN)).toEqual([]);
    expect(checkEnglish({ a: "x <i>y", b: 2 }).map((p) => p.key)).toEqual(["a", "b"]);
  });
});
