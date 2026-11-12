// What one Manyfold model needs in Platehouse (AC-001, AC-002). Pure: no
// network, no clock.
//
// - A model is matched by externalRef = manyfold:<id>, Manyfold's public id
//   (the last segment of its URL), which Platehouse keeps unique across live
//   and trashed models.
// - A model Platehouse lacks is created with Manyfold's name, caption,
//   description, creator, licence (an SPDX id), tags (keywords) and
//   collections (isPartOf), each sent only when Manyfold has a value. Tags
//   and collections go once each, compared without case, as Platehouse
//   stores them.
// - A model Platehouse has is never edited: the API has no route to change a
//   model's details, and a field Jon changed stays his. It only gets the
//   tags and collections it lacks, and the files it lacks.
// - A file is in Platehouse when the model holds a file with the same
//   original name and Manyfold's contentSize, matched one to one. A file of
//   that name with another size is a failure, not a second upload, so a
//   re-run never makes a duplicate. A file with no contentSize fails, since
//   its size cannot be checked (AC-004). A file type Platehouse does not take
//   (Task 8: .3mf, .stl, .step, .stp, .scad) is skipped with the reason,
//   and is never downloaded.
import type { NewModel, PlatehouseFile, PlatehouseModel } from "./platehouse.js";

export interface SourceFile {
  url: string;
  filename: string;
  contentUrl: string;
  contentSize: number | null;
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
  /** Tags an existing model lacks. */
  tags: string[];
  /** Collections an existing model lacks. */
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

/** The externalRef a Manyfold model is matched by. */
export function externalRefFor(manyfoldId: string): string {
  return `manyfold:${manyfoldId}`;
}

/** Whether Platehouse takes a file with this name (Task 8's supported types). */
export function importable(filename: string): boolean {
  return EXTENSIONS.has(extensionOf(filename));
}

const blank = (v: string | null): v is null => v === null || v.trim() === "";

/** Each label once, the first spelling winning, compared without case. */
function unique(labels: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const label of labels) {
    const key = label.toLowerCase();
    if (label.trim() === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}

function lacking(wanted: string[], have: string[]): string[] {
  const held = new Set(have.map((x) => x.toLowerCase()));
  return unique(wanted).filter((x) => !held.has(x.toLowerCase()));
}

function newModel(source: SourceModel): NewModel {
  const model: NewModel = { name: source.name, externalRef: externalRefFor(source.id) };
  if (!blank(source.caption)) model.caption = source.caption;
  if (!blank(source.description)) model.description = source.description;
  if (!blank(source.creator)) model.creator = source.creator;
  if (!blank(source.license)) model.license = source.license;
  const tags = unique(source.tags);
  if (tags.length > 0) model.tags = tags;
  const collections = unique(source.collections);
  if (collections.length > 0) model.collections = collections;
  return model;
}

function planFiles(files: SourceFile[], stored: PlatehouseFile[]): FilePlan[] {
  const unmatched = [...stored];
  return files.map((file): FilePlan => {
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
  if (existing === undefined) {
    return {
      create: newModel(source),
      tags: [],
      collections: [],
      files: planFiles(source.files, []),
    };
  }
  return {
    create: null,
    tags: lacking(source.tags, existing.tags),
    collections: lacking(source.collections, existing.collections),
    files: planFiles(source.files, existing.files),
  };
}
