import { describe, expect, it } from "vitest";
import { formatDecimal, formatList, languageName } from "../src/format.js";
import {
  canonicalLocale,
  matchLocale,
  parseAcceptLanguage,
  resolveLocale,
} from "../src/negotiate.js";
import { createTranslator, MISSING_TEXT } from "../src/translator.js";

describe("parseAcceptLanguage", () => {
  it("orders by q, keeps header order on a tie, and drops q=0 and *", () => {
    expect(parseAcceptLanguage("fr-CA;q=0.8, es-MX, en;q=0.8, de;q=0, *;q=0.1")).toEqual([
      "es-MX",
      "fr-CA",
      "en",
    ]);
  });

  it("answers nothing for no header or an absurdly long one", () => {
    expect(parseAcceptLanguage(undefined)).toEqual([]);
    expect(parseAcceptLanguage("en,".repeat(1000))).toEqual([]);
  });
});

describe("canonicalLocale", () => {
  it("canonicalises a code and refuses anything that is not a catalog name", () => {
    expect(canonicalLocale("es-mx")).toBe("es-MX");
    expect(canonicalLocale("pt-BR")).toBe("pt-BR");
    expect(canonicalLocale("../etc")).toBeUndefined();
    expect(canonicalLocale("en-US-u-ca-buddhist")).toBeUndefined();
    expect(canonicalLocale("")).toBeUndefined();
  });
});

describe("matchLocale and resolveLocale", () => {
  const available = ["en", "es", "fr", "pt-BR"];

  it("matches exactly, then by base language, then any region of it", () => {
    expect(matchLocale(["es-MX"], available)).toBe("es");
    expect(matchLocale(["FR"], available)).toBe("fr");
    expect(matchLocale(["pt"], available)).toBe("pt-BR");
    expect(matchLocale(["de", "fr"], available)).toBe("fr");
    expect(matchLocale(["de"], available)).toBeUndefined();
  });

  it("takes the saved choice first, the browser's next, English last", () => {
    expect(resolveLocale({ saved: "fr", wanted: ["es"], available })).toBe("fr");
    expect(resolveLocale({ saved: "de", wanted: ["es"], available })).toBe("es");
    expect(resolveLocale({ saved: undefined, wanted: ["de"], available })).toBe("en");
    expect(resolveLocale({ saved: "../x", wanted: [], available })).toBe("en");
  });
});

describe("createTranslator", () => {
  const en = { a: "Library", b: "{n, plural, one {# plate} other {# plates}}", c: "Hi {x}" };

  it("uses the language's message, and English for a missing or broken one", () => {
    const t = createTranslator("fr", { a: "Biblioth\u00e8que", c: "Salut {x" }, en);
    expect(t.t("a")).toBe("Biblioth\u00e8que");
    expect(t.t("b", { n: 2 })).toBe("2 plates");
    expect(t.t("c", { x: "Jon" })).toBe("Hi Jon");
    expect(t.has("a")).toBe(true);
    expect(t.has("b")).toBe(false);
  });

  it("never shows a raw key", () => {
    const t = createTranslator("fr", {}, en);
    expect(t.t("no.such.key")).toBe(MISSING_TEXT);
  });
});

describe("format helpers", () => {
  it("writes decimals in the language's mark with no grouping", () => {
    expect(formatDecimal("en", 1234.567, 2)).toBe("1234.57");
    expect(formatDecimal("fr", 41.44, 1)).toBe("41,4");
    expect(formatDecimal("es", 41, 1)).toBe("41");
  });

  it("writes a list as the UI did in English, and in the language elsewhere", () => {
    expect(formatList("en", ["a", "b", "c"])).toBe("a, b, c");
    expect(formatList("fr", ["a", "b", "c"])).toBe("a, b et c");
  });

  it("names a language in itself", () => {
    expect(languageName("es")).toBe("Espa\u00f1ol");
    expect(languageName("fr")).toBe("Fran\u00e7ais");
    expect(languageName("en")).toBe("English");
  });
});
