// What a plate shows for its numbers (build plan Task 12, AC-031 to AC-034).
// Skeleton: the failing tests come first.
import type { Printer, Reason } from "@platehouse/slicer-contract";
import type { Kysely } from "kysely";
import type { DB } from "../db/types.js";

export type ProfileSource = "bambu" | "generic" | "file";

export interface FilamentNumbers {
  slot: number;
  type: string;
  color: string | null;
  grams: number | null;
  profile: string | null;
  profileSource: ProfileSource | null;
}

export interface Numbers {
  source: "file" | "platehouse";
  estimateId: string;
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
  staleFor?: string;
}

export interface PlateFailure {
  estimateId: string;
  reason: Reason;
  words: string;
  detail: string | null;
}

export interface PlateNumbers {
  file?: Numbers;
  platehouse?: PlatehouseNumbers;
  failure?: PlateFailure;
}

export interface DisplayContext {
  printerId: string;
  orcaVersion: string | null;
  printers: readonly Printer[];
}

export function profileSourceOf(_profile: string | null): ProfileSource {
  throw new Error("not implemented");
}

export function printerForFile(
  _file: { printerModelId: string | null; nozzle: number | null },
  _printers: readonly Printer[],
): Printer | undefined {
  throw new Error("not implemented");
}

export async function plateNumbers(
  _db: Kysely<DB>,
  _ctx: DisplayContext,
  _plateId: string,
): Promise<PlateNumbers> {
  throw new Error("not implemented");
}

export async function platesWithoutNumbers(
  _db: Kysely<DB>,
  _ctx: DisplayContext,
): Promise<string[]> {
  throw new Error("not implemented");
}
