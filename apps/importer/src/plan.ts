// What one Manyfold model needs in Platehouse (AC-001, AC-002). Pure: no
// network, no clock.
//
// - A model is matched by externalRef = manyfold:<id>, Manyfold's public id
//   (the last segment of its URL), which Platehouse keeps unique across live
//   and trashed models.
// - A model Platehouse lacks is created with Manyfold's name, caption,
//   description, creator, licence (an SPDX id), tags (keywords) and
//   collections (isPartOf), each sent only when Manyfold has a value. Tags
//   and collections are trimmed and go once each, compared without case, as
//   Platehouse stores and matches them (apps/server/src/repos/tags.ts
//   tagName and collections.ts collectionName trim with String.trim and
//   match with lower() on both sides). So a padded "Gifts " is sent as
//   "Gifts", and a re-run finds it held and sends nothing.
// - A model Platehouse has is never edited: the API has no route to change a
//   model's details, and a field Jon changed stays his. It only gets the
//   tags and collections it lacks, and the files it lacks.
// - A file's name is Manyfold's filename when it has an extension Platehouse
//   takes, else the last part of its contentUrl's path when that has one
//   (fileNameFor; issue #226: Manyfold's name field is the display name,
//   without the extension, so it is never used as the file name). A file of
//   a type Platehouse does not take keeps the name its type was read from and
//   is skipped below. A file with no name that has an extension at all fails,
//   with the reason, and is never downloaded.
// - A file is in Platehouse when the model holds a file with the same
//   original name and Manyfold's contentSize, matched one to one. A file of
//   that name with another size is a failure, not a second upload, so a
//   re-run never makes a duplicate. A file with no contentSize fails, since
//   its size cannot be checked (AC-004). A file type Platehouse does not take
//   (Task 8: .3mf, .stl, .step, .stp, .scad) is skipped with the reason,
//   and is never downloaded. So is a file whose contentSize is over
//   Platehouse's single-upload cap (MAX_UPLOAD_BYTES, 512 MiB, the server's
//   apps/server/src/uploads/tus.ts), which the upload would refuse only
//   after the whole file had been downloaded (issue #168).
// - Values are checked against the limits POST /api/v1/models and the tag and
//   collection PUTs enforce (apps/server/src/api/v1.ts NEW_MODEL and LABEL),
//   counted in code points as the server's validator counts them. One value
//   over a limit would get the whole create refused with 400 on every run, so
//   a caption, description, creator, licence, tag or collection over its
//   limit is left out with the reason in leftOut, and the rest of the model
//   still goes. A name or externalRef over its limit cannot be left out, so
//   the model is refused with the reason, and only when it would be made.
// - NEW_MODEL takes at most 100 tags and 100 collections in the create body,
//   but the tag and collection PUTs have no per-model cap. So a new model
//   gets its first 100 of each in the create and the rest with PUTs in the
//   same run (they ride in tags and collections), and nothing is left out
//   for the count; a re-run then finds nothing missing.
// - A PUT carries its label in the URL path, where Platehouse's router
//   (Fastify's find-my-way, default maxParamLength 100, not overridden in
//   apps/server/src/app.ts) measures it after decoding in UTF-16 units and
//   answers 414 past 100, before LABEL is checked. So a label sent by PUT
//   must also be at most 100 UTF-16 units; a longer one is left out with the
//   reason. The create body is not affected: Ajv counts code points there.
// - A label that is "." or ".." cannot go in a URL path at all: the URL
//   parser resolves it as a dot segment (%2e forms included), so the PUT
//   would reach another route. It is left out with the reason. In a new
//   model's create body, which carries no path, it is sent as it is.
import type { NewModel, PlatehouseFile, PlatehouseModel } from "./platehouse.js";

export interface SourceFile {
  url: string;
  /** The name it is uploaded under; when problem is set, only a label for the report. */
  filename: string;
  contentUrl: string;
  contentSize: number | null;
  /** Why no file name could be found for it (fileNameFor); the file then fails. */
  problem?: string | null;
}

export interface SourceModel {
  id: string;
  name: string;
  caption: string | null;
  description: string | null;
  creator: string | null;
  license: string | null;
  tags: string[];
  collections: string[];
  files: SourceFile[];
}

export type FilePlan =
  | { action: "import"; file: SourceFile }
  | { action: "present"; file: SourceFile; stored: PlatehouseFile }
  | { action: "skip"; file: SourceFile; reason: string }
  | { action: "fail"; file: SourceFile; reason: string };

export interface ModelPlan {
  /** The model to make, or null when it is already in Platehouse. */
  create: NewModel | null;
  /** Why the model cannot be made (a name or externalRef over its limit), or null. */
  refused: string | null;
  /** Each value left out because it is over Platehouse's limit, with the reason. */
  leftOut: string[];
  /** Tags to add by PUT: those an existing model lacks, or a new model's past the first 100. */
  tags: string[];
  /** Collections to add by PUT: as tags. */
  collections: string[];
  files: FilePlan[];
}

/** The extensions Platehouse takes (apps/server/src/ingest/detect.ts). */
const EXTENSIONS = new Set(["3mf", "stl", "step", "stp", "scad"]);

function extensionOf(name: string): string {
  const base = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/**
 * The largest file Platehouse takes in one upload: 536870912 bytes (512 MiB),
 * MAX_UPLOAD_BYTES in apps/server/src/uploads/tus.ts. plan.test.ts reads
 * that file and fails if the two ever differ (PR #211 review).
 */
export const MAX_UPLOAD_BYTES = 536_870_912;

/** An extension as a file type is written: letters and digits, no space. */
const TYPE_LIKE = /^[a-z0-9]{1,10}$/;

/**
 * The last part of a URL's path, decoded, or null when there is none or it
 * would not be one name (an escaped slash or backslash inside it, a bad escape).
 */
export function lastPathPart(link: string): string | null {
  const url = URL.parse(link);
  if (url === null) return null;
  const raw = url.pathname.split("/").at(-1) ?? "";
  let part: string;
  try {
    part = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return part === "" || /[/\\]/.test(part) ? null : part;
}

/**
 * A Manyfold file's name (issue #226): filename when it has an extension
 * Platehouse takes; else the last part of contentUrl's path when that has
 * one; else whichever of the two has an extension written as a file type,
 * so a type Platehouse does not take is skipped with its reason as before;
 * else no name, with the reason, and the label the report shows for it.
 * Manyfold's display name is never the file name: it has no extension, and
 * a dot inside it ("Switch 2.5g") would read as one.
 */
export function fileNameFor(file: {
  filename: string | null;
  contentUrl: string;
  displayName: string | null;
}): { name: string; problem: null } | { name: string; problem: string } {
  const filename = file.filename === null || file.filename.trim() === "" ? null : file.filename;
  const part = lastPathPart(file.contentUrl);
  for (const name of [filename, part]) {
    if (name !== null && importable(name)) return { name, problem: null };
  }
  for (const name of [filename, part]) {
    if (name !== null && TYPE_LIKE.test(extensionOf(name))) return { name, problem: null };
  }
  const fromFilename =
    filename === null ? "Manyfold sends no filename" : `the filename "${shown(filename)}" has none`;
  const fromUrl =
    part === null
      ? "its contentUrl's path ends in no name"
      : `the last part of its contentUrl, "${shown(part)}", has none`;
  return {
    name: filename ?? file.displayName ?? part ?? "(no name)",
    problem:
      `no file name with an extension: ${fromFilename}, and ${fromUrl}; ` +
      "its file type cannot be told, so it is not imported",
  };
}

/** The externalRef a Manyfold model is matched by. */
export function externalRefFor(manyfoldId: string): string {
  return `manyfold:${manyfoldId}`;
}

/** Whether Platehouse takes a file with this name (Task 8's supported types). */
export function importable(filename: string): boolean {
  return EXTENSIONS.has(extensionOf(filename));
}

const blank = (v: string | null): v is null => v === null || v.trim() === "";

/** The limits in apps/server/src/api/v1.ts: NEW_MODEL's fields and LABEL. */
export const LIMITS = {
  name: 500,
  caption: 2000,
  description: 200_000,
  creator: 300,
  license: 200,
  externalRef: 300,
  label: 100,
  labels: 100,
  /** Fastify's maxParamLength: a label in a PUT's path, in UTF-16 units. */
  pathParam: 100,
} as const;

/** Length as JSON Schema's maxLength counts it: in code points, not UTF-16 units. */
const length = (s: string) => [...s].length;

/** A long value shown in a reason: its first 40 code points. */
const shown = (s: string) => (length(s) > 40 ? `${[...s].slice(0, 40).join("")}...` : s);

const over = (n: number, limit: number) => `${n} characters, Platehouse takes at most ${limit}`;

/** Labels that fit LABEL's 100 characters; each one that does not goes to leftOut. */
function fitting(labels: string[], what: "tag" | "collection", leftOut: string[]): string[] {
  return labels.filter((label) => {
    const n = length(label);
    if (n <= LIMITS.label) return true;
    leftOut.push(`${what} ${shown(label)} left out: ${over(n, LIMITS.label)}`);
    return false;
  });
}

/**
 * Labels that also fit a PUT's URL path: at most 100 UTF-16 units once
 * decoded, as the router measures them (String.length); each one that does
 * not goes to leftOut.
 */
function fittingPath(labels: string[], what: "tag" | "collection", leftOut: string[]): string[] {
  return labels.filter((label) => {
    if (label === "." || label === "..") {
      leftOut.push(`${what} ${label} left out: a URL path cannot carry "." or ".." as a name`);
      return false;
    }
    if (label.length <= LIMITS.pathParam) return true;
    leftOut.push(
      `${what} ${shown(label)} left out: ${label.length} UTF-16 units in a URL path, ` +
        `Platehouse takes at most ${LIMITS.pathParam}`,
    );
    return false;
  });
}

/** A label as Platehouse matches it: trimmed, without case. */
const labelKey = (label: string) => label.trim().toLowerCase();

/** Each label once, trimmed, the first spelling winning, compared as labelKey does. */
function unique(labels: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of labels) {
    const label = raw.trim();
    const key = labelKey(label);
    if (label === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}

function lacking(
  wanted: string[],
  have: string[],
  what: "tag" | "collection",
  leftOut: string[],
): string[] {
  const held = new Set(have.map(labelKey));
  return fittingPath(
    fitting(
      unique(wanted).filter((x) => !held.has(labelKey(x))),
      what,
      leftOut,
    ),
    what,
    leftOut,
  );
}

/** Why the model cannot be made, or null: a required value over its limit. */
function refusal(model: NewModel): string | null {
  const name = length(model.name);
  if (name > LIMITS.name) {
    return `the name is ${name} characters; Platehouse takes at most ${LIMITS.name}`;
  }
  const ref = length(model.externalRef);
  if (ref > LIMITS.externalRef) {
    return `its externalRef is ${ref} characters; Platehouse takes at most ${LIMITS.externalRef}`;
  }
  return null;
}

/** A new model's labels: the first 100 go in the create, the rest by PUT. */
function split(
  labels: string[],
  what: "tag" | "collection",
  leftOut: string[],
): { body: string[]; put: string[] } {
  const all = fitting(unique(labels), what, leftOut);
  return {
    body: all.slice(0, LIMITS.labels),
    put: fittingPath(all.slice(LIMITS.labels), what, leftOut),
  };
}

/** The model to create, and the tags and collections to add after it by PUT. */
function newModel(
  source: SourceModel,
  leftOut: string[],
): { model: NewModel; tags: string[]; collections: string[] } {
  const model: NewModel = { name: source.name, externalRef: externalRefFor(source.id) };
  const optional = [
    ["caption", "caption", source.caption, LIMITS.caption],
    ["description", "description", source.description, LIMITS.description],
    ["creator", "creator", source.creator, LIMITS.creator],
    ["license", "licence", source.license, LIMITS.license],
  ] as const;
  for (const [key, label, value, limit] of optional) {
    if (blank(value)) continue;
    const n = length(value);
    if (n > limit) leftOut.push(`${label} left out: ${over(n, limit)}`);
    else model[key] = value;
  }
  const tags = split(source.tags, "tag", leftOut);
  if (tags.body.length > 0) model.tags = tags.body;
  const collections = split(source.collections, "collection", leftOut);
  if (collections.body.length > 0) model.collections = collections.body;
  return { model, tags: tags.put, collections: collections.put };
}

function planFiles(files: SourceFile[], stored: PlatehouseFile[]): FilePlan[] {
  const unmatched = [...stored];
  return files.map((file): FilePlan => {
    if (typeof file.problem === "string") return { action: "fail", file, reason: file.problem };
    if (!importable(file.filename)) {
      const ext = extensionOf(file.filename);
      const what = ext === "" ? "files without an extension" : `.${ext} files`;
      return { action: "skip", file, reason: `Platehouse does not take ${what}` };
    }
    if (file.contentSize === null) {
      return {
        action: "fail",
        file,
        reason: "Manyfold reports no contentSize for it, so its size cannot be checked",
      };
    }
    if (file.contentSize > MAX_UPLOAD_BYTES) {
      return {
        action: "skip",
        file,
        reason:
          `Manyfold says it is ${file.contentSize} bytes, over Platehouse's upload limit ` +
          `of ${MAX_UPLOAD_BYTES} bytes (512 MiB); not downloaded`,
      };
    }
    const at = unmatched.findIndex(
      (s) => s.originalName === file.filename && s.size === file.contentSize,
    );
    if (at !== -1) {
      const [match] = unmatched.splice(at, 1);
      if (match !== undefined) return { action: "present", file, stored: match };
    }
    const sameName = unmatched.find((s) => s.originalName === file.filename);
    if (sameName !== undefined) {
      return {
        action: "fail",
        file,
        reason:
          `Platehouse already holds a file of this name with ${sameName.size} bytes, ` +
          `not Manyfold's ${file.contentSize}; not uploaded again`,
      };
    }
    return { action: "import", file };
  });
}

export function planModel(source: SourceModel, existing: PlatehouseModel | undefined): ModelPlan {
  const leftOut: string[] = [];
  if (existing === undefined) {
    const { model: create, tags, collections } = newModel(source, leftOut);
    return {
      create,
      refused: refusal(create),
      leftOut,
      tags,
      collections,
      files: planFiles(source.files, []),
    };
  }
  const tags = lacking(source.tags, existing.tags, "tag", leftOut);
  const collections = lacking(source.collections, existing.collections, "collection", leftOut);
  return {
    create: null,
    refused: null,
    leftOut,
    tags,
    collections,
    files: planFiles(source.files, existing.files),
  };
}
