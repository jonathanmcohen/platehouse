// The description re-conversion (#357): a one-time step on upgrade that
// converts stored MakerWorld descriptions again from each model's source
// .3mf, so a converter fix reaches the library already imported, not only
// files imported from then on.
//
// It never overwrites a description a person wrote or changed. A
// description is converted again only when it can be proved to be exactly
// what a converter wrote:
// - one ingest wrote from 0.1.1 on carries the SHA-256 of what it wrote, the
//   converter version and the file it came from (migration 0010). It is
//   untouched while its text still has that hash, and is converted again
//   from that one file;
// - one written before 0.1.1 has no such record. It is untouched only when
//   its text is, byte for byte, what an earlier converter (packages/makerworld
//   earlierConversions: rc.1 to rc.3, then 0.1.0) writes for one of the
//   model's .3mf files, with or without that file's licence note at its foot,
//   composed as fillMetadata composes it. The first file that matches, in
//   upload order, is taken as its source.
// Anything else is left as it is: a description written through the API (the
// Manyfold import among them), one edited, one whose file is gone or cannot
// be read. A description is only ever written back with a compare-and-set on
// the text and hash it was read with, so one changed while this ran is left
// alone too.
//
// Gentle on the object store: one model at a time, one file at a time, and
// only the MakerWorld text of each file is read, through ranged reads
// (threemf readMakerWorldXml); a description with a hash that no longer
// matches is decided without reading anything. A model already written by
// the current converter is not a candidate at all. Safe to run twice: the
// run records itself in upgrade_steps under RECONVERT_STEP when it finishes,
// and a run that finds that record does nothing; a run cut off part way
// starts again on the next start-up, and what it already wrote is marked
// with the current converter, so it is not read again.
import {
  CONVERTER_VERSION,
  earlierConversions,
  extractMakerWorld,
  htmlToMarkdown,
  mapLicense,
} from "@platehouse/makerworld";
import { ReadUnavailable, readMakerWorldXml } from "@platehouse/threemf";
import { BlobNotFound, type BlobStore } from "../storage/s3.js";
import { descriptionSha256 } from "./description-hash.js";

export { descriptionSha256 };

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

/** Reads a file's text; null when the file cannot be read (gone, damaged). Throws on an outage. */
export type ReadText = (file: SourceFile) => Promise<SourceText | null>;

export type Decision =
  /** Its hash no longer matches: changed since a converter wrote it. */
  | { kind: "edited" }
  /** No hash, and no earlier converter wrote it from any of its files. */
  | { kind: "unproven" }
  /** Its source could not be read, so nothing can be proved. */
  | { kind: "unreadable" }
  /** The current converter writes the same text. */
  | { kind: "same"; fileId: string; description: string }
  /** The current converter writes this instead. */
  | { kind: "changed"; fileId: string; description: string };

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
  finishStep(name: string, result: ReconvertResult): Promise<void>;
  /**
   * Models with a non-empty description not written by the current
   * converter, in id order, after the id given (null for the first page).
   */
  candidates(after: string | null, limit: number): Promise<StoredDescription[]>;
  sourceFiles(modelId: string): Promise<SourceFile[]>;
  /**
   * Writes the description, its hash, the current converter and the file,
   * only while the stored description and hash are still the ones read.
   * False when they are not.
   */
  write(row: StoredDescription, next: { description: string; fileId: string }): Promise<boolean>;
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
  const parts = [markdown, withNote && note?.trim() ? note : ""].filter((p) => p !== "");
  return parts.join("\n\n");
}

/** The current converter's text, trimmed as ingest stores it. */
const convertNow = (html: string | null): string => (html ? htmlToMarkdown(html).trim() : "");

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
  const description = composeDescription(convertNow(text.html), text.note, withNote);
  return description === stored.description
    ? { kind: "same", fileId, description }
    : { kind: "changed", fileId, description };
}

/** What the run does with one model's description. */
export async function decide(
  stored: StoredDescription,
  files: readonly SourceFile[],
  readText: ReadText,
): Promise<Decision> {
  if (stored.sha256 !== null) {
    if (descriptionSha256(stored.description) !== stored.sha256) return { kind: "edited" };
    const source = files.find((f) => f.fileId === stored.fileId);
    if (source === undefined) return { kind: "unreadable" };
    const text = await readText(source);
    if (text === null) return { kind: "unreadable" };
    return outcome(stored, source.fileId, text, endsWithNote(stored.description, text.note));
  }
  // With no .3mf left to read, nothing can be proved either way.
  let unreadable = files.length === 0;
  for (const file of files) {
    const text = await readText(file);
    if (text === null) {
      unreadable = true;
      continue;
    }
    if (!text.html && !text.note) continue;
    for (const { markdown } of earlierConversions(text.html ?? "")) {
      for (const withNote of [false, true]) {
        const before = composeDescription(markdown, text.note, withNote);
        if (before !== "" && before === stored.description) {
          return outcome(stored, file.fileId, text, withNote);
        }
      }
    }
  }
  return unreadable ? { kind: "unreadable" } : { kind: "unproven" };
}

/**
 * Reads a stored .3mf's MakerWorld text from the object store with ranged
 * reads. A missing object or a file that is not a readable zip is null; a
 * file with no MakerWorld details gives no text. A store outage throws the
 * store's own error, which stops the run.
 */
export function storeTextReader(store: Pick<BlobStore, "getBlobRange">): ReadText {
  return async (file) => {
    let xml: string | null;
    try {
      xml = await readMakerWorldXml(
        (start, end) => store.getBlobRange(file.key, start, end),
        file.size,
      );
    } catch (err) {
      if (err instanceof ReadUnavailable && err.cause instanceof BlobNotFound) return null;
      if (err instanceof ReadUnavailable && err.cause instanceof Error) throw err.cause;
      throw err;
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
  /** One run; null when one already finished, so nothing was done. */
  run(): Promise<ReconvertResult | null>;
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
    async run() {
      if (await deps.store.stepFinished(RECONVERT_STEP)) return null;
      const result: ReconvertResult = {
        checked: 0,
        changed: 0,
        unchanged: 0,
        kept: 0,
        unreadable: 0,
      };
      let after: string | null = null;
      for (;;) {
        const page = await deps.store.candidates(after, batch);
        for (const row of page) {
          result.checked += 1;
          const files = await deps.store.sourceFiles(row.modelId);
          const decision = await decide(row, files, deps.readText);
          if (decision.kind === "same" || decision.kind === "changed") {
            const written = await deps.store.write(row, {
              description: decision.description,
              fileId: decision.fileId,
            });
            if (!written) result.kept += 1;
            else if (decision.kind === "changed") result.changed += 1;
            else result.unchanged += 1;
          } else if (decision.kind === "unreadable") result.unreadable += 1;
          else result.kept += 1;
        }
        if (page.length < batch) break;
        after = (page.at(-1) as StoredDescription).modelId;
      }
      await deps.store.finishStep(RECONVERT_STEP, result);
      log(
        `platehouse: MakerWorld descriptions converted again with converter ${CONVERTER_VERSION}: ` +
          `${result.checked} checked, ${result.changed} changed, ${result.unchanged} already right, ` +
          `${result.kept} left as they are (edited, or not written by the converter), ` +
          `${result.unreadable} could not be read`,
      );
      return result;
    },
  };
}
