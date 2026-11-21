import { type Kysely, type Selectable, sql } from "kysely";
import { isUuid, uuidv7 } from "../db/ids.js";
import { inTransaction } from "../db/kysely.js";
import type { DB, EstimatesTable } from "../db/types.js";

export interface EstimateFilament {
  slot: number;
  type: string;
  color: string | null;
  grams: number | null;
}

export type Estimate = Selectable<EstimatesTable> & { filaments: EstimateFilament[] };

interface EstimateFields {
  plateId: string;
  printerId: string;
  printerModelId?: string | null;
  nozzle?: number | null;
  processProfile?: string | null;
  filamentProfiles?: string[];
}

/** A Platehouse estimate to queue: slicerVersion is the Orca version. */
export interface PendingEstimate extends EstimateFields {
  slicer: string;
  slicerVersion: string;
}

/** Bambu's own numbers read from the .3mf for the printer it was sliced for. */
export interface FileNumbers extends EstimateFields {
  slicer?: string | null;
  slicerVersion?: string | null;
  timeSeconds: number;
  weightGrams: number;
  filaments: EstimateFilament[];
}

async function withFilaments(db: Kysely<DB>, row: Selectable<EstimatesTable>): Promise<Estimate> {
  const filaments = await db
    .selectFrom("estimateFilaments")
    .select(["slot", "type", "color", "grams"])
    .where("estimateId", "=", row.id)
    .orderBy("slot")
    .execute();
  return { ...row, filaments };
}

export function estimatesRepo(db: Kysely<DB>) {
  return {
    /**
     * Makes sure a Platehouse estimate exists for this plate, printer and
     * Orca version, and returns it. A new one is pending. A failed one goes
     * back to pending with its attempts and failure cleared (a retry). One
     * that is pending, running or done is left as it is.
     */
    async upsertPending(input: PendingEstimate): Promise<Estimate> {
      const inserted = await db
        .insertInto("estimates")
        .values({
          id: uuidv7(),
          plateId: input.plateId,
          source: "platehouse",
          printerId: input.printerId,
          printerModelId: input.printerModelId ?? null,
          nozzle: input.nozzle ?? null,
          slicer: input.slicer,
          slicerVersion: input.slicerVersion,
          processProfile: input.processProfile ?? null,
          filamentProfiles: input.filamentProfiles ?? [],
        })
        .onConflict((oc) =>
          oc
            .constraint("estimates_key")
            .doUpdateSet({
              status: "pending",
              attempts: 0,
              timeSeconds: null,
              weightGrams: null,
              failureCode: null,
              failureReason: null,
              failureDetail: null,
              finishedAt: null,
            })
            .where("estimates.status", "=", "failed"),
        )
        .returningAll()
        .executeTakeFirst();
      const row =
        inserted ??
        (await db
          .selectFrom("estimates")
          .selectAll()
          .where("plateId", "=", input.plateId)
          .where("source", "=", "platehouse")
          .where("printerId", "=", input.printerId)
          .where("slicerVersion", "=", input.slicerVersion)
          .executeTakeFirstOrThrow());
      return withFilaments(db, row);
    },

    /**
     * Records the file's own numbers as a finished estimate (source 'file')
     * with its grams per filament, all or nothing. The same plate, printer
     * and slicer version twice fails with 23505.
     */
    async insertFile(input: FileNumbers): Promise<Estimate> {
      return inTransaction(db, async (trx) => {
        const row = await trx
          .insertInto("estimates")
          .values({
            id: uuidv7(),
            plateId: input.plateId,
            source: "file",
            printerId: input.printerId,
            printerModelId: input.printerModelId ?? null,
            nozzle: input.nozzle ?? null,
            slicer: input.slicer ?? null,
            slicerVersion: input.slicerVersion ?? null,
            processProfile: input.processProfile ?? null,
            filamentProfiles: input.filamentProfiles ?? [],
            status: "ok",
            timeSeconds: input.timeSeconds,
            weightGrams: input.weightGrams,
            finishedAt: sql`now()`,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        if (input.filaments.length > 0) {
          await trx
            .insertInto("estimateFilaments")
            .values(input.filaments.map((f) => ({ estimateId: row.id, ...f })))
            .execute();
        }
        return withFilaments(trx, row);
      });
    },

    /** The Platehouse estimate for this plate, printer and Orca version, if any. */
    async current(
      plateId: string,
      printerId: string,
      orcaVersion: string,
    ): Promise<Estimate | undefined> {
      if (!isUuid(plateId)) return undefined;
      const row = await db
        .selectFrom("estimates")
        .selectAll()
        .where("plateId", "=", plateId)
        .where("source", "=", "platehouse")
        .where("printerId", "=", printerId)
        .where("slicerVersion", "=", orcaVersion)
        .executeTakeFirst();
      return row === undefined ? undefined : withFilaments(db, row);
    },
  };
}

export type EstimatesRepo = ReturnType<typeof estimatesRepo>;
