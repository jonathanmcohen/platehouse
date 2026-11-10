// What a plate shows for its numbers (build plan Task 12, AC-031 to AC-034).
//
// A plate can have two sets of numbers:
// - file: Bambu's own numbers from the .3mf, labelled with the printer the
//   file was sliced for (the menu printer with that BBL model id and nozzle,
//   or the bare model id when the menu has none);
// - platehouse: an OrcaSlicer estimate for the selected printer, wanted only
//   when the file has no numbers for that printer. Its state is
//     current     the estimate for the selected printer and Orca version;
//     estimating  that estimate is queued or slicing and there is nothing
//                 older to show;
//     stale       that estimate is queued or slicing (or failed), and the
//                 newest older estimate is shown meanwhile, with staleFor
//                 naming what it was made for: the previous printer, or the
//                 previous Orca version when the printer is the same
//                 (AC-031: "its old one stays visible, marked as for the
//                 previous printer").
// A failed estimate for the selected printer gives failure: the slicer's
// reason, its plain words and Orca's detail for the Details toggle.
//
// Each filament line names the preset that produced its grams and where the
// preset came from: "bambu" (Bambu's own preset for the printer), "generic"
// (Orca's Generic preset) or "file" (the file's own filament was kept).
// Slicer contract v1 reports the preset name per slot but not its source, so
// the source is read from the name by the slicer's own rule
// (apps/slicer/src/profiles.ts pickFilament): it only ever picks a preset
// named "Bambu ..." or "Generic ...", and reports null where it kept the
// file's filament. The source is stored with the numbers when a slice lands.
import type { Printer, Reason } from "@platehouse/slicer-contract";
import { type Kysely, sql } from "kysely";
import { isUuid } from "../db/ids.js";
import type { DB, EstimateSource } from "../db/types.js";
import { isReason, reasonWords } from "./reasons.js";

export type ProfileSource = "bambu" | "generic" | "file";

export const PROFILE_SOURCES: readonly ProfileSource[] = ["bambu", "generic", "file"];

/** The slicer that makes Platehouse estimates, as estimates.slicer records it. */
export const PLATEHOUSE_SLICER = "OrcaSlicer";

export interface FilamentNumbers {
  slot: number;
  type: string;
  color: string | null;
  grams: number | null;
  /** The filament preset the slicer used; null for a file's own numbers. */
  profile: string | null;
  /** Where that preset came from; null for a file's own numbers. */
  profileSource: ProfileSource | null;
}

export interface Numbers {
  source: EstimateSource;
  estimateId: string;
  /** The printer these numbers are for: a menu printer id, or the file's bare model id. */
  printerId: string;
  printerLabel: string;
  slicer: string | null;
  slicerVersion: string | null;
  processProfile: string | null;
  timeSeconds: number | null;
  weightGrams: number | null;
  filaments: FilamentNumbers[];
}

export interface PlatehouseNumbers extends Numbers {
  state: "current" | "estimating" | "stale";
  /** For a stale set: the printer id, or "OrcaSlicer <version>", it was made for. */
  staleFor?: string;
}

export interface PlateFailure {
  estimateId: string;
  reason: Reason;
  words: string;
  /** Orca's own message, for the Details toggle. */
  detail: string | null;
}

export interface PlateNumbers {
  file?: Numbers;
  platehouse?: PlatehouseNumbers;
  failure?: PlateFailure;
}

export interface DisplayContext {
  /** settings.printer_id, the selected printer. */
  printerId: string;
  /** settings.last_orca_version, the slicer's current Orca version. */
  orcaVersion: string | null;
  /** The printer menu, from /v1/profiles. */
  printers: readonly Printer[];
}

/** Where a preset came from, read from its name by the slicer's own rule. */
export function profileSourceOf(profile: string | null): ProfileSource {
  if (profile?.startsWith("Bambu ")) return "bambu";
  if (profile?.startsWith("Generic ")) return "generic";
  return "file";
}

/** Nozzle sizes from a file are decimals; two sizes within this are the same. */
const NOZZLE_TOLERANCE = 0.001;

/** The menu printer a file was sliced for: same BBL model id and nozzle. */
export function printerForFile(
  file: { printerModelId: string | null; nozzle: number | null },
  printers: readonly Printer[],
): Printer | undefined {
  const { printerModelId, nozzle } = file;
  if (printerModelId === null || nozzle === null) return undefined;
  return printers.find(
    (p) => p.modelId === printerModelId && Math.abs(p.nozzle - nozzle) < NOZZLE_TOLERANCE,
  );
}

interface EstimateRow {
  id: string;
  source: EstimateSource;
  printerId: string;
  printerModelId: string | null;
  nozzle: number | null;
  slicer: string | null;
  slicerVersion: string | null;
  processProfile: string | null;
  status: string;
  timeSeconds: number | null;
  weightGrams: number | null;
  failureReason: string | null;
  failureDetail: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

function isProfileSource(value: string | null): value is ProfileSource {
  return value !== null && (PROFILE_SOURCES as readonly string[]).includes(value);
}

/** Whether the file's own numbers are for the selected printer. */
function fileIsFor(row: EstimateRow, selected: Printer | undefined): boolean {
  if (selected === undefined) return false;
  return printerForFile(row, [selected]) !== undefined;
}

export async function plateNumbers(
  db: Kysely<DB>,
  ctx: DisplayContext,
  plateId: string,
): Promise<PlateNumbers> {
  if (!isUuid(plateId)) return {};
  const rows: EstimateRow[] = await db
    .selectFrom("estimates")
    .select([
      "id",
      "source",
      "printerId",
      "printerModelId",
      "nozzle",
      "slicer",
      "slicerVersion",
      "processProfile",
      "status",
      "timeSeconds",
      "weightGrams",
      "failureReason",
      "failureDetail",
      "createdAt",
      "finishedAt",
    ])
    .where("plateId", "=", plateId)
    .orderBy("createdAt", "desc")
    .orderBy("id", "desc")
    .execute();
  if (rows.length === 0) return {};
  const filaments = await db
    .selectFrom("estimateFilaments")
    .select(["estimateId", "slot", "type", "color", "grams", "profile", "profileSource"])
    .where(
      "estimateId",
      "in",
      rows.map((r) => r.id),
    )
    .orderBy("slot")
    .execute();

  const label = (id: string) => id;
  const numbers = (row: EstimateRow, printerId: string): Numbers => ({
    source: row.source,
    estimateId: row.id,
    printerId,
    printerLabel: label(printerId),
    slicer: row.slicer,
    slicerVersion: row.slicerVersion,
    processProfile: row.processProfile,
    timeSeconds: row.status === "ok" ? row.timeSeconds : null,
    weightGrams: row.status === "ok" ? row.weightGrams : null,
    filaments:
      row.status === "ok"
        ? filaments
            .filter((f) => f.estimateId === row.id)
            .map((f) => ({
              slot: f.slot,
              type: f.type,
              color: f.color,
              grams: f.grams,
              // Stored when the slice landed; null where the slot could not
              // be matched to the slicer's preset list.
              profile: row.source === "file" ? null : f.profile,
              profileSource:
                row.source !== "file" && isProfileSource(f.profileSource) ? f.profileSource : null,
            }))
        : [],
  });

  const out: PlateNumbers = {};
  const selected = ctx.printers.find((p) => p.id === ctx.printerId);
  const fileRow = rows.find((r) => r.source === "file" && r.status === "ok");
  if (fileRow) {
    const printer = printerForFile(fileRow, ctx.printers);
    out.file = numbers(fileRow, printer?.id ?? fileRow.printerModelId ?? fileRow.printerId);
  }
  if (fileRow && fileIsFor(fileRow, selected)) return out;

  const own = rows.filter((r) => r.source === "platehouse");
  const wanted = own.find(
    (r) => r.printerId === ctx.printerId && r.slicerVersion === ctx.orcaVersion,
  );
  if (wanted?.status === "ok") {
    out.platehouse = { ...numbers(wanted, wanted.printerId), state: "current" };
    return out;
  }
  if (wanted?.status === "failed") {
    out.failure = {
      estimateId: wanted.id,
      reason: isReason(wanted.failureReason) ? wanted.failureReason : "slicer_error",
      words: reasonWords(wanted.failureReason),
      detail: wanted.failureDetail,
    };
  }
  // The newest finished estimate made for anything else, shown meanwhile.
  const older = own
    .filter((r) => r.status === "ok" && r !== wanted)
    .sort((a, b) => (b.finishedAt?.getTime() ?? 0) - (a.finishedAt?.getTime() ?? 0))[0];
  if (older) {
    out.platehouse = {
      ...numbers(older, older.printerId),
      state: "stale",
      staleFor:
        older.printerId !== ctx.printerId
          ? older.printerId
          : `${older.slicer ?? PLATEHOUSE_SLICER} ${older.slicerVersion ?? "unknown"}`,
    };
  } else if (wanted && (wanted.status === "pending" || wanted.status === "running")) {
    out.platehouse = {
      ...numbers(wanted, wanted.printerId),
      state: "estimating",
    };
  }
  return out;
}

/**
 * The AC-032 query: every plate of a live .3mf that has neither the file's
 * own numbers for the selected printer nor a finished or failed Platehouse
 * estimate for the selected printer and the current Orca version. Empty once
 * the slicer queue has drained.
 */
export async function platesWithoutNumbers(db: Kysely<DB>, ctx: DisplayContext): Promise<string[]> {
  const selected = ctx.printers.find((p) => p.id === ctx.printerId);
  const modelId = selected?.modelId ?? null;
  const nozzle = selected?.nozzle ?? null;
  const { rows } = await sql<{ id: string }>`
    select p.id
    from plates p
    join files f on f.id = p.file_id
    join models m on m.id = f.model_id
    where m.trashed_at is null
      and not exists (
        select 1 from estimates e
        where e.plate_id = p.id and e.source = 'file' and e.status = 'ok'
          and e.printer_model_id = ${modelId}
          and abs(e.nozzle - ${nozzle}::double precision) < ${NOZZLE_TOLERANCE}
      )
      and not exists (
        select 1 from estimates e
        where e.plate_id = p.id and e.source = 'platehouse'
          and e.printer_id = ${ctx.printerId}
          and e.slicer_version is not distinct from ${ctx.orcaVersion}
          and e.status in ('ok', 'failed')
      )
    order by p.id
  `.execute(db);
  return rows.map((r) => r.id);
}
