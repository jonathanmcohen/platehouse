// The description re-conversion on upgrade (#357) against a real Postgres 17
// and S3 test server: ingest records where a description came from
// (migration 0014), and a run converts stored descriptions again from their
// .3mf in the bucket, leaves every description it cannot prove untouched as
// it is, and records itself so a second run does nothing. The decisions
// themselves are unit-tested in test/library/reconvert.test.ts.
import { CONVERTER_VERSION } from "@platehouse/makerworld";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { descriptionSha256 } from "../../../src/library/description-hash.js";
import {
  createDescriptionReconvert,
  type DescriptionReconvert,
  RECONVERT_PAUSED,
  RECONVERT_STEP,
  type ReconvertResult,
  SourceOutage,
  storeTextReader,
} from "../../../src/library/reconvert.js";
import { descriptionsRepo, progressName } from "../../../src/repos/descriptions.js";
import { build3mf, type IngestEnv, startIngestEnv, writeUpload } from "../support/ingest.js";
import { marker } from "../support/library.js";

/** A run given no stop, which goes to the end and never pauses. */
async function runToEnd(run: DescriptionReconvert): Promise<ReconvertResult | null> {
  const result = await run.run();
  if (result === RECONVERT_PAUSED) throw new Error("a run given no stop paused");
  return result;
}

// One description the converters write three ways (see the unit test).
const HTML =
  "<p><b>Note:</b>Use</p><boostme><boosttitle>Boost Me</boosttitle><boostcontent>Hi</boostcontent></boostme>";
const BY_RC = "**Note:**Use\n\nBoost MeHi";
const NOW = "Note:Use\n\nBoost Me\n\nHi";
const NOTE = "License on MakerWorld: Standard Digital File License";

let env: IngestEnv;

beforeAll(async () => {
  env = await startIngestEnv();
});

afterAll(async () => {
  await env?.stop();
});

beforeEach(async () => {
  await env.db.deleteFrom("upgradeSteps").execute();
  await env.db.deleteFrom("upgradeLeases").execute();
});

/** A new model from a MakerWorld .3mf with HTML as its description. */
async function ingestMakerWorld(html: string, license?: string) {
  const result = await env.ingest.ingestFile({
    tmpPath: await writeUpload(
      env,
      build3mf({
        plates: 1,
        nonce: marker(),
        makerWorld: {
          designer: "Synthetic Designer",
          title: `Synthetic ${marker()}`,
          descriptionHtml: html,
          ...(license === undefined ? {} : { license }),
        },
      }),
    ),
    originalName: "design.3mf",
    target: "new",
  });
  return result;
}

async function row(modelId: string) {
  return env.db
    .selectFrom("models")
    .select([
      "descriptionMd",
      "descriptionSha256",
      "descriptionConverter",
      "descriptionFileId",
      "updatedAt",
    ])
    .where("id", "=", modelId)
    .executeTakeFirstOrThrow();
}

/** Makes a model's description look as a release before 0.1.1 stored it: no record, older text. */
async function asBefore011(modelId: string, description: string) {
  await env.db
    .updateTable("models")
    .set({
      descriptionMd: description,
      descriptionSha256: null,
      descriptionConverter: null,
      descriptionFileId: null,
    })
    .where("id", "=", modelId)
    .execute();
}

/** The progress row of the current step, while a run has counted and not finished. */
async function progressRow() {
  return env.db
    .selectFrom("upgradeSteps")
    .select(["name", "result"])
    .where("name", "=", progressName(RECONVERT_STEP))
    .executeTakeFirst();
}

function reconvert() {
  const lines: string[] = [];
  const run = createDescriptionReconvert({
    store: descriptionsRepo(env.db),
    readText: storeTextReader(env.store),
    log: (line) => lines.push(line),
  });
  return { run, lines };
}

describe("ingest", () => {
  test("records the hash, the converter and the file of a description it writes", async () => {
    const { modelId, fileId } = await ingestMakerWorld(HTML);
    expect(await row(modelId)).toMatchObject({
      descriptionMd: NOW,
      descriptionSha256: descriptionSha256(NOW),
      descriptionConverter: CONVERTER_VERSION,
      descriptionFileId: fileId,
    });
  });

  test("records a description with the licence note at its foot", async () => {
    const { modelId } = await ingestMakerWorld(HTML, "Standard Digital File License");
    const r = await row(modelId);
    expect(r.descriptionMd).toBe(`${NOW}\n\n${NOTE}`);
    expect(r.descriptionSha256).toBe(descriptionSha256(`${NOW}\n\n${NOTE}`));
  });

  test("records nothing for a description given through the API", async () => {
    const model = await env.repos.models.create({
      name: `API ${marker()}`,
      descriptionMd: "Written by a person",
    });
    expect(await row(model.id)).toMatchObject({
      descriptionSha256: null,
      descriptionConverter: null,
      descriptionFileId: null,
    });
  });

  test("the schema refuses a hash without a converter version", async () => {
    const { modelId } = await ingestMakerWorld(HTML);
    await expect(
      env.db
        .updateTable("models")
        .set({ descriptionConverter: null })
        .where("id", "=", modelId)
        .execute(),
    ).rejects.toThrow(/models_description_source_complete/);
  });
});

describe("a run", () => {
  test("converts again a description an earlier release stored, and leaves the rest alone", async () => {
    const old = await ingestMakerWorld(HTML);
    await asBefore011(old.modelId, BY_RC);

    const withNote = await ingestMakerWorld(HTML, "Standard Digital File License");
    await asBefore011(withNote.modelId, `${BY_RC}\n\n${NOTE}`);

    const edited = await ingestMakerWorld(HTML);
    await env.db
      .updateTable("models")
      .set({ descriptionMd: `${NOW}\n\nMy own notes` })
      .where("id", "=", edited.modelId)
      .execute();

    const byHand = await ingestMakerWorld(HTML);
    await asBefore011(byHand.modelId, "Written by hand, not by the converter");

    const api = await env.repos.models.create({
      name: `API ${marker()}`,
      descriptionMd: BY_RC,
    });

    const { run, lines } = reconvert();
    expect(await run.pending()).toBe(true);
    const result = await runToEnd(run);
    expect(result).not.toBeNull();
    expect(result?.changed).toBeGreaterThanOrEqual(2);

    expect(await row(old.modelId)).toMatchObject({
      descriptionMd: NOW,
      descriptionSha256: descriptionSha256(NOW),
      descriptionConverter: CONVERTER_VERSION,
      descriptionFileId: old.fileId,
    });
    expect((await row(withNote.modelId)).descriptionMd).toBe(`${NOW}\n\n${NOTE}`);
    expect((await row(edited.modelId)).descriptionMd).toBe(`${NOW}\n\nMy own notes`);
    expect(await row(byHand.modelId)).toMatchObject({
      descriptionMd: "Written by hand, not by the converter",
      descriptionSha256: null,
    });
    // A model with no .3mf cannot be proved, whatever its text.
    expect(await row(api.id)).toMatchObject({ descriptionMd: BY_RC, descriptionSha256: null });

    const step = await env.db
      .selectFrom("upgradeSteps")
      .select(["name", "result"])
      .where("name", "=", RECONVERT_STEP)
      .executeTakeFirstOrThrow();
    expect(step.result).toEqual(result);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`${result?.changed} changed`);
  });

  test("does nothing a second time", async () => {
    const old = await ingestMakerWorld(HTML);
    await asBefore011(old.modelId, BY_RC);
    await reconvert().run.run();
    await asBefore011(old.modelId, BY_RC);
    const second = reconvert();
    expect(await second.run.pending()).toBe(false);
    expect(await second.run.run()).toBeNull();
    expect((await row(old.modelId)).descriptionMd).toBe(BY_RC);
  });

  // The 0.1.1-rc.1 live check: converter 3 ran MakerWorld's Membership box
  // together, and its re-conversion was recorded as finished as
  // reconvert-descriptions-3. A database in that state, after the move to
  // converter 4: the step runs again, writes again what converter 3 wrote
  // and nobody touched, leaves an edited description alone, and runs once.
  test("runs again, once, after the converter version moves on, for what the older converter wrote", async () => {
    expect(CONVERTER_VERSION).toBe(4);
    const memberHtml =
      "<commercialme><commercialtitle>Membership</commercialtitle><commercialcontent>Sell my models</commercialcontent></commercialme>";
    const byV3 = "MembershipSell my models";
    const now = "Membership\n\nSell my models";
    /** Makes a model's description look as converter 3 stored it. */
    const asV3 = async (modelId: string, fileId: string, description: string) => {
      await env.db
        .updateTable("models")
        .set({
          descriptionMd: description,
          descriptionSha256: descriptionSha256(byV3),
          descriptionConverter: 3,
          descriptionFileId: fileId,
        })
        .where("id", "=", modelId)
        .execute();
    };
    const untouched = await ingestMakerWorld(memberHtml);
    await asV3(untouched.modelId, untouched.fileId, byV3);
    const edited = await ingestMakerWorld(memberHtml);
    await asV3(edited.modelId, edited.fileId, `${byV3}\n\nMy own notes`);
    await env.db
      .insertInto("upgradeSteps")
      .values({
        name: "reconvert-descriptions-3",
        result: JSON.stringify({ checked: 2, changed: 0, unchanged: 2, kept: 0, unreadable: 0 }),
      })
      .execute();

    const first = reconvert();
    expect(await first.run.pending()).toBe(true);
    const result = await runToEnd(first.run);
    expect(result?.changed).toBeGreaterThanOrEqual(1);
    expect(await row(untouched.modelId)).toMatchObject({
      descriptionMd: now,
      descriptionSha256: descriptionSha256(now),
      descriptionConverter: 4,
      descriptionFileId: untouched.fileId,
    });
    expect(await row(edited.modelId)).toMatchObject({
      descriptionMd: `${byV3}\n\nMy own notes`,
      descriptionConverter: 3,
    });
    const steps = await env.db
      .selectFrom("upgradeSteps")
      .select("name")
      .where("name", "like", "reconvert-descriptions-%")
      .orderBy("name")
      .execute();
    expect(steps.map((s) => s.name)).toEqual(["reconvert-descriptions-3", RECONVERT_STEP]);

    // Once only: a second run does nothing, even with the description put back.
    await asV3(untouched.modelId, untouched.fileId, byV3);
    const second = reconvert();
    expect(await second.run.pending()).toBe(false);
    expect(await second.run.run()).toBeNull();
    expect((await row(untouched.modelId)).descriptionMd).toBe(byV3);
  });

  test("never writes over a description changed after it was read", async () => {
    const old = await ingestMakerWorld(HTML);
    await asBefore011(old.modelId, BY_RC);
    const repo = descriptionsRepo(env.db);
    const [candidate] = (await repo.candidates(null, 1000)).filter(
      (c) => c.modelId === old.modelId,
    );
    expect(candidate).toBeDefined();
    await env.db
      .updateTable("models")
      .set({ descriptionMd: "Changed in the meantime" })
      .where("id", "=", old.modelId)
      .execute();
    if (candidate === undefined) return;
    expect(
      await repo.write(
        candidate,
        { description: NOW, fileId: old.fileId },
        { name: RECONVERT_STEP, outcome: "changed" },
      ),
    ).toBe(false);
    expect((await row(old.modelId)).descriptionMd).toBe("Changed in the meantime");
    // Nothing written, so nothing counted.
    expect(await progressRow()).toBeUndefined();
  });

  // A run cut off part way (a restart, or a store outage) leaves its counts;
  // the next run goes on after the last model counted, and the step records
  // the totals of the whole conversion, so the Activity page does not show
  // only the last run's part of it.
  test("records the totals of the whole conversion when a run cut off part way is started again", async () => {
    const a = await ingestMakerWorld(HTML);
    await asBefore011(a.modelId, BY_RC);
    const b = await ingestMakerWorld(HTML);
    await asBefore011(b.modelId, BY_RC);
    const [, last] = [a, b].sort((x, y) => (x.modelId < y.modelId ? -1 : 1));
    if (last === undefined) throw new Error("two models were ingested");

    const outage = new SourceOutage(new Error("the store is down"));
    const read = storeTextReader(env.store);
    const first = createDescriptionReconvert({
      store: descriptionsRepo(env.db),
      readText: async (file) => {
        if (file.fileId === last.fileId) throw outage;
        return read(file);
      },
      log: () => {},
    });
    await expect(first.run()).rejects.toBe(outage);
    const cut = await progressRow();
    expect(cut).toBeDefined();
    const counted = (cut?.result ?? {}) as Record<string, number | undefined>;
    const before = {
      checked: counted.checked ?? 0,
      changed: counted.changed ?? 0,
      unchanged: counted.unchanged ?? 0,
      kept: counted.kept ?? 0,
      unreadable: counted.unreadable ?? 0,
    };
    expect(before.changed).toBeGreaterThanOrEqual(1);
    expect(await reconvert().run.pending()).toBe(true);

    const result = await reconvert().run.run();
    // Only the model the first run stopped at is left, and it is changed.
    expect(result).toEqual({
      checked: before.checked + 1,
      changed: before.changed + 1,
      unchanged: before.unchanged,
      kept: before.kept,
      unreadable: before.unreadable,
    });
    expect((await row(a.modelId)).descriptionMd).toBe(NOW);
    expect((await row(b.modelId)).descriptionMd).toBe(NOW);
    const step = await env.db
      .selectFrom("upgradeSteps")
      .select("result")
      .where("name", "=", RECONVERT_STEP)
      .executeTakeFirstOrThrow();
    expect(step.result).toEqual(result);
    expect(await progressRow()).toBeUndefined();
  });

  test("does nothing and records nothing while another run holds the step", async () => {
    const old = await ingestMakerWorld(HTML);
    await asBefore011(old.modelId, BY_RC);
    const held = await descriptionsRepo(env.db).exclusive(RECONVERT_STEP, async (_lost) =>
      reconvert().run.run(),
    );
    expect(held).toBeNull();
    expect((await row(old.modelId)).descriptionMd).toBe(BY_RC);
    expect(await env.db.selectFrom("upgradeSteps").selectAll().execute()).toEqual([]);
    // Once the step is free, a run goes.
    expect(await reconvert().run.run()).not.toBeNull();
    expect((await row(old.modelId)).descriptionMd).toBe(NOW);
  });

  test("an expired lease is taken over", async () => {
    const old = await ingestMakerWorld(HTML);
    await asBefore011(old.modelId, BY_RC);
    await sql`insert into upgrade_leases (name, holder, expires_at)
      values (${RECONVERT_STEP}, 'a-server-that-died', now() - interval '1 second')`.execute(
      env.db,
    );
    expect(await reconvert().run.run()).not.toBeNull();
    expect((await row(old.modelId)).descriptionMd).toBe(NOW);
    expect(await env.db.selectFrom("upgradeLeases").selectAll().execute()).toEqual([]);
  });

  test("a run that loses its lease stops after the model it is on", async () => {
    for (let i = 0; i < 2; i += 1) {
      const m = await ingestMakerWorld(HTML);
      await asBefore011(m.modelId, BY_RC);
    }
    const repo = descriptionsRepo(env.db);
    let first = true;
    let lostSignal: AbortSignal | undefined;
    const store = {
      ...repo,
      exclusive: <T>(name: string, fn: (lost: AbortSignal) => Promise<T>) =>
        repo.exclusive(
          name,
          (s) => {
            lostSignal = s;
            return fn(s);
          },
          { renewMs: 20 },
        ),
      // Another server takes the lease while the first model is being read.
      async sourceFiles(modelId: string) {
        if (first) {
          first = false;
          await env.db.deleteFrom("upgradeLeases").execute();
          const signal = lostSignal;
          if (signal === undefined) throw new Error("the run was not given a lease signal");
          await new Promise<void>((resolve, reject) => {
            if (signal.aborted) return resolve();
            const timer = setTimeout(() => reject(new Error("the lease was never lost")), 10_000);
            signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
          });
        }
        return repo.sourceFiles(modelId);
      },
    };
    const run = createDescriptionReconvert({
      store,
      readText: storeTextReader(env.store),
      batchSize: 1,
      log: () => {},
    });
    expect(await run.run()).toBe(RECONVERT_PAUSED);
    const counted = (await progressRow())?.result as { checked?: number } | undefined;
    expect(counted?.checked).toBe(1);
    expect(await run.pending()).toBe(true);
  });

  test("the lease is released when the run throws", async () => {
    const old = await ingestMakerWorld(HTML);
    await asBefore011(old.modelId, BY_RC);
    const outage = new SourceOutage(new Error("the store is down"));
    const run = createDescriptionReconvert({
      store: descriptionsRepo(env.db),
      readText: async () => {
        throw outage;
      },
      log: () => {},
    });
    await expect(run.run()).rejects.toBe(outage);
    expect(await env.db.selectFrom("upgradeLeases").selectAll().execute()).toEqual([]);
  });

  test("leaves a model already written by this converter out of the candidates", async () => {
    const current = await ingestMakerWorld(HTML);
    const ids = (await descriptionsRepo(env.db).candidates(null, 10_000)).map((c) => c.modelId);
    expect(ids).not.toContain(current.modelId);
  });

  test("reads a .3mf whose source blob is gone as could not be read", async () => {
    const old = await ingestMakerWorld(HTML);
    await asBefore011(old.modelId, BY_RC);
    const blob = await env.db
      .selectFrom("files")
      .innerJoin("blobs", "blobs.id", "files.blobId")
      .select("blobs.key")
      .where("files.id", "=", old.fileId)
      .executeTakeFirstOrThrow();
    await env.store.deleteBlobs([blob.key]);
    const result = await runToEnd(reconvert().run);
    expect(result?.unreadable).toBeGreaterThanOrEqual(1);
    expect((await row(old.modelId)).descriptionMd).toBe(BY_RC);
  });

  test("the finished step is listed for the Activity page", async () => {
    await reconvert().run.run();
    const steps = await descriptionsRepo(env.db).finishedSteps("reconvert-descriptions-", 10);
    expect(steps.map((s) => s.name)).toEqual([RECONVERT_STEP]);
    const { rows } = await sql<{ n: number }>`select count(*)::int as n from upgrade_steps`.execute(
      env.db,
    );
    expect(rows[0]?.n).toBe(1);
  });
});

describe("a description found unproven", () => {
  const BY_HAND = "Written by hand, not by the converter";

  /** A run that records which files it read. */
  function recordingRun() {
    const read: string[] = [];
    const inner = storeTextReader(env.store);
    const run = createDescriptionReconvert({
      store: descriptionsRepo(env.db),
      readText: async (file, signal) => {
        read.push(file.fileId);
        return inner(file, signal);
      },
      log: () => {},
    });
    return { run, read };
  }

  /** The next converter's step: the finished record of this one is gone, as a new step name has none. */
  async function nextStep() {
    await env.db.deleteFrom("upgradeSteps").execute();
  }

  async function unprovenMarker(modelId: string) {
    return env.db
      .selectFrom("models")
      .select(["descriptionUnprovenFileId", "descriptionUnprovenSha256"])
      .where("id", "=", modelId)
      .executeTakeFirstOrThrow();
  }

  async function foundUnproven() {
    const m = await ingestMakerWorld(HTML);
    await asBefore011(m.modelId, BY_HAND);
    const first = recordingRun();
    await runToEnd(first.run);
    expect(first.read).toContain(m.fileId);
    expect(await unprovenMarker(m.modelId)).toEqual({
      descriptionUnprovenFileId: m.fileId,
      descriptionUnprovenSha256: descriptionSha256(BY_HAND),
    });
    await nextStep();
    return m;
  }

  test("is not read again by the next converter's step", async () => {
    const m = await foundUnproven();
    const second = recordingRun();
    const result = await runToEnd(second.run);
    expect(second.read).not.toContain(m.fileId);
    expect(result).not.toBeNull();
    const ids = (await descriptionsRepo(env.db).candidates(null, 10_000)).map((c) => c.modelId);
    expect(ids).not.toContain(m.modelId);
    expect((await row(m.modelId)).descriptionMd).toBe(BY_HAND);
  });

  test("is read again once a newer .3mf arrives", async () => {
    const m = await foundUnproven();
    const added = await env.ingest.ingestFile({
      tmpPath: await writeUpload(env, build3mf({ plates: 1, nonce: marker() })),
      originalName: "second.3mf",
      target: { modelId: m.modelId },
    });
    const second = recordingRun();
    await runToEnd(second.run);
    expect(second.read).toContain(m.fileId);
    expect(second.read).toContain(added.fileId);
  });

  test("is read again once its description changed", async () => {
    const m = await foundUnproven();
    await env.db
      .updateTable("models")
      .set({ descriptionMd: `${BY_HAND}, edited` })
      .where("id", "=", m.modelId)
      .execute();
    const second = recordingRun();
    await runToEnd(second.run);
    expect(second.read).toContain(m.fileId);
  });

  test("is not marked when its file could not be read, and is checked again", async () => {
    const m = await ingestMakerWorld(HTML);
    await asBefore011(m.modelId, BY_HAND);
    const blob = await env.db
      .selectFrom("files")
      .innerJoin("blobs", "blobs.id", "files.blobId")
      .select("blobs.key")
      .where("files.id", "=", m.fileId)
      .executeTakeFirstOrThrow();
    await env.store.deleteBlobs([blob.key]);
    const first = recordingRun();
    const result = await runToEnd(first.run);
    expect(result?.unreadable).toBeGreaterThanOrEqual(1);
    expect(await unprovenMarker(m.modelId)).toEqual({
      descriptionUnprovenFileId: null,
      descriptionUnprovenSha256: null,
    });
    await nextStep();
    // Still a candidate for the next step: nothing was proven either way.
    const ids = (await descriptionsRepo(env.db).candidates(null, 10_000)).map((c) => c.modelId);
    expect(ids).toContain(m.modelId);
  });

  test("is not marked when it was edited", async () => {
    const m = await ingestMakerWorld(HTML);
    await env.db
      .updateTable("models")
      .set({ descriptionMd: `${NOW}\n\nMy own notes`, descriptionConverter: 3 })
      .where("id", "=", m.modelId)
      .execute();
    await runToEnd(recordingRun().run);
    expect((await unprovenMarker(m.modelId)).descriptionUnprovenFileId).toBeNull();
  });

  test("SQL and JS agree on the description hash", async () => {
    for (const text of ["plain", "Crème brûlée \u2014 \u30e2\u30c7\u30eb \u{1f9f1}", "a\nb\r\n"]) {
      const { rows } = await sql<{ h: string }>`
        select encode(sha256(convert_to(${text}, 'UTF8')), 'hex') as h`.execute(env.db);
      expect(rows[0]?.h).toBe(descriptionSha256(text));
    }
  });
});
