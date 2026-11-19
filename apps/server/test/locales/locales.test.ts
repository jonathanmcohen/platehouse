// The languages the server knows (locales/locales.ts): the built-in catalogs
// and a LOCALES_DIR a self-hoster drops files into (Jon, 2026-11-19), and
// GET /app/api/locales over them.
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { registerLocalesApi } from "../../src/app-api/locales.js";
import { createLocales, MAX_LOCALE_BYTES } from "../../src/locales/locales.js";

let dir: string;
let warnings: Array<{ details: Record<string, unknown>; message: string }>;
const log = {
  warn: (details: Record<string, unknown>, message: string) => warnings.push({ details, message }),
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "platehouse-locales-"));
  warnings = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function file(name: string, data: unknown): Promise<void> {
  return writeFile(join(dir, name), typeof data === "string" ? data : JSON.stringify(data));
}

describe("the built-in languages", () => {
  test("are English, Spanish and French, English first, the drafts marked for review", async () => {
    const list = await createLocales().list();
    expect(list.map((l) => l.code)).toEqual(expect.arrayContaining(["en", "es", "fr"]));
    expect(list[0]?.code).toBe("en");
    const es = list.find((l) => l.code === "es");
    expect(es).toMatchObject({ name: "Espa\u00f1ol", source: "built-in", machineDraft: true });
  });

  test("resolve a request: the saved choice, else Accept-Language, else English", async () => {
    const locales = createLocales();
    expect(await locales.resolve("fr", "es-MX,es;q=0.9")).toBe("fr");
    expect(await locales.resolve(undefined, "es-MX,es;q=0.9")).toBe("es");
    expect(await locales.resolve("xx", "de-DE")).toBe("en");
    expect(await locales.resolve(undefined, undefined)).toBe("en");
  });
});

describe("LOCALES_DIR", () => {
  test("a valid file is offered, and its missing keys are left to English", async () => {
    await file("de.json", { $meta: { name: "Deutsch" }, "shell.nav.library": "Bibliothek" });
    const locales = createLocales({ dir, log });
    expect((await locales.list()).find((l) => l.code === "de")).toEqual({
      code: "de",
      name: "Deutsch",
      source: "local",
      machineDraft: false,
      overlay: false,
      complete: false,
    });
    expect(await locales.messages("de")).toEqual({ "shell.nav.library": "Bibliothek" });
    const t = await locales.translator("de");
    expect(t.t("shell.nav.library")).toBe("Bibliothek");
    expect(t.t("shell.nav.trash")).toBe("Trash");
  });

  test("markup, unknown keys and new placeholders are dropped and logged by key, never by value", async () => {
    await file("de.json", {
      "shell.nav.library": "<b>Bibliothek</b>",
      "shell.nav.trash": "Papierkorb {evil}",
      "not.a.key": "geheim-wert",
      "shell.nav.tags": "Schlagw\u00f6rter",
    });
    const locales = createLocales({ dir, log });
    expect(await locales.messages("de")).toEqual({ "shell.nav.tags": "Schlagw\u00f6rter" });
    const logged = JSON.stringify(warnings);
    expect(logged).toContain("not.a.key");
    expect(logged).toContain("shell.nav.library");
    expect(logged).not.toContain("geheim-wert");
    expect(logged).not.toContain("Bibliothek");
  });

  test.each<[string, (d: string) => Promise<void>]>([
    ["a file that is not JSON", (d) => writeFile(join(d, "de.json"), "{ nope")],
    ["a JSON array", (d) => writeFile(join(d, "de.json"), "[]")],
    [
      "a file over the size cap",
      (d) => writeFile(join(d, "de.json"), `{"x":"${"a".repeat(MAX_LOCALE_BYTES)}"}`),
    ],
    [
      "a symlink",
      async (d) => {
        const outside = join(d, "..", `outside-${Date.now()}.json`);
        await writeFile(outside, JSON.stringify({ "shell.nav.library": "Bibliothek" }));
        await symlink(outside, join(d, "de.json"));
      },
    ],
    ["a folder named like a catalog", (d) => mkdir(join(d, "de.json"))],
    [
      "a name that is no locale code",
      (d) =>
        writeFile(join(d, "../de.json.json"), "{}").then(() =>
          writeFile(join(d, "deutsch.json"), JSON.stringify({ "shell.nav.library": "B" })),
        ),
    ],
  ])("refuses %s", async (_what, make) => {
    await make(dir);
    const codes = (await createLocales({ dir, log }).list()).map((l) => l.code);
    expect(codes).not.toContain("de");
    expect(codes).not.toContain("deutsch");
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("an en.json cannot replace English", async () => {
    await file("en.json", { "shell.nav.library": "Hijacked" });
    const locales = createLocales({ dir, log });
    expect((await locales.translator("en")).t("shell.nav.library")).toBe("Library");
  });

  test("a file for a built-in language overlays it key by key", async () => {
    await file("es.json", { "shell.nav.library": "Mi biblioteca" });
    const locales = createLocales({ dir, log });
    const t = await locales.translator("es");
    expect(t.t("shell.nav.library")).toBe("Mi biblioteca");
    // The web app bundles es, so the list tells it to ask for the overlay.
    expect((await locales.list()).find((l) => l.code === "es")).toMatchObject({
      source: "built-in",
      overlay: true,
    });
    expect((await createLocales().list()).find((l) => l.code === "es")?.overlay).toBe(false);
    expect(t.t("shell.nav.trash")).toBe("Papelera");
  });

  test("a file dropped in later is offered without a restart", async () => {
    const locales = createLocales({ dir, log });
    expect(await locales.available()).not.toContain("it");
    await file("it.json", { "shell.nav.library": "Libreria" });
    // A later modification time, as a copy into the folder gives it.
    const later = new Date(Date.now() + 5_000);
    await utimes(dir, later, later);
    expect(await locales.available()).toContain("it");
  });

  test("a file rewritten in place is read again, with the folder's time left as it was", async () => {
    await file("de.json", { "shell.nav.library": "Bibliothek" });
    const before = new Date(Date.now() - 60_000);
    await utimes(dir, before, before);
    const locales = createLocales({ dir, log });
    expect((await locales.translator("de")).t("shell.nav.library")).toBe("Bibliothek");
    // An editor saving over the file: new words, a later time, the folder untouched.
    await file("de.json", { "shell.nav.library": "Meine Bibliothek" });
    const later = new Date(Date.now() + 5_000);
    await utimes(join(dir, "de.json"), later, later);
    await utimes(dir, before, before);
    expect((await locales.translator("de")).t("shell.nav.library")).toBe("Meine Bibliothek");
  });

  test("a missing folder offers the built-in languages only", async () => {
    const locales = createLocales({ dir: join(dir, "nowhere"), log });
    expect((await locales.list()).every((l) => l.source === "built-in")).toBe(true);
  });
});

describe("GET /app/api/locales", () => {
  async function withApp(run: (app: ReturnType<typeof Fastify>) => Promise<void>) {
    await file("de.json", { "shell.nav.library": "Bibliothek" });
    const app = Fastify();
    try {
      await registerLocalesApi(app, createLocales({ dir, log }));
      await run(app);
    } finally {
      await app.close();
    }
  }

  test("lists every language, and answers a language's checked messages", async () => {
    await withApp(async (app) => {
      const list = await app.inject({ method: "GET", url: "/app/api/locales" });
      expect(list.statusCode).toBe(200);
      expect(list.headers["cache-control"]).toBe("no-store");
      const codes = (list.json() as { locales: Array<{ code: string }> }).locales.map(
        (l) => l.code,
      );
      expect(codes).toEqual(expect.arrayContaining(["en", "es", "fr", "de"]));
      const de = await app.inject({ method: "GET", url: "/app/api/locales/de" });
      expect(de.json()).toEqual({ code: "de", messages: { "shell.nav.library": "Bibliothek" } });
    });
  });

  test.each(["xx", "..%2Fetc", "en-US-u-nu-thai"])("answers 404 for %s", async (code) => {
    await withApp(async (app) => {
      const res = await app.inject({ method: "GET", url: `/app/api/locales/${code}` });
      expect(res.statusCode).toBe(404);
    });
  });
});
