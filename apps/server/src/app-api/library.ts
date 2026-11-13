// The library's app API (build plan Task 19; AC-061, AC-064, AC-073). Not
// yet implemented: this commit carries the interfaces and the failing tests.
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import type { DB, FileKind } from "../db/types.js";
import type { PlateNumbers } from "../estimates/display.js";
import type { LibrarySearch } from "../library/search.js";

/** The library's routes, every one session-class (the Route classes contract). */
export const LIBRARY_API_PATHS: readonly string[] = Object.freeze([
  "/app/api/library",
  "/app/api/library/tags",
]);

/** One card in the library grid. */
export interface LibraryCard {
  id: string;
  name: string;
  creator: string | null;
  tags: string[];
  /** Plates across the model's .3mf files. */
  plateCount: number;
  /** /blobs/<id> of plate 1's thumbnail in the model's first .3mf; null when there is none. */
  thumbnail: string | null;
  /** The kind of the file the card stands for, for the file-type icon; null for a model with no files. */
  fileKind: FileKind | null;
  /** Total print time for the selected printer, when every plate has numbers for it. */
  timeSeconds: number | null;
  /** Total weight for the selected printer, when every plate has numbers for it. */
  weightGrams: number | null;
  /** True when some plate has no numbers for the selected printer. */
  partial: boolean;
}

export interface AppLibraryPage {
  /** The selected printer the numbers are for. */
  printer: string;
  models: LibraryCard[];
  nextCursor: string | null;
}

export interface AppLibrary {
  list(query: LibrarySearch): Promise<AppLibraryPage>;
  /** Tag names live models carry, for the tag filter. */
  tags(): Promise<string[]>;
}

export interface AppLibraryDeps {
  db: Kysely<DB>;
  /** Task 12's plateNumbers for the selected printer. */
  plateNumbers(plateId: string): Promise<PlateNumbers>;
  /** settings.printer_id. */
  selectedPrinter(): Promise<string>;
}

export function createAppLibrary(_deps: AppLibraryDeps): AppLibrary {
  return {
    async list() {
      throw new Error("not implemented");
    },
    async tags() {
      throw new Error("not implemented");
    },
  };
}

/** The library when the server is given none: empty. */
export const emptyAppLibrary: AppLibrary = Object.freeze({
  list: async () => ({ printer: "", models: [], nextCursor: null }),
  tags: async () => [],
});

export async function registerLibraryApi(
  _app: FastifyInstance,
  _library: AppLibrary,
): Promise<void> {}
