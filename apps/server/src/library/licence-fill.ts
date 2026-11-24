// The licence fill on upgrade (#445): models imported with a MakerWorld
// licence an earlier release did not keep (CC BY-ND, say) have no licence and
// no licence note. A run reads each such model's stored .3mf files again, the
// oldest first as ingest does, and fills the licence of the first file that
// names one: an SPDX id, or a note in the description's licence-note wording.
// It sets only the licence columns, never a description, and only on a model
// that still has neither a licence nor a note when it writes. The database
// side is repos/descriptions.ts; the run has the shape of the description
// re-conversion's (library/reconvert.ts), with its own step and its own counts.
import { mapLicense } from "@platehouse/makerworld";
import {
  type DetailsStore,
  RECONVERT_PAUSED,
  type ReconvertStore,
  readDetails,
  type SourceFile,
  SourceOutage,
  stopped,
} from "./reconvert.js";

/** The upgrade_steps name of the licence fill. */
export const LICENCE_STEP = "licences-from-makerworld-1";

/** What a run did with one model, as counted in LicenceFillResult. */
export type LicenceOutcome = "filled" | "none" | "kept" | "unreadable";

/** Every outcome an upgrade step counts: this fill's and the description re-conversion's. */
export type StepOutcome = LicenceOutcome | "changed" | "unchanged";

export interface LicenceFillResult {
  /** Models looked at. */
  checked: number;
  /** Given the licence or note their .3mf names. */
  filled: number;
  /** No stored .3mf names a licence. */
  none: number;
  /** Left as they are: they gained a licence or note while the run went. */
  kept: number;
  /** No licence found, and a file could not be read. */
  unreadable: number;
}

/**
 * Reads a file's licence value; null when the file cannot be read (gone,
 * damaged). A readable file with no licence gives { license: null }. Throws
 * SourceOutage when the store is down, and stops when signal aborts.
 */
export type ReadLicence = (
  file: SourceFile,
  signal?: AbortSignal,
) => Promise<{ license: string | null } | null>;

export function storeLicenceReader(store: DetailsStore): ReadLicence {
  return async (file, signal) => {
    const read = await readDetails(store, file, signal);
    if (read === null) return null;
    return { license: read.details?.license ?? null };
  };
}

/** The database side of a run: the generic step methods and the two licence ones. */
export interface LicenceStore
  extends Pick<ReconvertStore, "stepFinished" | "exclusive" | "resumeAfter" | "sourceFiles"> {
  /** Adds one model's outcome to the step's counts, the model as the last counted. */
  count(name: string, modelId: string, outcome: LicenceOutcome): Promise<void>;
  /** Records the step finished with every count its runs made, and gives those totals. */
  finishStep(name: string): Promise<LicenceFillResult>;
  /**
   * Models with no licence, no licence note and no purge begun, with a stored
   * .3mf, in id order, after the id given (null for the first page).
   */
  licenceCandidates(after: string | null, limit: number): Promise<{ modelId: string }[]>;
  /**
   * Sets the licence and note, and counts the model filled with it, all or
   * nothing, only while the model still has neither. False, with nothing
   * written or counted, when it has one now.
   */
  writeLicence(
    modelId: string,
    set: { spdx: string | null; note: string | null },
    count: { name: string },
  ): Promise<boolean>;
}

export interface LicenceFill {
  /** True until the fill has finished. */
  pending(): Promise<boolean>;
  /**
   * One run, as DescriptionReconvert.run: the totals when it finished, null
   * when it already had or another run holds it, RECONVERT_PAUSED when told
   * to stop (stop is asked after each model, never before the first; signal
   * ends the run before the next model). A store outage (SourceOutage) or a
   * database error rejects, with the counts so far kept.
   */
  run(
    stop?: () => boolean,
    signal?: AbortSignal,
  ): Promise<LicenceFillResult | typeof RECONVERT_PAUSED | null>;
}

/** Models read from the database at a time. */
export const LICENCE_BATCH = 50;

type Found =
  | { kind: "found"; spdx: string | null; note: string | null }
  | { kind: "none" }
  | { kind: "unreadable" };

/** The first file, oldest first, that names a licence. */
async function find(
  files: SourceFile[],
  readLicence: ReadLicence,
  signal: AbortSignal | undefined,
): Promise<Found> {
  let unreadable = false;
  for (const file of files) {
    const read = await readLicence(file, signal);
    if (read === null) {
      unreadable = true;
      continue;
    }
    const m = mapLicense(read.license);
    if (m.spdx !== undefined || m.footer !== undefined) {
      return { kind: "found", spdx: m.spdx ?? null, note: m.footer ?? null };
    }
  }
  return unreadable ? { kind: "unreadable" } : { kind: "none" };
}

export function createLicenceFill(deps: {
  store: LicenceStore;
  readLicence: ReadLicence;
  log?: (line: string) => void;
  batchSize?: number;
}): LicenceFill {
  const log = deps.log ?? ((line: string) => console.info(line));
  const batch = deps.batchSize ?? LICENCE_BATCH;
  const { store } = deps;
  return {
    async pending() {
      return !(await store.stepFinished(LICENCE_STEP));
    },
    async run(stop = () => false, signal?: AbortSignal) {
      if (await store.stepFinished(LICENCE_STEP)) return null;
      return store.exclusive(LICENCE_STEP, async (lost) => {
        // Another run may have finished between the check above and taking the step.
        if (await store.stepFinished(LICENCE_STEP)) return null;
        let after = await store.resumeAfter(LICENCE_STEP);
        for (;;) {
          const page = await store.licenceCandidates(after, batch);
          for (const { modelId } of page) {
            if (signal?.aborted || lost.aborted) return RECONVERT_PAUSED;
            const files = await store.sourceFiles(modelId);
            let found: Found;
            try {
              found = await find(files, deps.readLicence, signal);
            } catch (err) {
              // Told to stop part way through the model: nothing is counted
              // for it, so the next run decides it again from the start.
              if (err instanceof SourceOutage) throw err;
              if (stopped(err, signal)) return RECONVERT_PAUSED;
              throw err;
            }
            if (found.kind === "found") {
              const written = await store.writeLicence(
                modelId,
                { spdx: found.spdx, note: found.note },
                { name: LICENCE_STEP },
              );
              // It has a licence or note now, so it is left as it is.
              if (!written) await store.count(LICENCE_STEP, modelId, "kept");
            } else {
              await store.count(LICENCE_STEP, modelId, found.kind);
            }
            if (lost.aborted) {
              log("platehouse: MakerWorld licence fill: lost its lease; stopping");
              return RECONVERT_PAUSED;
            }
            if (stop() || signal?.aborted) {
              log(
                `platehouse: MakerWorld licence fill stopped after model ${modelId}; ` +
                  "it goes on in a new job",
              );
              return RECONVERT_PAUSED;
            }
          }
          if (page.length < batch) break;
          after = (page.at(-1) as { modelId: string }).modelId;
        }
        const result = await store.finishStep(LICENCE_STEP);
        log(
          "platehouse: MakerWorld licences filled in from their .3mf files: " +
            `${result.checked} checked, ${result.filled} filled, ${result.none} name none, ` +
            `${result.kept} left as they are (a licence was set meanwhile), ` +
            `${result.unreadable} could not be read`,
        );
        return result;
      });
    },
  };
}
