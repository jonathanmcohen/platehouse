// Estimates, the printer setting and re-estimation (build plan Task 12).
// Skeleton: the failing tests come first.
import type { Printer } from "@platehouse/slicer-contract";
import type { Kysely } from "kysely";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import type { DB } from "../db/types.js";
import type { SlicerJobHandlers } from "../jobs/queues.js";
import type { Estimate } from "../repos/estimates.js";
import type { BlobStore } from "../storage/s3.js";
import type { SlicerClient } from "./client.js";
import type { PlateNumbers } from "./display.js";

export const SLICE_JOB_KIND = "slice";

export interface SliceJobData {
  kind: typeof SLICE_JOB_KIND;
  estimateId: string;
  printerId: string;
}

export type ReestimateReason = "printer" | "orca" | "startup";

export class UnknownPrinter extends Error {
  constructor() {
    super("That printer is not in the slicer's printer list");
    this.name = "UnknownPrinter";
  }
}

export interface SliceJobOptions {
  retryDelay?: number;
  retryDelayMax?: number;
}

export interface EstimatesDeps {
  db: Kysely<DB>;
  boss: PgBoss;
  slicer: SlicerClient;
  store: Pick<BlobStore, "getBlobStream">;
  sliceTimeoutMs?: number;
  jobOptions?: SliceJobOptions;
  log?: (line: string) => void;
}

export interface Estimates {
  listPrinters(): Promise<Printer[]>;
  setPrinter(printerId: string): Promise<void>;
  enqueuePlate(plateId: string, printerId: string, orcaVersion: string): Promise<Estimate | null>;
  enqueueFile(fileId: string): Promise<number>;
  reestimateAll(reason: ReestimateReason): Promise<number>;
  retryEstimate(estimateId: string): Promise<boolean>;
  pollOrca(): Promise<{ orca: string; changed: boolean }>;
  plateNumbers(plateId: string): Promise<PlateNumbers>;
  platesWithoutNumbers(): Promise<string[]>;
  runSliceJob(job: JobWithMetadata<SliceJobData>): Promise<void>;
  slicerJobs: SlicerJobHandlers;
}

export function createEstimates(_deps: EstimatesDeps): Estimates {
  const notYet = async (): Promise<never> => {
    throw new Error("not implemented");
  };
  return {
    listPrinters: notYet,
    setPrinter: notYet,
    enqueuePlate: notYet,
    enqueueFile: notYet,
    reestimateAll: notYet,
    retryEstimate: notYet,
    pollOrca: notYet,
    plateNumbers: notYet,
    platesWithoutNumbers: notYet,
    runSliceJob: notYet,
    slicerJobs: {},
  };
}
