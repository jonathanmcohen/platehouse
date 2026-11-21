// The library's sort (the maintainer, 2026-11-19) against Postgres 17: the order is
// made in the database, every order is total (models that tie on its key
// go by id, so numbered pages never repeat or skip one), the time and weight
// orders total the plates for the selected printer by the cards' own rule
// with models without numbers last either way, and Select all matching's
// ids come in the same order, capped as View all is. Every model and file
// is synthetic: models made through the repository or ingested from
// generated .3mf and STL files (no designer file).
import type { Printer } from "@platehouse/slicer-contract";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  type AppLibrary,
  type AppLibraryPages,
  createAppLibrary,
  type LibraryCard,
} from "../../../src/app-api/library.js";
import { type DisplayContext, plateNumbers } from "../../../src/estimates/display.js";
import { createCollections } from "../../../src/library/collections.js";
import { LIBRARY_SORTS, type LibrarySort } from "../../../src/repos/models.js";
import {
  ASCII_STL,
  build3mf,
  type IngestEnv,
  startIngestEnv,
  writeUpload,
} from "../support/ingest.js";
import { marker } from "../support/library.js";

const P1S: Printer = {
  id: "Bambu Lab P1S 0.4 nozzle",
  model: "Bambu Lab P1S",
  modelId: "C12",
  nozzle: 0.4,
};
const X1C: Printer = {
  id: "Bambu Lab X1 Carbon 0.4 nozzle",
  model: "Bambu Lab X1 Carbon",
  modelId: "BL-P001",
  nozzle: 0.4,
};
const CONTEXT: DisplayContext = { printerId: P1S.id, orcaVersion: "2.5.0", printers: [P1S, X1C] };
const NO_MENU: DisplayContext = { printerId: P1S.id, orcaVersion: "2.5.0", printers: [] };

let env: IngestEnv;
let context: DisplayContext = CONTEXT;

function libraryWith(pagedMatchCap?: number): AppLibrary {
  return createAppLibrary({
    db: env.db,
    displayContext: async () => context,
    plateNumbers: (ctx, plateId) => plateNumbers(env.db, ctx, plateId),
    ...(pagedMatchCap === undefined ? {} : { pagedMatchCap }),
  });
}

async function page(query: Parameters<AppLibrary["list"]>[0]): Promise<AppLibraryPages> {
  return (await libraryWith().list(query)) as AppLibraryPages;
}

/** Every page of the search, limit models a page, in order: what the pager walks. */
async function walk(q: string, sort: LibrarySort, limit: number): Promise<LibraryCard[]> {
  const first = await page({ q, sort, page: 1, limit });
  const all = [...first.models];
  for (let n = 2; n <= first.pageCount; n += 1) {
    all.push(...(await page({ q, sort, page: n, limit })).models);
  }
  return all;
}

async function ingest(name: string, bytes: Buffer | string) {
  const tmpPath = await writeUpload(env, bytes);
  return env.ingest.ingestFile({ tmpPath, originalName: name, target: "new" });
}

/** Gives every plate of the model a finished Platehouse estimate for the P1S. */
async function estimateForP1S(fileId: string, timeSeconds: number, weightGrams: number) {
  const plates = await env.db
    .selectFrom("plates")
    .select("id")
    .where("fileId", "=", fileId)
    .execute();
  for (const plate of plates) {
    const pending = await env.repos.estimates.upsertPending({
      plateId: plate.id,
      printerId: P1S.id,
      printerModelId: P1S.modelId,
      nozzle: P1S.nozzle,
      slicer: "OrcaSlicer",
      slicerVersion: "2.5.0",
    });
    await env.db
      .updateTable("estimates")
      .set({ status: "ok", timeSeconds, weightGrams, finishedAt: new Date() })
      .where("id", "=", pending.id)
      .execute();
  }
}

beforeAll(async () => {
  env = await startIngestEnv();
});

afterAll(async () => {
  await env?.stop();
});

describe("ties never repeat or skip a model across pages", () => {
  test("seven models alike in name, date and numbers walk in id order under every sort", async () => {
    const word = marker();
    const ids: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      ids.push((await env.repos.models.create({ name: `Tie ${word}` })).id);
    }
    // The same date added for all seven, so newest and oldest tie too.
    await env.db
      .updateTable("models")
      .set({ createdAt: sql`timestamptz '2026-11-01 12:00:00+00'` })
      .where("id", "in", ids)
      .execute();
    const up = [...ids].sort();
    const down = [...up].reverse();
    for (const sort of LIBRARY_SORTS) {
      const walked = (await walk(word, sort, 2)).map((m) => m.id);
      expect(walked, sort).toHaveLength(7);
      expect(new Set(walked).size, sort).toBe(7);
      expect(walked, sort).toEqual(sort === "newest" || sort === "name-desc" ? down : up);
      // Select all matching lists the same models in the same order.
      expect((await libraryWith().ids({ q: word, sort })).ids, sort).toEqual(walked);
    }
  });

  test("a model added before the page boundary between two pages makes page 2 repeat page 1's last", async () => {
    // Numbered pages are offsets into the order, so a model added ahead of
    // the boundary while the library is paged moves every later one along by
    // one: page 2 then starts with the model page 1 ended on. View all drops
    // that repeat (LibraryPage's loadRest; library-sort-select.test.tsx). The
    // names are single letters after a common word, so they sort the same in
    // any collation, and "a" sorts before all four.
    const word = marker();
    const made: Record<string, string> = {};
    for (const letter of ["b", "d", "f", "h"]) {
      made[letter] = (await env.repos.models.create({ name: `Moving ${letter} ${word}` })).id;
    }
    const first = await page({ q: word, sort: "name-asc", page: 1, limit: 2 });
    expect(first.models.map((m) => m.id)).toEqual([made.b, made.d]);
    await env.repos.models.create({ name: `Moving a ${word}` });
    const second = await page({ q: word, sort: "name-asc", page: 2, limit: 2 });
    expect(second.models.map((m) => m.id)).toEqual([made.d, made.f]);
    expect(second.models[0]?.id).toBe(first.models.at(-1)?.id);
  });
});

describe("date added and name", () => {
  test("no search: newest first by default, and the answer names it", async () => {
    const word = marker();
    const shelf = `Sort shelf ${word}`;
    const made: string[] = [];
    for (const [i, day] of ["2026-11-03", "2026-11-01", "2026-11-02"].entries()) {
      const id = (await env.repos.models.create({ name: `Dated ${i} ${word}` })).id;
      await env.db
        .updateTable("models")
        .set({ createdAt: sql`cast(${`${day} 12:00:00+00`} as timestamptz)` })
        .where("id", "=", id)
        .execute();
      expect(await createCollections(env.db).addToCollection(id, shelf)).toBe(true);
      made.push(id);
    }
    const [nov3, nov1, nov2] = made;
    const plain = await page({ collection: shelf, page: 1 });
    expect(plain.sort).toBe("newest");
    expect(plain.models.map((m) => m.id)).toEqual([nov3, nov2, nov1]);
    const oldest = await page({ collection: shelf, page: 1, sort: "oldest" });
    expect(oldest.models.map((m) => m.id)).toEqual([nov1, nov2, nov3]);
  });

  test("a search: best match first by default", async () => {
    const word = marker();
    await env.repos.models.create({ name: `Searched ${word}` });
    expect((await page({ q: word, page: 1 })).sort).toBe("relevance");
  });

  test("name ignores case: apple, Banana, cherry, and back", async () => {
    const word = marker();
    const banana = (await env.repos.models.create({ name: `Banana ${word}` })).id;
    const cherry = (await env.repos.models.create({ name: `cherry ${word}` })).id;
    const apple = (await env.repos.models.create({ name: `apple ${word}` })).id;
    expect((await page({ q: word, page: 1, sort: "name-asc" })).models.map((m) => m.id)).toEqual([
      apple,
      banana,
      cherry,
    ]);
    expect((await page({ q: word, page: 1, sort: "name-desc" })).models.map((m) => m.id)).toEqual([
      cherry,
      banana,
      apple,
    ]);
  });
});

describe("print time, weight and plate count", () => {
  let word: string;
  /** The models by letter: A one plate, B two, C partial, D an STL, E numbers from an estimate. */
  const ids: Record<"A" | "B" | "C" | "D" | "E", string> = { A: "", B: "", C: "", D: "", E: "" };

  beforeAll(async () => {
    word = marker();
    // build3mf gives plate n 1000 * n seconds and 10 * n + 0.5 grams.
    ids.A = (
      await ingest(`A ${word}.3mf`, build3mf({ plates: 1, sliced: [1], nonce: `a${word}` }))
    ).modelId;
    ids.B = (
      await ingest(`B ${word}.3mf`, build3mf({ plates: 2, sliced: [1, 2], nonce: `b${word}` }))
    ).modelId;
    ids.C = (
      await ingest(`C ${word}.3mf`, build3mf({ plates: 2, sliced: [1], nonce: `c${word}` }))
    ).modelId;
    ids.D = (await ingest(`D ${word}.stl`, `${ASCII_STL}\n`)).modelId;
    // Sliced for the X1C only; a finished Platehouse estimate for the P1S
    // gives it 500 s and 40 g for the selected printer.
    const e = await ingest(
      `E ${word}.3mf`,
      build3mf({ plates: 1, sliced: [1], printerModelId: X1C.modelId, nonce: `e${word}` }),
    );
    ids.E = e.modelId;
    await estimateForP1S(e.fileId, 500, 40);
  });

  async function order(sort: LibrarySort): Promise<string[]> {
    const shown = await page({ q: word, page: 1, sort });
    const byId = Object.fromEntries(Object.entries(ids).map(([k, v]) => [v, k]));
    return shown.models.map((m) => byId[m.id] ?? `?${m.name}`);
  }

  test("time: shortest or longest first, models without a time for the printer last either way", async () => {
    expect(await order("time-asc")).toEqual(["E", "A", "B", "C", "D"]);
    expect(await order("time-desc")).toEqual(["B", "A", "E", "C", "D"]);
  });

  test("weight: lightest or heaviest first, models without a weight last either way", async () => {
    expect(await order("weight-asc")).toEqual(["A", "B", "E", "C", "D"]);
    expect(await order("weight-desc")).toEqual(["E", "B", "A", "C", "D"]);
  });

  test("plate count: most or fewest first, ties by name", async () => {
    expect(await order("plates-desc")).toEqual(["B", "C", "A", "E", "D"]);
    expect(await order("plates-asc")).toEqual(["D", "A", "E", "B", "C"]);
  });

  test("the order agrees with the cards' own totals on every page", async () => {
    for (const sort of ["time-asc", "time-desc", "weight-asc", "weight-desc"] as const) {
      const key = sort.startsWith("time") ? "timeSeconds" : "weightGrams";
      const values = (await walk(word, sort, 2)).map((c) => c[key]);
      const known = values.filter((v): v is number => v !== null);
      // Every card with numbers comes before every card without.
      expect(values.slice(0, known.length), sort).toEqual(known);
      const sorted = [...known].sort((a, b) => (sort.endsWith("asc") ? a - b : b - a));
      expect(known, sort).toEqual(sorted);
    }
  });

  test("while the printer menu is unread, a file's own numbers do not count, as on the cards", async () => {
    context = NO_MENU;
    try {
      // Only E's Platehouse estimate counts; with the menu read, B led.
      expect(await order("time-desc")).toEqual(["E", "A", "B", "C", "D"]);
      const cards = (await page({ q: word, page: 1, sort: "time-desc" })).models;
      expect(cards.map((c) => c.timeSeconds)).toEqual([500, null, null, null, null]);
    } finally {
      context = CONTEXT;
    }
  });

  test("with the header switched to another of My printers, time is totalled for that printer", async () => {
    // PR #240's switch: ?printer= one of My printers. E's file was sliced for
    // the X1C (1000 s); A, B and C were sliced for the P1S, so for the X1C
    // they have no numbers, and with the P1S shown B led.
    context = { ...CONTEXT, myPrinters: [P1S.id, X1C.id] };
    try {
      const shown = await page({ q: word, page: 1, sort: "time-desc", printer: X1C.id });
      expect(shown.printer).toBe(X1C.id);
      const byId = Object.fromEntries(Object.entries(ids).map(([k, v]) => [v, k]));
      expect(shown.models.map((m) => byId[m.id])).toEqual(["E", "A", "B", "C", "D"]);
      expect(shown.models.map((c) => c.timeSeconds)).toEqual([1000, null, null, null, null]);
      // Select all matching is ordered the same way.
      const all = await libraryWith().ids({ q: word, sort: "time-desc", printer: X1C.id });
      expect(all.ids).toEqual(shown.models.map((m) => m.id));
      // A printer that is not one of My printers shows the default's order.
      const fallback = await page({ q: word, page: 1, sort: "time-desc", printer: "Nope" });
      expect(fallback.printer).toBe(P1S.id);
      expect(fallback.models.map((m) => byId[m.id])).toEqual(["B", "A", "E", "C", "D"]);
    } finally {
      context = CONTEXT;
    }
  });

  test("a time sort with no models to total is still a page, never an error", async () => {
    const none = await page({ q: marker(), page: 1, sort: "time-desc" });
    expect([none.total, none.models.length]).toEqual([0, 0]);
  });
});

describe("Select all matching", () => {
  test("every match's id, capped as View all is, and says when it is capped", async () => {
    const word = marker();
    for (let i = 0; i < 5; i += 1) await env.repos.models.create({ name: `Pick ${i} ${word}` });
    const all = await libraryWith().ids({ q: word, sort: "name-asc" });
    expect(all.ids).toHaveLength(5);
    expect(all.capped).toBe(false);
    const capped = await libraryWith(3).ids({ q: word, sort: "name-asc" });
    expect(capped.ids).toEqual(all.ids.slice(0, 3));
    expect(capped.capped).toBe(true);
    // Exactly the cap is not capped.
    expect((await libraryWith(5).ids({ q: word, sort: "name-asc" })).capped).toBe(false);
  });

  test("a trashed model is never among them", async () => {
    const word = marker();
    const keep = (await env.repos.models.create({ name: `Kept ${word}` })).id;
    const gone = (await env.repos.models.create({ name: `Gone ${word}` })).id;
    await env.repos.models.trash(gone);
    expect((await libraryWith().ids({ q: word })).ids).toEqual([keep]);
  });

  test("the numbered page's total is capped by the same single read", async () => {
    const word = marker();
    for (let i = 0; i < 4; i += 1) await env.repos.models.create({ name: `Cap ${i} ${word}` });
    const capped = (await libraryWith(3).list({
      q: word,
      page: 1,
      limit: 2,
      sort: "newest",
    })) as AppLibraryPages;
    expect([capped.total, capped.totalCapped, capped.pageCount]).toEqual([3, true, 2]);
  });
});

test("the sort indexes exist on live models (migrations 0008 and 0009)", async () => {
  const { rows } = await sql<{ indexname: string; indexdef: string }>`
    select indexname, indexdef from pg_indexes
    where tablename = 'models' and indexname in ('models_live_created', 'models_live_name')
    order by indexname`.execute(env.db);
  expect(rows.map((r) => r.indexname)).toEqual(["models_live_created", "models_live_name"]);
  for (const row of rows) expect(row.indexdef).toMatch(/WHERE \(trashed_at IS NULL\)/);
  // 0009: the name index holds the first 200 characters, never the whole name.
  const name = rows.find((r) => r.indexname === "models_live_name")?.indexdef ?? "";
  expect(name).toMatch(/lower\("left"\(name, 200\)\), "left"\(name, 200\)/);
  expect(name).not.toMatch(/lower\(name\)/);
});

// A name is up to 500 characters (ingest, rename and the public API), and
// the name index once held two whole copies of it. 500 characters of CJK
// script (3 bytes each in UTF-8) or emoji (4 bytes) made an index row over
// btree's 2704-byte limit, so the insert or rename failed. The index now
// holds a 200-character prefix (migration 0009).
describe("long names in any script", () => {
  const cjk = Array.from({ length: 500 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join("");
  const emoji = Array.from({ length: 500 }, (_, i) => String.fromCodePoint(0x1f300 + i)).join("");

  test("a 500-character CJK or emoji name can be made, renamed and sorted", async () => {
    const shelf = `Long names ${marker()}`;
    const made: string[] = [];
    for (const name of [cjk, emoji]) {
      const id = (await env.repos.models.create({ name })).id;
      expect(await createCollections(env.db).addToCollection(id, shelf)).toBe(true);
      made.push(id);
    }
    const [first, second] = made;
    if (first === undefined || second === undefined) throw new Error("no models made");
    // A rename to the other long name, and back.
    await env.db.updateTable("models").set({ name: emoji }).where("id", "=", first).execute();
    await env.db.updateTable("models").set({ name: cjk }).where("id", "=", first).execute();
    const sorted = await page({ collection: shelf, page: 1, sort: "name-asc" });
    expect(new Set(sorted.models.map((m) => m.id))).toEqual(new Set(made));
  });

  test("names alike in their first 200 characters still sort by the rest, ignoring case", async () => {
    const word = marker();
    const shelf = `Alike ${word}`;
    const prefix = `Alike ${word} `.padEnd(200, "x");
    const made = new Map<string, string>();
    for (const end of ["c", "B", "a"]) {
      const id = (await env.repos.models.create({ name: `${prefix}${end}` })).id;
      expect(await createCollections(env.db).addToCollection(id, shelf)).toBe(true);
      made.set(end, id);
    }
    const up = ["a", "B", "c"].map((end) => made.get(end));
    const asc = await page({ collection: shelf, page: 1, sort: "name-asc" });
    expect(asc.models.map((m) => m.id)).toEqual(up);
    const desc = await page({ collection: shelf, page: 1, sort: "name-desc" });
    expect(desc.models.map((m) => m.id)).toEqual([...up].reverse());
  });
});
