// A model's name when nobody has typed one. A new model is named from its
// .3mf's title when the file has one: the MakerWorld Title, the same field
// that becomes the model's caption (packages/makerworld extractMakerWorld,
// which reads it only from a file that names a Designer, so Bambu Studio's
// own project name and a generator's placeholder title such as "Untitled
// Bin" never name a model). Otherwise the name is the file's name cleaned:
// the extension of a supported kind dropped, underscores and runs of two or
// more dashes made spaces, case kept. A single dash stays ("T-Rex",
// "Drawer - Divider").
//
// Every name is cut at MAX_MODEL_NAME_LENGTH, the rename route's limit, so a
// name made here can always be saved again through the app API unchanged.
import type { NameSource } from "../db/types.js";

/**
 * The longest model name the app API takes (organise.ts NAME_BODY and the
 * public API's create-model body: maxLength 500). Names are cut in UTF-16
 * code units, which is never more code points than JSON Schema counts.
 */
export const MAX_MODEL_NAME_LENGTH = 500;

const SUPPORTED_EXTENSION = /\.(3mf|stl|step|stp|scad)$/i;

/** The last path segment of an uploaded name. */
function baseName(name: string): string {
  return name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1).trim() || name;
}

/**
 * The name a model got from its file before titles were used: the base name
 * without its last extension, whatever it was. Models named that way keep
 * that name until someone renames them or the title backfill runs.
 */
function rawStem(name: string): string {
  const base = baseName(name);
  const dot = base.lastIndexOf(".");
  return (dot > 0 ? base.slice(0, dot) : base).trim() || base;
}

/**
 * Whitespace collapsed and trimmed, then cut at MAX_MODEL_NAME_LENGTH
 * without splitting a surrogate pair, and trimmed again; null when blank.
 */
export function cutName(text: string | null | undefined): string | null {
  if (typeof text !== "string") return null;
  let name = text.replace(/\s+/g, " ").trim();
  if (name.length > MAX_MODEL_NAME_LENGTH) {
    let end = MAX_MODEL_NAME_LENGTH;
    const last = name.charCodeAt(end - 1);
    // A high surrogate at the cut would be left without its pair.
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    name = name.slice(0, end).trimEnd();
  }
  return name === "" ? null : name;
}

/** A model name from a file name: see the header. */
export function nameFromFile(originalName: string): string {
  const base = baseName(originalName);
  const dropped = base.replace(SUPPORTED_EXTENSION, "");
  const stem = dropped === "" ? base : dropped;
  const cleaned = cutName(stem.replace(/_/g, " ").replace(/-{2,}/g, " "));
  return cleaned ?? cutName(stem) ?? cutName(base) ?? base;
}

/** A new model's name and where it came from. */
export function newModelName(
  originalName: string,
  title: string | null | undefined,
): { name: string; source: NameSource } {
  const fromTitle = cutName(title);
  if (fromTitle !== null) return { name: fromTitle, source: "title" };
  return { name: nameFromFile(originalName), source: "file" };
}

/**
 * Every name a model could have been given by its files: each file's raw
 * stem (the name before this change) and its cleaned name (after). A model
 * whose name is none of these was named by a person, so nothing renames it.
 * A model a person named before name_source existed is 'user' (migration
 * 0006 marks every 'file' model whose name is none of its files' raw
 * stems), so the cleaned name here only ever matches a model named by
 * ingest since then.
 */
export function fileStems(originalNames: readonly string[]): Set<string> {
  const stems = new Set<string>();
  for (const name of originalNames) {
    stems.add(rawStem(name));
    stems.add(nameFromFile(name));
  }
  return stems;
}

/**
 * Whether a file name holds a control character: C0 (below U+0020) or DEL
 * (U+007F). The upload route refuses such a name, and the inbox moves such a
 * file to failed, so no newline or terminal escape reaches a log line, a
 * model's name or the Activity page from a file name.
 */
export function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
