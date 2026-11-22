import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- a plain .mjs script with no type declarations.
import { canonicalCatalog } from "../scripts/format.mjs";
import { formatMessage } from "../src/message.js";
import { builtinLocalesDir, readBuiltinCatalogs } from "../src/node.js";
import { checkCatalog, checkEnglish, type Messages, messagesOf } from "../src/validate.js";

// The CI check on the built-in catalogs (the maintainer, 2026-11-19): English parses,
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
      expect([...text].some((ch) => (ch.codePointAt(0) ?? 0) > 0x7f)).toBe(false);
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

// How long the estimates for a printer take (the 0.1.1-rc.1 live check:
// Spanish showed "quedan unas 1 hora y 9 minutos"). The article sat outside
// the plural, so it was plural for one hour; it now agrees for 1 and for
// more, and the sentences around it no longer need a verb that agrees with
// the time.
describe("Spanish and French wording of a time left", () => {
  const es = messagesOf(catalogs.get("es") as Record<string, unknown>) as Messages;
  const fr = messagesOf(catalogs.get("fr") as Record<string, unknown>) as Messages;
  const say = (
    locale: string,
    messages: Messages,
    key: string,
    values: Record<string, string | number>,
  ) => formatMessage(locale, messages[key] as string, values);

  it.each([
    ["printers.about.hours", { hours: 1 }, "alrededor de una hora"],
    ["printers.about.hours", { hours: 3 }, "alrededor de 3 horas"],
    ["printers.about.minutes", { minutes: 1 }, "alrededor de un minuto"],
    ["printers.about.minutes", { minutes: 5 }, "alrededor de 5 minutos"],
    ["printers.about.hoursMinutes", { hours: 1, minutes: 9 }, "alrededor de una hora y 9 minutos"],
    ["printers.about.hoursMinutes", { hours: 2, minutes: 1 }, "alrededor de 2 horas y un minuto"],
  ])("Spanish %s with %o is %s", (key, values, want) => {
    expect(say("es", es, key, values)).toBe(want);
  });

  it("Spanish says one plate waiting and the time left with nothing to agree", () => {
    expect(say("es", es, "printers.waiting", { waiting: 1, time: "alrededor de una hora" })).toBe(
      "1 placa pendiente de estimar; tiempo restante: alrededor de una hora.",
    );
    expect(say("es", es, "printers.waiting", { waiting: 2, time: "alrededor de 3 horas" })).toBe(
      "2 placas pendientes de estimar; tiempo restante: alrededor de 3 horas.",
    );
    expect(
      say("es", es, "printers.waitingAhead", {
        waiting: 1,
        time: "alrededor de un minuto",
        ahead: 1,
      }),
    ).toBe(
      `1 placa pendiente de estimar; tiempo restante: alrededor de un minuto, contando 1 placa o renderizado m${String.fromCodePoint(0xe1)}s en cola por delante.`,
    );
  });

  it.each([
    ["printers.about.hours", { hours: 1 }, "environ 1 heure"],
    ["printers.about.hours", { hours: 3 }, "environ 3 heures"],
    ["printers.about.minutes", { minutes: 1 }, "environ 1 minute"],
    ["printers.about.hoursMinutes", { hours: 1, minutes: 9 }, "environ 1 heure et 9 minutes"],
    ["printers.about.hoursMinutes", { hours: 2, minutes: 1 }, "environ 2 heures et 1 minute"],
  ])("French %s with %o is %s", (key, values, want) => {
    expect(say("fr", fr, key, values)).toBe(want);
  });

  it("French says one plate waiting and the time left in agreement", () => {
    expect(say("fr", fr, "printers.waiting", { waiting: 1, time: "environ 1 heure" })).toBe(
      "1 plateau en attente d'estimation, encore environ 1 heure.",
    );
  });
});

describe("English wording", () => {
  it("one plate waiting for a removed printer takes a singular verb (issue #288)", () => {
    const message = english["printers.removeMessage"] as string;
    expect(formatMessage("en", message, { waiting: 1, name: "A1 mini" })).toBe(
      "A1 mini leaves My printers. The 1 plate still waiting to be estimated for it is dropped. Numbers already made for it are kept.",
    );
    expect(formatMessage("en", message, { waiting: 2, name: "A1 mini" })).toContain(
      "The 2 plates still waiting to be estimated for it are dropped.",
    );
  });
});
