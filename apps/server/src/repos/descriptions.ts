// The database side of the description re-conversion (#357,
// library/reconvert.ts): the candidates, their source files, the
// compare-and-set write, and the upgrade_steps record (migration 0010).
import { CONVERTER_VERSION } from "@platehouse/makerworld";
import { type Kysely, sql } from "kysely";
import type { DB } from "../db/types.js";
import {
  descriptionSha256,
  type ReconvertResult,
  type ReconvertStore,
  type SourceFile,
  type StoredDescription,
} from "../library/reconvert.js";

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

    async finishStep(name, result: ReconvertResult) {
      // A second run that finishes too (two servers started at once) keeps
      // the first record: both did the same work, and the first is when the
      // library was done.
      await db
        .insertInto("upgradeSteps")
        .values({ name, result: JSON.stringify(result) })
        .onConflict((oc) => oc.column("name").doNothing())
        .execute();
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

    async write(row, next) {
      const changed = next.description !== row.description;
      const result = await db
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
      return result.numUpdatedRows > 0n;
    },
  };
}
