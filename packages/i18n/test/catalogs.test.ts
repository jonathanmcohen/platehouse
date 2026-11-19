import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- a plain .mjs script with no type declarations.
import { canonicalCatalog } from "../scripts/format.mjs";
import { builtinLocalesDir, readBuiltinCatalogs } from "../src/node.js";
import { checkCatalog, checkEnglish, type Messages, messagesOf } from "../src/validate.js";

// The CI check on the built-in catalogs (Jon, 2026-11-19): English parses,
// and every other built-in language has exactly English's keys, the same
// placeholders and tags, every plural case its language has, and $meta;
// every file is in the canonical form pnpm i18n:format writes (ASCII only).
const DIR = builtinLocalesDir();
const catalogs = readBuiltinCatalogs(DIR);
const english = messagesOf(catalogs.get("en") as Record<string, unknown>) as Messages;
const others = [...catalogs.keys()].filter((code) => code !== "en");

describe("the built-in catalogs", () => {
  it("include English, Spanish and French", () => {
    expect([...catalogs.keys()].sort()).toEqual(expect.arrayContaining(["en", "es", "fr"]));
  });

  it("English has messages, and every one parses", () => {
    expect(Object.keys(english).length).toBeGreaterThan(300);
    expect(checkEnglish(catalogs.get("en"))).toEqual([]);
  });

  it.each(others)("%s matches English key for key", (code) => {
    const out = checkCatalog(code, catalogs.get(code), english, { strict: true });
    expect(out.problems).toEqual([]);
    expect(out.meta.locale).toBe(code);
  });

  it.each(others)("%s is marked for review while it is a machine draft", (code) => {
    const out = checkCatalog(code, catalogs.get(code), english, { strict: true });
    if (out.meta.status === "machine-draft") expect(out.meta.review?.needed).toBe(true);
  });

  it.each(readdirSync(DIR).filter((n) => n.endsWith(".json")))(
    "%s is in canonical form (pnpm i18n:format)",
    (name) => {
      const text = readFileSync(join(DIR, name), "utf8");
      expect(text).toBe(canonicalCatalog(JSON.parse(text)));
      expect(/[^\x00-\x7f]/.test(text)).toBe(false);
    },
  );

  it("the check would catch a key Spanish lacks or an extra one", () => {
    const es = { ...(catalogs.get("es") as Record<string, unknown>) };
    const [first] = Object.keys(english);
    delete es[first as string];
    es["not.a.key"] = "x";
    const keys = checkCatalog("es", es, english, { strict: true }).problems.map((p) => p.key);
    expect(keys).toEqual(expect.arrayContaining([first, "not.a.key"]));
  });
});
