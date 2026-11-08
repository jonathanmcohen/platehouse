import type { Kysely, Selectable } from "kysely";
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

export interface PendingEstimate extends EstimateFields {
  slicer: string;
  slicerVersion: string;
}

export interface FileNumbers extends EstimateFields {
  slicer?: string | null;
  slicerVersion?: string | null;
  timeSeconds: number;
  weightGrams: number;
  filaments: EstimateFilament[];
}

export function estimatesRepo(_db: Kysely<DB>) {
  return {
    async upsertPending(_input: PendingEstimate): Promise<Estimate> {
      throw new Error("not implemented: estimates.upsertPending");
    },
    async insertFile(_input: FileNumbers): Promise<Estimate> {
      throw new Error("not implemented: estimates.insertFile");
    },
    async current(
      _plateId: string,
      _printerId: string,
      _orcaVersion: string,
    ): Promise<Estimate | undefined> {
      throw new Error("not implemented: estimates.current");
    },
  };
}

export type EstimatesRepo = ReturnType<typeof estimatesRepo>;
