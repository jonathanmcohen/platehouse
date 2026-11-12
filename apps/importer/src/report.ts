// The import report: one line per model, one size row per file, the totals.

export type Mode = "dry run" | "apply";

export type FileStatus =
  | "imported"
  | "would import"
  | "already in Platehouse"
  | "skipped"
  | "failed";

export interface FileRow {
  name: string;
  /** Manyfold's contentSize. */
  manyfoldSize: number | null;
  /** The size Platehouse stored. */
  storedSize: number | null;
  /** The SHA-256 Platehouse recorded, hex. */
  sha256: string | null;
  status: FileStatus;
  reason: string | null;
}

export type Outcome = "imported" | "skipped" | "failed";

export interface ModelResult {
  manyfoldId: string;
  name: string;
  outcome: Outcome;
  reason: string | null;
  /** The model was made in Platehouse by this run (in a dry run: would be). */
  newModel: boolean;
  files: FileRow[];
}

export interface Report {
  mode: Mode;
  found: number;
  models: ModelResult[];
}

export interface Totals {
  found: number;
  imported: number;
  skipped: number;
  failed: number;
  newModels: number;
  filesImported: number;
  filesSkipped: number;
  sizeMismatches: number;
}

export function totals(_report: Report): Totals {
  throw new Error("not implemented");
}

export function modelLines(_result: ModelResult, _index: number, _total: number): string[] {
  throw new Error("not implemented");
}

export function summaryLines(_report: Report): string[] {
  throw new Error("not implemented");
}

/** 0 when every model was handled, 1 when one failed or the counts do not add up. */
export function exitCode(_report: Report): 0 | 1 {
  throw new Error("not implemented");
}
