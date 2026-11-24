// The description re-conversion (#357): a one-time step on upgrade that
// converts stored MakerWorld descriptions again from each model's source
// .3mf, so a converter fix reaches the library already imported, not only
// files imported from then on.
//
// It never overwrites a description a person wrote or changed. A
// description is converted again only when it can be proved to be exactly
// what a converter wrote:
// - one ingest wrote from 0.1.1 on carries the SHA-256 of what it wrote, the
//   converter version and the file it came from (migration 0014). It is
//   untouched while its text still has that hash, and is converted again
//   from that one file;
// - one written before 0.1.1 has no such record. It is untouched only when
//   its text is, byte for byte, what an earlier converter (packages/makerworld
//   earlierConversions: rc.1 to rc.3, then 0.1.0, then 0.1.1-rc.1) writes for one of the
//   model's .3mf files, with or without that file's licence note at its foot,
//   composed as fillMetadata composes it. The first file that matches, in
//   upload order, is taken as its source.
// Anything else is left as it is: a description written through the API (the
// Manyfold import among them), one edited, one whose file is gone or cannot
// be read. A description is only ever written back with a compare-and-set on
// the text and hash it was read with, so one changed while this ran is left
// alone too. One proved a converter's whose new conversion is over the
// 200,000 code point limit is left as it is as well, rather than emptied.
//
// Gentle on the object store: one model at a time, one file at a time, and
// only the MakerWorld text of each file is read, through ranged reads
// (threemf readMakerWorldXml); a description with a hash that no longer
// matches is decided without reading anything. A model already written by
// the current converter is not a candidate at all. Safe to run twice: the
// run records itself in upgrade_steps under RECONVERT_STEP when it finishes,
// and a run that finds that record does nothing. RECONVERT_STEP is named for
// the converter version, so a converter fix that raises CONVERTER_VERSION
// makes it a new step, which runs once more for what the older converters
// wrote (0.1.1-rc.1's step, reconvert-descriptions-3, then
// reconvert-descriptions-4). Only one run goes at a time
// (two servers started together, or a job queued again while one still runs):
// a run that finds another holding the step does nothing either. Each model's
// outcome is counted in the database as the run goes, with the model as the
// last one counted, and a write and its count land together. So a run cut off
// part way leaves its counts behind; the next start-up runs again, goes on
// after the last model counted, and the step records the totals of the whole
// conversion, which the Activity page shows, not only of the last run.
//
// A run is resumable and idempotent whatever happens to it (#381, #382):
// - It is told when to stop in two ways. stop, asked after each model it
//   counts, ends a slice (so each run checks at least one model); signal,
//   asked before each model and passed to every read of the object store,
//   ends it at once: the server's stop aborts it, so a read in flight is
//   abandoned rather than awaited. Either way the run returns
//   RECONVERT_PAUSED with its counts kept and nothing half done: a model is
//   only counted, or written and counted, in one step, after it is decided.
// - Only an outage stops a run with an error: the object store
//   (SourceOutage, from storeTextReader) or the database. A file that is
//   damaged in any way, missing, or that the converter cannot read, counts
//   that model as could not be read, and the run goes on.
// - The upgrade queue drives it (jobs/queues.ts): at start-up, on a
//   short schedule while it is pending, and with the next job after a slice.
//   An outage only delays it, with a back-off, and the schedule ends when
//   the step finishes. Only one run goes at a time (exclusive, below).

import type { Readable } from "node:stream";
import {
  CONVERTER_VERSION,
  earlierConversions,
  extractMakerWorld,
  mapLicense,
} from "@platehouse/makerworld";
import { ReadUnavailable, readMakerWorldXml } from "@platehouse/threemf";
import { BlobNotFound, StoreError, StoreUnavailable } from "../storage/s3.js";
import { conversion, joinWithNote } from "./converted-description.js";
import { descriptionSha256 } from "./description-hash.js";

export { descriptionSha256 };

/** What run gives when it stopped, as told, with models left to check. */
export const RECONVERT_PAUSED = "paused" as const;

/** The upgrade_steps name of the run for the current converter. */
export const RECONVERT_STEP = `reconvert-descriptions-${CONVERTER_VERSION}`;

/** A model's stored description and the record of where it came from. */
export interface StoredDescription {
  modelId: string;
  description: string;
  /** SHA-256, lowercase hex, of the description as a converter wrote it; null when none is recorded. */
  sha256: string | null;
  /** The converter version that wrote it; null when none is recorded. */
  converter: number | null;
  /** The .3mf it was converted from; null when none is recorded. */
  fileId: string | null;
}

/** A model's .3mf whose source blob is stored, in upload order. */
export interface SourceFile {
  fileId: string;
  key: string;
  size: number;
}

/** What a .3mf gives a description: its MakerWorld HTML and its licence note. */
export interface SourceText {
  html: string | null;
  note: string | null;
}

/**
 * Reads a file's text; null when the file cannot be read (gone, damaged).
 * Throws SourceOutage when the store is down, and stops when signal aborts.
 */
export type ReadText = (file: SourceFile, signal?: AbortSignal) => Promise<SourceText | null>;

/**
 * The object store could not be reached, or refused for a reason that is not
 * about the one object (its access settings, say). It stops the run, which
 * goes on once the store is back; it never counts a model.
 */
export class SourceOutage extends Error {
  constructor(cause: unknown) {
    super("The object store is unavailable", { cause });
    this.name = "SourceOutage";
  }
}

/** True for what a read gives when its signal aborted: the run was told to stop. */
function stopped(err: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (err instanceof Error && err.name === "AbortError");
}

export type Decision =
  /** Its hash no longer matches: changed since a converter wrote it. */
  | { kind: "edited" }
  /** No hash, and no earlier converter wrote it from any of its files. */
  | { kind: "unproven" }
  /** Its source could not be read, so nothing can be proved. */
  | { kind: "unreadable" }
  /**
   * Proved a converter's, but the current converter's text for it is over
   * the limit, so it would be stored as no description: it is kept as it is
   * (written by 0.1.0 or a release candidate, before the limit).
   */
  | { kind: "too_long" }
  /** The current converter writes the same text. */
  | { kind: "same"; fileId: string; description: string }
  /** The current converter writes this instead. */
  | { kind: "changed"; fileId: string; description: string };

/** What a run did with one model's description, as counted in ReconvertResult. */
export type Outcome = "changed" | "unchanged" | "kept" | "unreadable";

export interface ReconvertResult {
  /** Descriptions looked at. */
  checked: number;
  /** Written again with the current converter's text. */
  changed: number;
  /** Already what the current converter writes. */
  unchanged: number;
  /** Left as they are: edited, written another way, or changed while the run went. */
  kept: number;
  /** Left as they are because their source could not be read. */
  unreadable: number;
}

/** The database side of a run (repos/descriptions.ts). */
export interface ReconvertStore {
  stepFinished(name: string): Promise<boolean>;
  /**
   * Runs fn while holding the step's lease, so two runs never go at once.
   * Null, without running fn, while another run holds it. The lease is a
   * row that the run renews while fn goes and releases when it ends, however
   * it ends; one a dead server left runs out by itself. The signal fn is
   * given aborts when the lease can no longer be shown to be held (taken
   * over, two renewals in a row failed, or one renewal has hung past the
   * lease's safe margin), and fn then stops, as it does for a stop. renewMs and leaseMs are for tests: how often to renew, how long
   * a lease lasts.
   */
  exclusive<T>(
    name: string,
    fn: (lost: AbortSignal) => Promise<T>,
    options?: { renewMs?: number; leaseMs?: number },
  ): Promise<T | null>;
  /** The last model counted by runs of the step cut off before it finished; null when none. */
  resumeAfter(name: string): Promise<string | null>;
  /** Adds one model's outcome to the step's counts, the model as the last counted. */
  count(name: string, modelId: string, outcome: Outcome): Promise<void>;
  /**
   * Records the step finished with every count its runs made, and gives
   * those totals. A step already recorded keeps its record.
   */
  finishStep(name: string): Promise<ReconvertResult>;
  /**
   * Models with a non-empty description not written by the current
   * converter, in id order, after the id given (null for the first page).
   */
  candidates(after: string | null, limit: number): Promise<StoredDescription[]>;
  sourceFiles(modelId: string): Promise<SourceFile[]>;
  /**
   * Remembers that this description was read against the model's newest .3mf
   * and could not be proven to be the converter's own, so a later converter
   * version does not read the model's files again for it. Only while the
   * stored description is still the one given; a new .3mf or an edit makes
   * the model a candidate again by itself.
   */
  markUnproven(row: StoredDescription, newestFileId: string): Promise<void>;
  /**
   * Writes the description, its hash, the current converter and the file,
   * only while the stored description and hash are still the ones read, and
   * counts the outcome given for the model with it, all or nothing. False,
   * with nothing written or counted, when they are not.
   */
  write(
    row: StoredDescription,
    next: { description: string; fileId: string },
    count: { name: string; outcome: "changed" | "unchanged" },
  ): Promise<boolean>;
}

/**
 * The description fillMetadata stores from a converted text and a licence
 * note: the text, then the note after a blank line when it was added, a
 * blank part left out.
 */
export function composeDescription(
  markdown: string,
  note: string | null,
  withNote: boolean,
): string {
  return joinWithNote(markdown, withNote && note?.trim() ? note : null);
}

/** The current converter's text, trimmed as ingest stores it; null when over the limit. */
const convertNow = conversion;

/** True when the description carries the note at its foot, as fillMetadata adds it. */
function endsWithNote(description: string, note: string | null): boolean {
  if (!note?.trim()) return false;
  return description === note || description.endsWith(`\n\n${note}`);
}

function outcome(
  stored: StoredDescription,
  fileId: string,
  text: SourceText,
  withNote: boolean,
): Decision {
  const markdown = convertNow(text.html);
  if (markdown === null) return { kind: "too_long" };
  const description = composeDescription(markdown, text.note, withNote);
  return description === stored.description
    ? { kind: "same", fileId, description }
    : { kind: "changed", fileId, description };
}

/** What the run does with one model's description. */
export async function decide(
  stored: StoredDescription,
  files: readonly SourceFile[],
  readText: ReadText,
  signal?: AbortSignal,
): Promise<Decision> {
  // Anything that goes wrong with one file, other than an outage or a stop,
  // is that file being unreadable: a crafted .3mf or a converter bug must
  // never stop the run, or it would stop at the same model every time.
  const attempt = async <T>(fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof SourceOutage || stopped(err, signal)) throw err;
      return null;
    }
  };
  if (stored.sha256 !== null) {
    if (descriptionSha256(stored.description) !== stored.sha256) return { kind: "edited" };
    const source = files.find((f) => f.fileId === stored.fileId);
    if (source === undefined) return { kind: "unreadable" };
    const decision = await attempt(async () => {
      const text = await readText(source, signal);
      if (text === null) return null;
      return outcome(stored, source.fileId, text, endsWithNote(stored.description, text.note));
    });
    return decision ?? { kind: "unreadable" };
  }
  // With no .3mf left to read, nothing can be proved either way.
  let unreadable = files.length === 0;
  for (const file of files) {
    const found = await attempt(async () => {
      const text = await readText(file, signal);
      if (text === null) return null;
      if (!text.html && !text.note) return { decision: null };
      for (const { markdown } of earlierConversions(text.html ?? "")) {
        for (const withNote of [false, true]) {
          const before = composeDescription(markdown, text.note, withNote);
          if (before !== "" && before === stored.description) {
            return { decision: outcome(stored, file.fileId, text, withNote) };
          }
        }
      }
      return { decision: null };
    });
    if (found === null) unreadable = true;
    else if (found.decision !== null) return found.decision;
  }
  return unreadable ? { kind: "unreadable" } : { kind: "unproven" };
}

/** True for a store error about the one object, which says nothing about the store. */
function objectRefused(err: unknown): boolean {
  return (
    err instanceof BlobNotFound ||
    err instanceof RangeError ||
    (err instanceof StoreError && OBJECT_CODES.has(err.code))
  );
}

/** S3 codes that refuse one request for one object, not the store as a whole. */
const OBJECT_CODES: ReadonlySet<string> = new Set(["InvalidRange", "NoBody", "NoSuchKey"]);

/**
 * Reads a stored .3mf's MakerWorld text from the object store with ranged
 * reads, each given the run's signal. A missing object, a range the store
 * refuses, a file that is not a readable zip, or any other failure that is
 * about the file is null; a file with no MakerWorld details gives no text.
 * A store that cannot be reached (StoreUnavailable) or refuses for another
 * reason (any other StoreError) is SourceOutage, which stops the run until
 * the store is back. A read stopped by the signal stops the run too.
 */
export function storeTextReader(store: {
  getBlobRange(
    key: string,
    start: number,
    end: number,
    opts?: { signal?: AbortSignal },
  ): Promise<Readable>;
}): ReadText {
  return async (file, signal) => {
    let xml: string | null;
    try {
      xml = await readMakerWorldXml(
        (start, end) => store.getBlobRange(file.key, start, end, signal ? { signal } : undefined),
        file.size,
      );
    } catch (err) {
      const cause = err instanceof ReadUnavailable ? err.cause : err;
      if (stopped(cause, signal)) throw cause;
      if (objectRefused(cause)) return null;
      if (cause instanceof StoreUnavailable || cause instanceof StoreError) {
        throw new SourceOutage(cause);
      }
      return null;
    }
    if (xml === null) return null;
    const details = extractMakerWorld(xml);
    if (details === null) return { html: null, note: null };
    return { html: details.descriptionHtml, note: mapLicense(details.license).footer ?? null };
  };
}

export interface DescriptionReconvert {
  /** True until a run for the current converter has finished. */
  pending(): Promise<boolean>;
  /**
   * One run, giving the totals of the whole conversion; null when one
   * already finished or another is running, so nothing was done.
   * RECONVERT_PAUSED when stop said true after a model, with models left
   * (or none, when that was the last): its counts stay, nothing is recorded
   * finished, and the next run goes on after the last model counted. stop is
   * asked after each model counted, never before the first; with none given
   * the run goes to the end. signal, when it aborts, ends the run before the
   * next model and abandons any read in flight, also RECONVERT_PAUSED with
   * nothing counted for the model it was on. A store outage
   * (SourceOutage) or a database error rejects, with the counts so far kept.
   */
  run(
    stop?: () => boolean,
    signal?: AbortSignal,
  ): Promise<ReconvertResult | typeof RECONVERT_PAUSED | null>;
}

/** Models read from the database at a time. */
export const RECONVERT_BATCH = 50;

export function createDescriptionReconvert(deps: {
  store: ReconvertStore;
  readText: ReadText;
  log?: (line: string) => void;
  batchSize?: number;
}): DescriptionReconvert {
  const log = deps.log ?? ((line: string) => console.info(line));
  const batch = deps.batchSize ?? RECONVERT_BATCH;
  return {
    async pending() {
      return !(await deps.store.stepFinished(RECONVERT_STEP));
    },
    async run(stop = () => false, signal?: AbortSignal) {
      if (await deps.store.stepFinished(RECONVERT_STEP)) return null;
      return deps.store.exclusive(RECONVERT_STEP, async (lost) => {
        // Another run may have finished between the check above and taking the step.
        if (await deps.store.stepFinished(RECONVERT_STEP)) return null;
        let after = await deps.store.resumeAfter(RECONVERT_STEP);
        for (;;) {
          const page = await deps.store.candidates(after, batch);
          for (const row of page) {
            if (signal?.aborted || lost.aborted) return RECONVERT_PAUSED;
            const files = await deps.store.sourceFiles(row.modelId);
            let decision: Decision;
            try {
              decision = await decide(row, files, deps.readText, signal);
            } catch (err) {
              // Told to stop part way through the model: nothing is counted
              // for it, so the next run decides it again from the start.
              if (stopped(err, signal)) return RECONVERT_PAUSED;
              throw err;
            }
            if (decision.kind === "same" || decision.kind === "changed") {
              const outcome = decision.kind === "changed" ? "changed" : "unchanged";
              const written = await deps.store.write(
                row,
                { description: decision.description, fileId: decision.fileId },
                { name: RECONVERT_STEP, outcome },
              );
              // Changed since it was read, so it is left as it is now.
              if (!written) await deps.store.count(RECONVERT_STEP, row.modelId, "kept");
            } else {
              const newest = files[files.length - 1];
              if (decision.kind === "unproven" && newest !== undefined) {
                await deps.store.markUnproven(row, newest.fileId);
              }
              const outcome = decision.kind === "unreadable" ? "unreadable" : "kept";
              await deps.store.count(RECONVERT_STEP, row.modelId, outcome);
            }
            if (lost.aborted) {
              log("platehouse: MakerWorld description re-conversion: lost its lease; stopping");
              return RECONVERT_PAUSED;
            }
            if (stop() || signal?.aborted) {
              log(
                `platehouse: MakerWorld description re-conversion stopped after model ${row.modelId}; ` +
                  "it goes on in a new job",
              );
              return RECONVERT_PAUSED;
            }
          }
          if (page.length < batch) break;
          after = (page.at(-1) as StoredDescription).modelId;
        }
        const result = await deps.store.finishStep(RECONVERT_STEP);
        log(
          `platehouse: MakerWorld descriptions converted again with converter ${CONVERTER_VERSION}: ` +
            `${result.checked} checked, ${result.changed} changed, ${result.unchanged} already right, ` +
            `${result.kept} left as they are (edited, or not written by the converter), ` +
            `${result.unreadable} could not be read`,
        );
        return result;
      });
    },
  };
}
