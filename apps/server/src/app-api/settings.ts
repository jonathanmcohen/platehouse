// The settings page's app API (build plan Task 21). Skeleton: the
// implementation follows the failing tests.
import type { Printer } from "@platehouse/slicer-contract";
import type { FastifyInstance } from "fastify";
import type { BucketVersioning } from "../db/types.js";
import type { Estimates } from "../estimates/service.js";
import type { SettingsRepo } from "../repos/settings.js";
import type { BlobStore } from "../storage/s3.js";

/** One printer model in the menu, with its nozzle choices. */
export interface PrinterGroup {
  model: string;
  printers: Array<{ id: string; nozzle: number }>;
}

/** What GET /app/api/settings answers. */
export interface SettingsView {
  printerId: string;
  /** The menu grouped by model; null while the slicer cannot be asked. */
  printers: PrinterGroup[] | null;
  bucketVersioning: BucketVersioning;
}

export interface SettingsApiDeps {
  settings: Pick<SettingsRepo, "get">;
  estimates: Pick<Estimates, "listPrinters" | "setPrinter">;
}

export function groupPrinters(_printers: readonly Printer[]): PrinterGroup[] {
  return [];
}

export async function recordVersioning(_deps: {
  store: Pick<BlobStore, "readVersioning">;
  settings: Pick<SettingsRepo, "update">;
  log?: (line: string) => void;
}): Promise<BucketVersioning | undefined> {
  return undefined;
}

export async function registerSettingsApi(
  _app: FastifyInstance,
  _deps: SettingsApiDeps | undefined,
): Promise<void> {}
