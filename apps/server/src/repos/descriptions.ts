// The database side of the description re-conversion (#357,
// library/reconvert.ts): the candidates, their source files, the
// compare-and-set write, the counts kept while a run goes, the lease that lets
// one run go at a time, and the upgrade_steps record (migration 0014).
//
// The counts of a step that has not finished are kept in upgrade_steps too,
// in a row named progress-<step> (progressName), with the last model counted
// as "after". That name is outside the step's own name and outside the
// reconvert-descriptions- prefix the Activity page lists, so it never reads as
// the step finished or as a run on the page. finishStep turns it into the
// step's own row and deletes it in one transaction.
import { CONVERTER_VERSION } from "@platehouse/makerworld";
import { type Kysely, sql } from "kysely";
import { uuidv7 } from "../db/ids.js";
import { inTransaction } from "../db/kysely.js";
import type { DB } from "../db/types.js";
import type { LicenceStore, StepOutcome } from "../library/licence-fill.js";
import {
  descriptionSha256,
  type ReconvertStore,
  type SourceFile,
  type StoredDescription,
} from "../library/reconvert.js";

/** How long a lease on an upgrade step lasts without being renewed. */
export const LEASE_MS = 60_000;
/** How often a run renews its lease; well inside LEASE_MS, so one missed renewal costs nothing. */
export const LEASE_RENEW_MS = 20_000;

/** The upgrade_steps row that holds a step's counts while it has not finished. */
export function progressName(name: string): string {
  return `progress-${name}`;
}

const OUTCOMES: readonly StepOutcome[] = [
  "changed",
  "unchanged",
  "kept",
  "unreadable",
  "filled",
  "none",
];

/** The outcomes a step counts: the licence fill's own, or the description re-conversion's. */
function outcomesOf(name: string): readonly StepOutcome[] {
  return name.startsWith("licences-from-makerworld-")
    ? ["filled", "none", "kept", "unreadable"]
    : ["changed", "unchanged", "kept", "unreadable"];
}

/**
 * The counts in a progress row's result, only those of the step's outcomes
 * (so a step's totals hold no other step's keys); a count missing or not a
 * whole number of 0 or more is 0.
 */
function countsOf(name: string, result: unknown): Record<string, number> {
  const r = (typeof result === "object" && result !== null ? result : {}) as Record<
    string,
    unknown
  >;
  const n = (key: string): number => {
    const v = r[key];
    return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0;
  };
  return Object.fromEntries(["checked", ...outcomesOf(name)].map((key) => [key, n(key)] as const));
}

/**
 * Adds one model's outcome to the step's progress row, made at the first
 * count, and makes the model the last counted.
 */
async function addCount(
  db: Kysely<DB>,
  name: string,
  modelId: string,
  outcome: StepOutcome,
): Promise<void> {
  // The outcome becomes a JSON key, so only the ones a step's result has are taken.
  if (!OUTCOMES.includes(outcome)) {
    throw new Error(`Unknown outcome: ${String(outcome).slice(0, 32)}`);
  }
  await sql`
    insert into upgrade_steps (name, result)
    values (
      ${progressName(name)},
      jsonb_build_object('checked', 1, ${outcome}::text, 1, 'after', ${modelId}::text)
    )
    on conflict (name) do update set
      finished_at = now(),
      result = upgrade_steps.result || jsonb_build_object(
        'checked', coalesce((upgrade_steps.result ->> 'checked')::int, 0) + 1,
        ${outcome}::text, coalesce((upgrade_steps.result ->> ${outcome}::text)::int, 0) + 1,
        'after', ${modelId}::text
      )
  `.execute(db);
}

/** A finished upgrade step, for the Activity page. */
export interface UpgradeStep {
  name: string;
  finishedAt: Date;
  result: unknown;
}

export function descriptionsRepo(db: Kysely<DB>): ReconvertStore &
  LicenceStore & {
    /** Finished upgrade steps whose name starts with prefix, newest first, at most limit. */
    finishedSteps(prefix: string, limit: number): Promise<UpgradeStep[]>;
  } {
  return {
    async stepFinished(name) {
      const row = await db
        .selectFrom("upgradeSteps")
        .select("name")
        .where("name", "=", name)
        .executeTakeFirst();
      return row !== undefined;
    },

    // A lease row, not a session lock: every query here uses the pool, so a
    // dropped connection or a connection pooler cannot hand the step to two
    // servers. The run renews the lease while it goes and stops after the
    // model it is on when it can no longer prove it holds it; a server that
    // dies leaves a lease that runs out by itself.
    async exclusive(name, fn, options) {
      const holder = uuidv7();
      const leaseMs = options?.leaseMs ?? LEASE_MS;
      const renewMs = options?.renewMs ?? LEASE_RENEW_MS;
      // Elapsed time on this machine's own clock only, so it is no
      // comparison with the database's clock.
      let sentAt = performance.now();
      const taken = await sql<{ holder: string }>`
        insert into upgrade_leases (name, holder, expires_at)
        values (${name}, ${holder}, now() + ${leaseMs} * interval '1 millisecond')
        on conflict (name) do update
          set holder = excluded.holder, expires_at = excluded.expires_at
          where upgrade_leases.expires_at < now()
        returning holder`.execute(db);
      if (taken.rows.length === 0) return null;
      let lastRenewedAt = sentAt;
      const lost = new AbortController();
      let failures = 0;
      let renewing = false;
      const renew = async () => {
        // A renewal that hangs (a connection that died without telling us)
        // never fails, so while one is in flight the lease is given up on
        // when the last one that worked was sent so long ago that the lease
        // is about to run out. One that failed and returned is tolerated: the
        // next tick tries again, and only a second failure in a row gives up.
        if (renewing) {
          if (performance.now() - lastRenewedAt >= leaseMs - renewMs) lost.abort();
          return;
        }
        if (lost.signal.aborted) return;
        renewing = true;
        sentAt = performance.now();
        const sent = sentAt;
        try {
          const { rows } = await sql<{ holder: string }>`
            update upgrade_leases
            set expires_at = now() + ${leaseMs} * interval '1 millisecond'
            where name = ${name} and holder = ${holder}
            returning holder`.execute(db);
          if (rows.length === 0) lost.abort();
          else lastRenewedAt = sent;
          failures = 0;
        } catch {
          failures += 1;
          if (failures >= 2) lost.abort();
        } finally {
          renewing = false;
        }
      };
      const timer = setInterval(() => void renew(), renewMs);
      timer.unref();
      try {
        return await fn(lost.signal);
      } finally {
        clearInterval(timer);
        // The run's own error is the one to report; a lease that cannot be
        // deleted runs out by itself.
        await sql`delete from upgrade_leases where name = ${name} and holder = ${holder}`
          .execute(db)
          .catch(() => undefined);
      }
    },

    async resumeAfter(name) {
      const row = await db
        .selectFrom("upgradeSteps")
        .select("result")
        .where("name", "=", progressName(name))
        .executeTakeFirst();
      const after = (row?.result as Record<string, unknown> | null | undefined)?.after;
      return typeof after === "string" ? after : null;
    },

    async count(name: string, modelId: string, outcome: StepOutcome) {
      await addCount(db, name, modelId, outcome);
    },

    // The totals hold the counts of the step's own outcomes (countsOf), so
    // each of the two interfaces gets the shape it names.
    finishStep: (async (name: string) =>
      inTransaction(db, async (trx) => {
        const progress = await trx
          .selectFrom("upgradeSteps")
          .select("result")
          .where("name", "=", progressName(name))
          .forUpdate()
          .executeTakeFirst();
        const totals = countsOf(name, progress?.result);
        // A step already recorded keeps its record.
        await trx
          .insertInto("upgradeSteps")
          .values({ name, result: JSON.stringify(totals) })
          .onConflict((oc) => oc.column("name").doNothing())
          .execute();
        await trx.deleteFrom("upgradeSteps").where("name", "=", progressName(name)).execute();
        return totals;
      })) as unknown as ReconvertStore["finishStep"] & LicenceStore["finishStep"],

    async finishedSteps(prefix, limit) {
      const rows = await db
        .selectFrom("upgradeSteps")
        .select(["name", "finishedAt", "result"])
        .where(sql<boolean>`starts_with(name, ${prefix})`)
        .orderBy("finishedAt", "desc")
        .orderBy("name")
        .limit(limit)
        .execute();
      return rows.map((r) => ({ name: r.name, finishedAt: r.finishedAt, result: r.result }));
    },

    // Live and trashed models alike, since a trashed model can be restored;
    // not one whose purge has begun, which is being deleted.
    async candidates(after, limit) {
      let q = db
        .selectFrom("models")
        .select([
          "id",
          "descriptionMd",
          "descriptionSha256",
          "descriptionConverter",
          "descriptionFileId",
        ])
        .where("descriptionMd", "is not", null)
        .where("descriptionMd", "<>", "")
        .where("purgeStartedAt", "is", null)
        // Not one already found unproven against its newest .3mf with this
        // very text; a new .3mf or an edit makes it a candidate again. A
        // model with no stored .3mf left has no newest file, which is not the
        // marked one, so it stays a candidate (is not distinct from, not =).
        .where(
          sql<boolean>`not (
            description_unproven_file_id is not null
            and description_unproven_sha256 = encode(sha256(convert_to(description_md, 'UTF8')), 'hex')
            and description_unproven_file_id is not distinct from (
              select f.id from files f
              join blobs b on b.id = f.blob_id
              where f.model_id = models.id and f.kind = '3mf' and b.state = 'stored'
              order by f.created_at desc, f.id desc
              limit 1
            )
          )`,
        )
        .where((eb) =>
          eb.or([
            eb("descriptionConverter", "is", null),
            eb("descriptionConverter", "<", CONVERTER_VERSION),
          ]),
        );
      if (after !== null) q = q.where("id", ">", after);
      const rows = await q.orderBy("id").limit(limit).execute();
      return rows.map(
        (r): StoredDescription => ({
          modelId: r.id,
          description: r.descriptionMd ?? "",
          sha256: r.descriptionSha256,
          converter: r.descriptionConverter,
          fileId: r.descriptionFileId,
        }),
      );
    },

    // The model's .3mf files whose source blob is stored, oldest first, the
    // order ingest filled the description in.
    async sourceFiles(modelId) {
      const rows = await db
        .selectFrom("files")
        .innerJoin("blobs", "blobs.id", "files.blobId")
        .select(["files.id as fileId", "blobs.key as key", "blobs.size as size"])
        .where("files.modelId", "=", modelId)
        .where("files.kind", "=", "3mf")
        .where("blobs.state", "=", "stored")
        .orderBy("files.createdAt")
        .orderBy("files.id")
        .execute();
      return rows.map((r): SourceFile => ({ fileId: r.fileId, key: r.key, size: r.size ?? 0 }));
    },

    // Models with no licence and no licence note, with a stored .3mf, in id
    // order; the filter is the same one the write holds to.
    async licenceCandidates(after, limit) {
      let q = db
        .selectFrom("models")
        .select("id")
        .where("purgeStartedAt", "is", null)
        .where(sql<boolean>`coalesce(license_spdx, '') = ''`)
        .where(sql<boolean>`coalesce(license_note, '') = ''`)
        .where(
          sql<boolean>`exists (
            select 1 from files f
            join blobs b on b.id = f.blob_id
            where f.model_id = models.id and f.kind = '3mf' and b.state = 'stored'
          )`,
        );
      if (after !== null) q = q.where("id", ">", after);
      const rows = await q.orderBy("id").limit(limit).execute();
      return rows.map((r) => ({ modelId: r.id }));
    },

    // Compare-and-set: only a model that still has no licence and no note,
    // and is not being purged. The count commits with it.
    async writeLicence(modelId, set, count) {
      return inTransaction(db, async (trx) => {
        const result = await trx
          .updateTable("models")
          .set({ licenseSpdx: set.spdx, licenseNote: set.note, updatedAt: sql<Date>`now()` })
          .where("id", "=", modelId)
          .where("purgeStartedAt", "is", null)
          .where(sql<boolean>`coalesce(license_spdx, '') = ''`)
          .where(sql<boolean>`coalesce(license_note, '') = ''`)
          .executeTakeFirst();
        if (result.numUpdatedRows === 0n) return false;
        await addCount(trx, count.name, modelId, "filled");
        return true;
      });
    },

    async markUnproven(row, newestFileId) {
      await db
        .updateTable("models")
        .set({
          descriptionUnprovenFileId: newestFileId,
          descriptionUnprovenSha256: descriptionSha256(row.description),
        })
        .where("id", "=", row.modelId)
        .where("descriptionMd", "=", row.description)
        .execute();
    },

    // The write and its count commit together, so a run cut off between
    // them cannot leave a description written but not counted.
    async write(row, next, count) {
      const changed = next.description !== row.description;
      return inTransaction(db, async (trx) => {
        const result = await trx
          .updateTable("models")
          .set({
            descriptionMd: next.description,
            descriptionSha256: descriptionSha256(next.description),
            descriptionConverter: CONVERTER_VERSION,
            descriptionFileId: next.fileId,
            // Only a new text is a change to the model; marking the same text
            // as written by this converter is not.
            ...(changed ? { updatedAt: sql<Date>`now()` } : {}),
          })
          .where("id", "=", row.modelId)
          .where("descriptionMd", "=", row.description)
          .where(sql<boolean>`description_sha256 is not distinct from ${row.sha256}`)
          .executeTakeFirst();
        if (result.numUpdatedRows === 0n) return false;
        await addCount(trx, count.name, row.modelId, count.outcome);
        return true;
      });
    },
  };
}
