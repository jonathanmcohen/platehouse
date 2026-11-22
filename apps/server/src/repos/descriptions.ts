// The database side of the description re-conversion (#357,
// library/reconvert.ts): the candidates, their source files, the
// compare-and-set write, the counts kept while a run goes, the lock that lets
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
import { inTransaction } from "../db/kysely.js";
import type { DB } from "../db/types.js";
import {
  descriptionSha256,
  type Outcome,
  type ReconvertResult,
  type ReconvertStore,
  type SourceFile,
  type StoredDescription,
} from "../library/reconvert.js";

/** The upgrade_steps row that holds a step's counts while it has not finished. */
export function progressName(name: string): string {
  return `progress-${name}`;
}

const OUTCOMES: readonly Outcome[] = ["changed", "unchanged", "kept", "unreadable"];

/** The counts in a progress row's result; a count missing or not a whole number of 0 or more is 0. */
function countsOf(result: unknown): ReconvertResult {
  const r = (typeof result === "object" && result !== null ? result : {}) as Record<
    string,
    unknown
  >;
  const n = (key: string): number => {
    const v = r[key];
    return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0;
  };
  return {
    checked: n("checked"),
    changed: n("changed"),
    unchanged: n("unchanged"),
    kept: n("kept"),
    unreadable: n("unreadable"),
  };
}

/**
 * Adds one model's outcome to the step's progress row, made at the first
 * count, and makes the model the last counted.
 */
async function addCount(
  db: Kysely<DB>,
  name: string,
  modelId: string,
  outcome: Outcome,
): Promise<void> {
  // The outcome becomes a JSON key, so only the four the result has are taken.
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

export function descriptionsRepo(db: Kysely<DB>): ReconvertStore & {
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

    // A session-level advisory lock on a connection of its own, held while
    // fn runs; the run's own queries use the pool as usual. A server that
    // dies mid-run closes its connection, which releases the lock.
    async exclusive(name, fn) {
      const key = `platehouse-upgrade-step:${name}`;
      return db.connection().execute(async (conn) => {
        const { rows } = await sql<{
          locked: boolean;
        }>`select pg_try_advisory_lock(hashtext(${key})) as locked`.execute(conn);
        if (rows[0]?.locked !== true) return null;
        const unlock = () => sql`select pg_advisory_unlock(hashtext(${key}))`.execute(conn);
        let out: Awaited<ReturnType<typeof fn>>;
        try {
          out = await fn();
        } catch (err) {
          // The run's own error is the one to report. An unlock that fails
          // too means the connection is broken, and Postgres releases a
          // session's locks when its connection ends.
          await unlock().catch(() => undefined);
          throw err;
        }
        await unlock();
        return out;
      });
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

    async count(name, modelId, outcome) {
      await addCount(db, name, modelId, outcome);
    },

    async finishStep(name) {
      return inTransaction(db, async (trx) => {
        const progress = await trx
          .selectFrom("upgradeSteps")
          .select("result")
          .where("name", "=", progressName(name))
          .forUpdate()
          .executeTakeFirst();
        const totals = countsOf(progress?.result);
        // A step already recorded keeps its record.
        await trx
          .insertInto("upgradeSteps")
          .values({ name, result: JSON.stringify(totals) })
          .onConflict((oc) => oc.column("name").doNothing())
          .execute();
        await trx.deleteFrom("upgradeSteps").where("name", "=", progressName(name)).execute();
        return totals;
      });
    },

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
