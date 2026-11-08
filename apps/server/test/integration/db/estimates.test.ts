// Build plan Task 4: the estimates repository against a migrated Postgres 17.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { migrate } from "../../../src/db/migrate.js";
import { createRepos, type Repos } from "../../../src/repos/index.js";
import {
  sqlState,
  startTestPostgres,
  type TestDatabase,
  type TestPostgres,
} from "../support/db.js";
import { seedPlate } from "../support/fixtures.js";

let pgc: TestPostgres;
let t: TestDatabase;
let repos: Repos;

beforeAll(async () => {
  pgc = await startTestPostgres();
  t = await pgc.freshDatabase();
  await migrate(t.db);
  repos = createRepos(t.db);
});

afterAll(async () => {
  await pgc?.stop();
});

const P1S = "Bambu Lab P1S 0.4 nozzle";
const X1C = "Bambu Lab X1 Carbon 0.4 nozzle";

const pending = (plateId: string, printerId = P1S, slicerVersion = "2.5.0") => ({
  plateId,
  printerId,
  printerModelId: "C12",
  nozzle: 0.4,
  slicer: "OrcaSlicer",
  slicerVersion,
  processProfile: "0.20mm Standard @BBL X1C",
  filamentProfiles: ["Generic PLA @BBL P1S"],
});

const fileNumbers = (plateId: string, printerId = X1C) => ({
  plateId,
  printerId,
  printerModelId: "BL-P001",
  nozzle: 0.4,
  slicer: "BambuStudio",
  slicerVersion: "02.03.00.70",
  timeSeconds: 5025,
  weightGrams: 41.37,
  filaments: [
    { slot: 1, type: "PLA", color: "#FFFFFF", grams: 30.5 },
    { slot: 2, type: "PETG", color: null, grams: 10.87 },
  ],
});

describe("estimates uniqueness", () => {
  test("estimates unique per plate, source, printer and slicer version", async () => {
    const { plate } = await seedPlate(repos);

    // The same key twice from the file's own numbers is refused.
    await repos.estimates.insertFile(fileNumbers(plate.id));
    expect(await sqlState(repos.estimates.insertFile(fileNumbers(plate.id)))).toBe("23505");

    // A Platehouse estimate for the same printer is a different source: allowed.
    const first = await repos.estimates.upsertPending(pending(plate.id, X1C));
    // Upserting the same key again keeps the one row.
    const again = await repos.estimates.upsertPending(pending(plate.id, X1C));
    expect(again.id).toBe(first.id);

    // Another printer or another slicer version is another row.
    const otherPrinter = await repos.estimates.upsertPending(pending(plate.id, P1S));
    const otherVersion = await repos.estimates.upsertPending(pending(plate.id, X1C, "2.6.0"));
    expect(new Set([first.id, otherPrinter.id, otherVersion.id]).size).toBe(3);

    const rows = await t.db
      .selectFrom("estimates")
      .select(["source", "printerId", "slicerVersion"])
      .where("plateId", "=", plate.id)
      .orderBy("createdAt")
      .execute();
    expect(rows).toHaveLength(4);
  });

  test("two file estimates with no slicer version for one printer still collide", async () => {
    const { plate } = await seedPlate(repos);
    const numbers = { ...fileNumbers(plate.id), slicer: null, slicerVersion: null };
    await repos.estimates.insertFile(numbers);
    expect(await sqlState(repos.estimates.insertFile(numbers))).toBe("23505");
  });
});

describe("estimates.upsertPending", () => {
  test("a new estimate is pending with no attempts and no numbers", async () => {
    const { plate } = await seedPlate(repos);
    const e = await repos.estimates.upsertPending(pending(plate.id));
    expect(e).toMatchObject({
      plateId: plate.id,
      source: "platehouse",
      printerId: P1S,
      printerModelId: "C12",
      nozzle: 0.4,
      slicer: "OrcaSlicer",
      slicerVersion: "2.5.0",
      processProfile: "0.20mm Standard @BBL X1C",
      filamentProfiles: ["Generic PLA @BBL P1S"],
      status: "pending",
      attempts: 0,
      timeSeconds: null,
      weightGrams: null,
      failureReason: null,
      finishedAt: null,
      filaments: [],
    });
  });

  test("a failed estimate goes back to pending with its failure cleared", async () => {
    const { plate } = await seedPlate(repos);
    const e = await repos.estimates.upsertPending(pending(plate.id));
    await t.db
      .updateTable("estimates")
      .set({
        status: "failed",
        attempts: 3,
        failureCode: -17,
        failureReason: "process_not_compatible",
        failureDetail: "detail",
        finishedAt: new Date(),
      })
      .where("id", "=", e.id)
      .execute();

    const retried = await repos.estimates.upsertPending(pending(plate.id));

    expect(retried).toMatchObject({
      id: e.id,
      status: "pending",
      attempts: 0,
      failureCode: null,
      failureReason: null,
      failureDetail: null,
      finishedAt: null,
    });
  });

  test("an estimate that is done, running or pending is left as it is", async () => {
    const { plate } = await seedPlate(repos);
    const e = await repos.estimates.upsertPending(pending(plate.id));
    for (const state of [
      { status: "running" as const, attempts: 1 },
      { status: "ok" as const, attempts: 1, timeSeconds: 600, weightGrams: 12.5 },
    ]) {
      await t.db.updateTable("estimates").set(state).where("id", "=", e.id).execute();
      const again = await repos.estimates.upsertPending(pending(plate.id));
      expect(again).toMatchObject({ id: e.id, ...state });
    }
  });
});

describe("estimates.current", () => {
  test("returns the Platehouse estimate for that plate, printer and Orca version, with its filaments", async () => {
    const { plate } = await seedPlate(repos);
    const e = await repos.estimates.upsertPending(pending(plate.id));
    await t.db
      .updateTable("estimates")
      .set({ status: "ok", timeSeconds: 600, weightGrams: 12.5, finishedAt: new Date() })
      .where("id", "=", e.id)
      .execute();
    await t.db
      .insertInto("estimateFilaments")
      .values([
        { estimateId: e.id, slot: 2, type: "PETG", color: null, grams: 2.5 },
        { estimateId: e.id, slot: 1, type: "PLA", color: "#00AE42", grams: 10 },
      ])
      .execute();

    const got = await repos.estimates.current(plate.id, P1S, "2.5.0");

    expect(got).toMatchObject({ id: e.id, status: "ok", timeSeconds: 600, weightGrams: 12.5 });
    expect(got?.filaments).toEqual([
      { slot: 1, type: "PLA", color: "#00AE42", grams: 10 },
      { slot: 2, type: "PETG", color: null, grams: 2.5 },
    ]);
  });

  test("answers undefined for another version, another printer, or the file's own numbers", async () => {
    const { plate } = await seedPlate(repos);
    await repos.estimates.upsertPending(pending(plate.id));
    await repos.estimates.insertFile(fileNumbers(plate.id, X1C));
    expect(await repos.estimates.current(plate.id, P1S, "2.6.0")).toBeUndefined();
    expect(await repos.estimates.current(plate.id, X1C, "2.5.0")).toBeUndefined();
    expect(await repos.estimates.current(plate.id, X1C, "02.03.00.70")).toBeUndefined();
  });
});

describe("estimates.insertFile", () => {
  test("stores Bambu's own numbers as a finished estimate with its filaments", async () => {
    const { plate } = await seedPlate(repos);
    const e = await repos.estimates.insertFile(fileNumbers(plate.id));
    expect(e).toMatchObject({
      source: "file",
      printerId: X1C,
      printerModelId: "BL-P001",
      status: "ok",
      timeSeconds: 5025,
      weightGrams: 41.37,
    });
    expect(e.finishedAt).toBeInstanceOf(Date);
    expect(e.filaments).toEqual([
      { slot: 1, type: "PLA", color: "#FFFFFF", grams: 30.5 },
      { slot: 2, type: "PETG", color: null, grams: 10.87 },
    ]);
  });

  test("a failed insert leaves no estimate row behind", async () => {
    const { plate } = await seedPlate(repos);
    const bad = {
      ...fileNumbers(plate.id),
      filaments: [
        { slot: 1, type: "PLA", color: null, grams: 1 },
        { slot: 1, type: "PLA", color: null, grams: 1 },
      ],
    };
    expect(await sqlState(repos.estimates.insertFile(bad))).toBe("23505");
    const rows = await t.db
      .selectFrom("estimates")
      .select("id")
      .where("plateId", "=", plate.id)
      .execute();
    expect(rows).toEqual([]);
  });
});

describe("estimates schema checks", () => {
  test("a finished estimate must carry a time and a weight", async () => {
    const { plate } = await seedPlate(repos);
    const e = await repos.estimates.upsertPending(pending(plate.id));
    expect(
      await sqlState(
        t.db.updateTable("estimates").set({ status: "ok" }).where("id", "=", e.id).execute(),
      ),
    ).toBe("23514");
  });

  test("a failed estimate must carry a reason", async () => {
    const { plate } = await seedPlate(repos);
    const e = await repos.estimates.upsertPending(pending(plate.id));
    expect(
      await sqlState(
        t.db.updateTable("estimates").set({ status: "failed" }).where("id", "=", e.id).execute(),
      ),
    ).toBe("23514");
  });

  test("an unknown status or source is refused", async () => {
    const { plate } = await seedPlate(repos);
    const e = await repos.estimates.upsertPending(pending(plate.id));
    expect(
      await sqlState(
        t.db
          .updateTable("estimates")
          // biome-ignore lint/suspicious/noExplicitAny: writing a value the type forbids, on purpose
          .set({ status: "done" as any })
          .where("id", "=", e.id)
          .execute(),
      ),
    ).toBe("23514");
    expect(
      await sqlState(
        t.db
          .updateTable("estimates")
          // biome-ignore lint/suspicious/noExplicitAny: writing a value the type forbids, on purpose
          .set({ source: "guess" as any })
          .where("id", "=", e.id)
          .execute(),
      ),
    ).toBe("23514");
  });
});
