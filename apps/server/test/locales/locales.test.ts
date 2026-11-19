// The languages the server knows (locales/locales.ts): the built-in catalogs
// and a LOCALES_DIR a self-hoster drops files into (Jon, 2026-11-19), and
// GET /app/api/locales over them.
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { registerLocalesApi } from "../../src/app-api/locales.js";
import {
  createLocales,
  type Locales,
  type LocalesFs,
  type LocalesOptions,
  MAX_LOCALE_BYTES,
} from "../../src/locales/locales.js";

/**
 * A filesystem for LOCALES_DIR that counts every call and can be held: with
 * hold set, every call waits forever, as a hung network mount does; with
 * delayMs set, every call takes that long and then answers.
 */
function testFs(): {
  fs: LocalesFs;
  calls: () => number;
  gate: { hold: boolean; delayMs: number };
} {
  let calls = 0;
  const gate = { hold: false, delayMs: 0 };
  async function through<T>(run: () => Promise<T>): Promise<T> {
    calls += 1;
    if (gate.hold) return new Promise<T>(() => {});
    if (gate.delayMs > 0) await new Promise((r) => setTimeout(r, gate.delayMs));
    return run();
  }
  return {
    fs: {
      stat: (path) => through(() => stat(path)),
      readdir: (path) => through(() => readdir(path)),
      lstat: (path) => through(() => lstat(path)),
      readFile: (path, encoding) => through(() => readFile(path, encoding)),
    },
    calls: () => calls,
    gate,
  };
}

/** Whether a promise settles within ms: a request that waited on the folder would not. */
async function settlesWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((r) => {
    timer = setTimeout(() => r(false), ms);
  });
  const done = await Promise.race([work.then(() => true), late]);
  clearTimeout(timer);
  return done;
}

const opened: Locales[] = [];

/** createLocales, with its first read of the folder finished, closed after the test. */
async function started(options: LocalesOptions = {}): Promise<Locales> {
  const locales = createLocales(options);
  opened.push(locales);
  await locales.ready();
  return locales;
}

const BAD = "locales: LOCALES_DIR cannot be read, so only the built-in languages are offered";
const SLOW = "locales: LOCALES_DIR is slow to read, so the languages last read from it are offered";
const GOOD = "locales: LOCALES_DIR can be read again";

let dir: string;
/** A second folder, outside LOCALES_DIR, for what a symlink points at; removed after each test. */
let outsideDir: string;
let warnings: Array<{ details: Record<string, unknown>; message: string }>;
const log = {
  warn: (details: Record<string, unknown>, message: string) => warnings.push({ details, message }),
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "platehouse-locales-"));
  outsideDir = await mkdtemp(join(tmpdir(), "platehouse-locales-outside-"));
  warnings = [];
});

afterEach(async () => {
  for (const locales of opened.splice(0)) locales.close();
  await rm(dir, { recursive: true, force: true });
  await rm(outsideDir, { recursive: true, force: true });
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
    const locales = await started({ dir, log });
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
    const locales = await started({ dir, log });
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
        const outside = join(outsideDir, "de.json");
        await writeFile(outside, JSON.stringify({ "shell.nav.library": "Bibliothek" }));
        await symlink(outside, join(d, "de.json"));
      },
    ],
    ["a folder named like a catalog", (d) => mkdir(join(d, "de.json"))],
    [
      "a name that is no locale code",
      (d) => writeFile(join(d, "deutsch.json"), JSON.stringify({ "shell.nav.library": "B" })),
    ],
  ])("refuses %s", async (_what, make) => {
    await make(dir);
    const codes = (await (await started({ dir, log })).list()).map((l) => l.code);
    expect(codes).not.toContain("de");
    expect(codes).not.toContain("deutsch");
    expect(warnings.length).toBeGreaterThan(0);
  });

  test("an en.json cannot replace English", async () => {
    await file("en.json", { "shell.nav.library": "Hijacked" });
    const locales = await started({ dir, log });
    expect((await locales.translator("en")).t("shell.nav.library")).toBe("Library");
  });

  test("a file for a built-in language overlays it key by key", async () => {
    await file("es.json", { "shell.nav.library": "Mi biblioteca" });
    const locales = await started({ dir, log });
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

  test("a file dropped in later is offered after the next read, without a restart", async () => {
    const locales = await started({ dir, log });
    expect(await locales.available()).not.toContain("it");
    await file("it.json", { "shell.nav.library": "Libreria" });
    // A later modification time, as a copy into the folder gives it.
    const later = new Date(Date.now() + 5_000);
    await utimes(dir, later, later);
    await locales.refresh();
    expect(await locales.available()).toContain("it");
  });

  test("a file rewritten in place is read again, with the folder's time left as it was", async () => {
    await file("de.json", { "shell.nav.library": "Bibliothek" });
    const before = new Date(Date.now() - 60_000);
    await utimes(dir, before, before);
    const locales = await started({ dir, log });
    expect((await locales.translator("de")).t("shell.nav.library")).toBe("Bibliothek");
    // An editor saving over the file: new words, a later time, the folder untouched.
    await file("de.json", { "shell.nav.library": "Meine Bibliothek" });
    const later = new Date(Date.now() + 5_000);
    await utimes(join(dir, "de.json"), later, later);
    await utimes(dir, before, before);
    await locales.refresh();
    expect((await locales.translator("de")).t("shell.nav.library")).toBe("Meine Bibliothek");
  });

  test("a missing folder offers the built-in languages only, and logs each change of state once", async () => {
    const missing = join(dir, "nowhere");
    const locales = await started({ dir: missing, log });
    expect((await locales.list()).every((l) => l.source === "built-in")).toBe(true);
    expect(await locales.available()).not.toContain("de");
    const said = (message: string) => warnings.filter((w) => w.message === message);
    expect(said(BAD)).toEqual([{ details: { code: "ENOENT" }, message: BAD }]);
    // Still missing at the next reads: nothing more in the log.
    await locales.refresh();
    await locales.refresh();
    expect(said(BAD)).toHaveLength(1);
    // Mounted later, it is read, once said; gone again, said once again.
    await mkdir(missing);
    await writeFile(join(missing, "de.json"), JSON.stringify({ "shell.nav.library": "B" }));
    await locales.refresh();
    expect(await locales.available()).toContain("de");
    expect(said(GOOD)).toEqual([{ details: {}, message: GOOD }]);
    await rm(missing, { recursive: true });
    await locales.refresh();
    expect(await locales.available()).not.toContain("de");
    expect(said(BAD)).toHaveLength(2);
  });

  test("a LOCALES_DIR that is a file, not a folder, is logged by its error code", async () => {
    await file("not-a-folder", "{}");
    const locales = await started({ dir: join(dir, "not-a-folder"), log });
    expect((await locales.list()).every((l) => l.source === "built-in")).toBe(true);
    expect(warnings).toContainEqual({ details: { code: "ENOTDIR" }, message: BAD });
  });

  test("a request is answered from memory while a read of the folder is held open forever", async () => {
    await file("de.json", { "shell.nav.library": "Bibliothek" });
    const disk = testFs();
    const locales = await started({ dir, log, fs: disk.fs, readLimitMs: 20 });
    expect(await locales.available()).toContain("de");

    // The mount hangs: a read starts and never finishes.
    disk.gate.hold = true;
    void locales.refresh();
    expect(await settlesWithin(locales.resolve("de", undefined), 50)).toBe(true);
    expect(await locales.resolve("de", undefined)).toBe("de");
    expect(await settlesWithin(locales.translator("de"), 50)).toBe(true);
    expect((await locales.translator("de")).t("shell.nav.library")).toBe("Bibliothek");
    expect(await settlesWithin(locales.list(), 50)).toBe(true);
    // Past the read limit the log says so, once, however many reads are asked for.
    await vi.waitFor(() => expect(warnings.filter((w) => w.message === SLOW)).toHaveLength(1));
    void locales.refresh();
    void locales.refresh();
    expect(warnings.filter((w) => w.message === SLOW)).toEqual([
      { details: { readLimitMs: 20 }, message: SLOW },
    ]);
    expect(warnings.filter((w) => w.message === BAD)).toHaveLength(0);
  });

  test("a read that is slow but finishes delays no request and is logged once", async () => {
    await file("de.json", { "shell.nav.library": "Bibliothek" });
    const disk = testFs();
    const locales = await started({ dir, log, fs: disk.fs, readLimitMs: 15 });
    disk.gate.delayMs = 40;
    for (let i = 0; i < 3; i += 1) {
      const reading = locales.refresh();
      expect(await settlesWithin(locales.available(), 10)).toBe(true);
      expect(await locales.available()).toContain("de");
      await reading;
    }
    // Slow at every read: one line when it went slow, none per read, and no
    // "can be read again" for a read that only finished late.
    expect(warnings.filter((w) => w.message === SLOW)).toHaveLength(1);
    expect(warnings.filter((w) => w.message === BAD)).toHaveLength(0);
    expect(warnings.filter((w) => w.message === GOOD)).toHaveLength(0);
    // Quick again: said once.
    disk.gate.delayMs = 0;
    await locales.refresh();
    expect(warnings.filter((w) => w.message === GOOD)).toHaveLength(1);
  });

  test("a slow read that then finds the folder gone says the built-in languages only are offered", async () => {
    await file("de.json", { "shell.nav.library": "Bibliothek" });
    const disk = testFs();
    const locales = await started({ dir, log, fs: disk.fs, readLimitMs: 15 });
    expect(await locales.available()).toContain("de");
    await rm(dir, { recursive: true });
    disk.gate.delayMs = 40;
    await locales.refresh();
    // Slow first (the last read kept), then gone (built-in only): each said once.
    expect(warnings.filter((w) => w.message === SLOW)).toEqual([
      { details: { readLimitMs: 15 }, message: SLOW },
    ]);
    expect(warnings.filter((w) => w.message === BAD)).toEqual([
      { details: { code: "ENOENT" }, message: BAD },
    ]);
    expect(await locales.available()).not.toContain("de");
    // Still gone, still slow: nothing more.
    await locales.refresh();
    expect(warnings.filter((w) => w.message === SLOW)).toHaveLength(1);
    expect(warnings.filter((w) => w.message === BAD)).toHaveLength(1);
  });

  test("a folder that comes back slow after it could not be read says its languages are offered again", async () => {
    const missing = join(dir, "nowhere");
    const disk = testFs();
    const locales = await started({ dir: missing, log, fs: disk.fs, readLimitMs: 15 });
    const said = (message: string) => warnings.filter((w) => w.message === message);
    expect(said(BAD)).toEqual([{ details: { code: "ENOENT" }, message: BAD }]);
    // The mount comes back, but slow: its languages are offered, and the log says so.
    await mkdir(missing);
    await writeFile(join(missing, "de.json"), JSON.stringify({ "shell.nav.library": "B" }));
    disk.gate.delayMs = 40;
    await locales.refresh();
    expect(await locales.available()).toContain("de");
    expect(said(SLOW)).toEqual([{ details: { readLimitMs: 15 }, message: SLOW }]);
    expect(said(BAD)).toHaveLength(1);
    expect(said(GOOD)).toHaveLength(0);
    // Still slow: nothing more. Quick again: said once.
    await locales.refresh();
    expect(said(SLOW)).toHaveLength(1);
    disk.gate.delayMs = 0;
    await locales.refresh();
    expect(said(GOOD)).toEqual([{ details: {}, message: GOOD }]);
  });

  test("a change is picked up by the background read on its timer", async () => {
    const locales = await started({ dir, log, refreshMs: 25 });
    expect(await locales.available()).not.toContain("it");
    await file("it.json", { "shell.nav.library": "Libreria" });
    const later = new Date(Date.now() + 5_000);
    await utimes(dir, later, later);
    await vi.waitFor(async () => expect(await locales.available()).toContain("it"));
  });

  test("no request reads the filesystem, and closing stops the background reads", async () => {
    await file("de.json", { "shell.nav.library": "Bibliothek" });
    const disk = testFs();
    const locales = await started({ dir, log, fs: disk.fs, refreshMs: 60_000 });
    const afterFirstRead = disk.calls();
    expect(afterFirstRead).toBeGreaterThan(0);
    for (let i = 0; i < 25; i += 1) {
      await locales.list();
      await locales.available();
      await locales.messages("de");
      await locales.resolve("de", "es");
      await locales.translator("de");
    }
    expect(disk.calls()).toBe(afterFirstRead);

    const timed = testFs();
    const ticking = await started({ dir, log, fs: timed.fs, refreshMs: 10 });
    await vi.waitFor(() => expect(timed.calls()).toBeGreaterThan(afterFirstRead));
    ticking.close();
    await new Promise((r) => setTimeout(r, 30));
    const atClose = timed.calls();
    await new Promise((r) => setTimeout(r, 50));
    expect(timed.calls()).toBe(atClose);
  });

  test("startup waits for the first read no longer than the read limit", async () => {
    const disk = testFs();
    disk.gate.hold = true;
    const locales = createLocales({ dir, log, fs: disk.fs, readLimitMs: 20 });
    opened.push(locales);
    expect(await settlesWithin(locales.ready(), 500)).toBe(true);
    expect((await locales.list()).every((l) => l.source === "built-in")).toBe(true);
  });
});

describe("GET /app/api/locales", () => {
  async function withApp(run: (app: ReturnType<typeof Fastify>) => Promise<void>) {
    await file("de.json", { "shell.nav.library": "Bibliothek" });
    const app = Fastify();
    try {
      await registerLocalesApi(app, await started({ dir, log }));
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
