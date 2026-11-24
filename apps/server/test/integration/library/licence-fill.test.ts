// The licence fill on upgrade (#445) against a real Postgres 17 and S3 test
// server: a run reads a model's stored .3mf files again and fills a lost
// licence or licence note, only on a model that has neither, never touching a
// description, and records itself so a second run does nothing. The decisions
// and the run's walk are unit-tested in test/library/licence-fill.test.ts.
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  createLicenceFill,
  LICENCE_STEP,
  type LicenceFillResult,
  storeLicenceReader,
} from "../../../src/library/licence-fill.js";
import { RECONVERT_PAUSED } from "../../../src/library/reconvert.js";
import { descriptionsRepo } from "../../../src/repos/descriptions.js";
import { build3mf, type IngestEnv, startIngestEnv, writeUpload } from "../support/ingest.js";
import { marker } from "../support/library.js";

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

/** Adds a MakerWorld .3mf with a licence to a new model, or to modelId. */
async function ingest(license: string | undefined, modelId?: string) {
  return env.ingest.ingestFile({
    tmpPath: await writeUpload(
      env,
      build3mf({
        plates: 1,
        nonce: marker(),
        makerWorld: {
          designer: "Synthetic Designer",
          title: `Synthetic ${marker()}`,
          descriptionHtml: "<p>Hello</p>",
          ...(license === undefined ? {} : { license }),
        },
      }),
    ),
    originalName: "design.3mf",
    target: modelId === undefined ? "new" : { modelId },
  });
}

/** Clears the licence and note, as a release before 0.1.1 left a model it could not map. */
async function loseLicence(modelId: string) {
  await env.db
    .updateTable("models")
    .set({ licenseSpdx: null, licenseNote: null })
    .where("id", "=", modelId)
    .execute();
}

async function row(modelId: string) {
  return env.db
    .selectFrom("models")
    .select(["licenseSpdx", "licenseNote", "descriptionMd", "updatedAt"])
    .where("id", "=", modelId)
    .executeTakeFirstOrThrow();
}

function licenceFill() {
  return createLicenceFill({
    store: descriptionsRepo(env.db),
    readLicence: storeLicenceReader(env.store),
    log: () => {},
  });
}

async function runToEnd(fill: ReturnType<typeof licenceFill>): Promise<LicenceFillResult | null> {
  const result = await fill.run();
  if (result === RECONVERT_PAUSED) throw new Error("a run given no stop paused");
  return result;
}

describe("a licence fill run", () => {
  test("fills a model with no licence from its .3mf, and never touches its description", async () => {
    const nd = await ingest("BY-ND");
    const footer = await ingest("Standard Digital File License");
    const unknown = await ingest("Some New License");
    for (const m of [nd, footer, unknown]) await loseLicence(m.modelId);
    const before = await row(nd.modelId);

    const result = await runToEnd(licenceFill());
    expect(result?.filled).toBeGreaterThanOrEqual(3);

    const after = await row(nd.modelId);
    expect(after.licenseSpdx).toBe("CC-BY-ND-4.0");
    expect(after.licenseNote).toBeNull();
    expect(after.descriptionMd).toBe(before.descriptionMd);
    expect(await row(footer.modelId)).toMatchObject({
      licenseSpdx: null,
      licenseNote: "License on MakerWorld: Standard Digital File License",
    });
    expect(await row(unknown.modelId)).toMatchObject({
      licenseSpdx: null,
      licenseNote: "License on MakerWorld: Some New License",
    });
  });

  test("leaves a model that already has an SPDX id or a note alone, whatever its .3mf says", async () => {
    const withSpdx = await ingest("BY-ND");
    await env.db
      .updateTable("models")
      .set({ licenseSpdx: "MIT", licenseNote: null })
      .where("id", "=", withSpdx.modelId)
      .execute();
    const withNote = await ingest("BY-ND");
    await env.db
      .updateTable("models")
      .set({ licenseSpdx: null, licenseNote: "My own note" })
      .where("id", "=", withNote.modelId)
      .execute();

    await runToEnd(licenceFill());

    expect(await row(withSpdx.modelId)).toMatchObject({ licenseSpdx: "MIT", licenseNote: null });
    expect(await row(withNote.modelId)).toMatchObject({
      licenseSpdx: null,
      licenseNote: "My own note",
    });
  });

  test("uses the oldest stored .3mf that names a licence", async () => {
    const first = await ingest(undefined);
    await ingest("BY-NC", first.modelId);
    await ingest("BY-ND", first.modelId);
    await loseLicence(first.modelId);

    await runToEnd(licenceFill());

    expect((await row(first.modelId)).licenseSpdx).toBe("CC-BY-NC-4.0");
  });

  test("the finished step is recorded with its counts", async () => {
    const m = await ingest("BY-ND");
    await loseLicence(m.modelId);

    const fill = licenceFill();
    expect(await fill.pending()).toBe(true);
    const result = await runToEnd(fill);
    expect(result).not.toBeNull();

    const step = await env.db
      .selectFrom("upgradeSteps")
      .select("result")
      .where("name", "=", LICENCE_STEP)
      .executeTakeFirstOrThrow();
    expect(Object.keys(step.result as object).sort()).toEqual(
      ["checked", "filled", "kept", "none", "unreadable"].sort(),
    );
    expect(step.result).toEqual(result);
    expect(await fill.pending()).toBe(false);
    expect(await runToEnd(fill)).toBeNull();
  });

  test("a model being purged is not a candidate", async () => {
    const m = await ingest("BY-ND");
    await loseLicence(m.modelId);
    await sql`update models set trashed_at = now(), purge_started_at = now() where id = ${m.modelId}`.execute(
      env.db,
    );

    await runToEnd(licenceFill());

    expect(await row(m.modelId)).toMatchObject({ licenseSpdx: null, licenseNote: null });
  });
});
