// The ingest pipeline (build plan Task 8; AC-020 server side, AC-022, AC-024,
// AC-033, AC-012). Every way a file arrives (the tus upload of Task 9 for the
// UI and the API, the inbox of Task 10, the importer through the API) ends in
// ingestFile.
//
// The order is the plan's:
//   1. detect: the name and the first bytes must agree on a supported kind
//      (detect.ts), or the file is refused and nothing is stored (AC-024);
//   2. hash and put the source blob: putBlob hashes while it uploads and
//      checks the stored size;
//   3. parse a .3mf (packages/threemf); each plate thumbnail is put as a blob
//      as the parser hands it over, one at a time, never all held;
//   4. one transaction: the model (when new), the blob rows, the file, its
//      filament list, its plates and the file's own numbers (estimates with
//      source 'file'). Metadata is filled only into empty fields, so nothing
//      Jon set is overwritten (AC-022);
//   5. enqueueing estimates (Task 12) and renders (Task 13) comes after the
//      commit, and is theirs to add. Nothing here calls the slicer, so ingest
//      returns before any slice runs (AC-033).
//
// No row is written before step 4. A failure at any step deletes the objects
// already put and leaves no rows (AC-012), unless the file row turns out to
// exist (a COMMIT that succeeded but reported an error) or the database
// cannot say; then the objects are kept. An object left with no row is
// removed later by the orphan sweep (orphans.ts). A store outage fails
// visibly with STORAGE_UNAVAILABLE_MESSAGE. The uploaded file at tmpPath is
// never deleted
// here: its owner (the tus store, the inbox) decides, so the inbox can retry
// after an outage.
//
// A combined batch (target {batch, combine: true}) puts every file in one
// model. Its id is derived from the batch (batchModelId), so every file of
// the batch knows its key prefix before the model exists, and
// pg_advisory_xact_lock(hashtext(batch)) makes concurrent finishes take turns:
// the first creates the model and the rest join it.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { extractMakerWorld, htmlToMarkdown, mapLicense } from "@platehouse/makerworld";
import { type Project, readProject } from "@platehouse/threemf";
import { type Kysely, sql } from "kysely";
import { isUuid, uuidv7 } from "../db/ids.js";
import type { BlobKind, DB, FileKind, ParseStatus } from "../db/types.js";
import { createRepos } from "../repos/index.js";
import type { FoundMetadata } from "../repos/models.js";
import { blobKey } from "../storage/keys.js";
import { type BlobStore, StoreUnavailable } from "../storage/s3.js";
import { detectKind, FIRST_BYTES } from "./detect.js";

export const STORAGE_UNAVAILABLE_MESSAGE = "Storage is unavailable right now; nothing was saved";

const UNSUPPORTED_MESSAGE =
  "This file is not a supported .3mf, .stl, .step, .stp or .scad file; nothing was saved";

const MODEL_NOT_FOUND_MESSAGE = "That model does not exist or is in the trash; nothing was saved";

export type IngestErrorCode = "unsupported_type" | "storage_unavailable" | "model_not_found";

/**
 * An upload refused or failed with a plain message for Jon. Any other error
 * (a filesystem error reading the upload, a database error) reaches the
 * caller unchanged; either way nothing is left behind.
 */
export class IngestError extends Error {
  readonly code: IngestErrorCode;

  constructor(code: IngestErrorCode, message: string) {
    super(message);
    this.name = "IngestError";
    this.code = code;
  }
}

/**
 * Where the file goes: a new model of its own, an existing live model, or a
 * batch, whose files each get their own model unless combine is set.
 */
export type IngestTarget = { modelId: string } | { batch: string; combine: boolean } | "new";

export interface IngestInput {
  /** The uploaded bytes, already complete on local disk. */
  tmpPath: string;
  /** The name the file was uploaded with; it picks the kind. */
  originalName: string;
  target: IngestTarget;
}

export interface IngestResult {
  modelId: string;
  fileId: string;
}

/** The store calls ingest makes; the real one is createBlobStore's. */
export type IngestStore = Pick<BlobStore, "putBlob" | "deleteBlobs">;

const CONTENT_TYPES: Readonly<Record<FileKind, string>> = {
  "3mf": "model/3mf",
  stl: "model/stl",
  step: "model/step",
  scad: "text/plain; charset=utf-8",
};

/** printer_id of a file's own numbers when the file does not name its printer. */
export const UNKNOWN_FILE_PRINTER = "unknown";

/**
 * The model id of a combined batch: UUIDv7-shaped (version 7, RFC 9562
 * variant), so it fits the bucket key layout, with every other bit from the
 * SHA-256 of the batch. Its time field is therefore not a creation time.
 */
export function batchModelId(batch: string): string {
  const b = createHash("sha256").update(`platehouse-batch-v1\0${batch}`, "utf8").digest();
  b[6] = 0x70 | ((b[6] ?? 0) & 0x0f);
  b[8] = 0x80 | ((b[8] ?? 0) & 0x3f);
  const hex = b.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function readFirstBytes(path: string): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buf = Buffer.alloc(FIRST_BYTES);
    const { bytesRead } = await handle.read(buf, 0, FIRST_BYTES, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** The last path segment of an uploaded name. */
function baseName(name: string): string {
  return name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1).trim() || name;
}

/** A new model's name: the file's name without its extension. */
function modelNameOf(name: string): string {
  const base = baseName(name);
  const dot = base.lastIndexOf(".");
  return (dot > 0 ? base.slice(0, dot) : base).trim() || base;
}

/** The MakerWorld details of a .3mf as model metadata (AC-022, packages/makerworld). */
function metadataOf(project: Project | null): FoundMetadata {
  const details = project?.makerWorldXml ? extractMakerWorld(project.makerWorldXml) : null;
  if (details === null) return {};
  const license = mapLicense(details.license);
  const markdown = details.descriptionHtml ? htmlToMarkdown(details.descriptionHtml).trim() : "";
  // A footer licence sets no SPDX id. fillMetadata stores it as the licence
  // note whenever the model has none, and adds it at the foot of the
  // description only when the description is empty (Jon, 2026-11-08: a
  // description already set is never edited; the model page shows the note).
  return {
    caption: details.title,
    creator: details.designer,
    descriptionMd: markdown === "" ? null : markdown,
    licenseSpdx: license.spdx ?? null,
    licenseNote: license.footer ?? null,
  };
}

/** One row per slot, the first kept: a crafted file may repeat a filament id. */
function uniqueSlots<T extends { slot: number }>(items: readonly T[]): T[] {
  const seen = new Set<number>();
  return items.filter((item) => !seen.has(item.slot) && seen.add(item.slot));
}

interface PutBlob {
  id: string;
  key: string;
  kind: BlobKind;
  contentType: string;
  size: number;
  sha256: Buffer;
}

export function createIngest(deps: { db: Kysely<DB>; store: IngestStore }) {
  const { db, store } = deps;

  /** The model the file will join, checked before any byte is stored. */
  async function plannedModel(target: IngestTarget): Promise<string> {
    if (target === "new") return uuidv7();
    if ("modelId" in target) {
      const id = target.modelId.toLowerCase();
      if (!isUuid(id) || (await createRepos(db).models.get(id)) === undefined) {
        throw new IngestError("model_not_found", MODEL_NOT_FOUND_MESSAGE);
      }
      return id;
    }
    if (typeof target.batch !== "string" || target.batch === "") {
      throw new TypeError("ingestFile: a batch target needs a non-empty batch id");
    }
    if (!target.combine) return uuidv7();
    const id = batchModelId(target.batch);
    const existing = await createRepos(db).models.get(id, { includeTrashed: true });
    if (existing?.trashedAt) throw new IngestError("model_not_found", MODEL_NOT_FOUND_MESSAGE);
    return id;
  }

  /**
   * After a failure: whether the transaction may have committed after all.
   * An error from the transaction can come from a COMMIT that reached the
   * server (the connection dropped while the answer was on its way), so the
   * file row is looked up before any object is deleted. True when the row is
   * there, and also when the lookup itself fails: the objects are then kept,
   * and if no row points at them the orphan sweep removes them after 24
   * hours. Deleting the bytes behind committed rows cannot be undone.
   */
  async function mayHaveCommitted(fileId: string): Promise<boolean> {
    try {
      const row = await db
        .selectFrom("files")
        .select("id")
        .where("id", "=", fileId)
        .executeTakeFirst();
      return row !== undefined;
    } catch {
      return true;
    }
  }

  async function ingestFile(input: IngestInput): Promise<IngestResult> {
    const { tmpPath, originalName, target } = input;
    const { size } = await stat(tmpPath);
    const kind = detectKind(originalName, await readFirstBytes(tmpPath), size);
    if (kind === null) throw new IngestError("unsupported_type", UNSUPPORTED_MESSAGE);
    const modelId = await plannedModel(target);

    const put: PutBlob[] = [];
    const putOne = async (
      kindOfBlob: BlobKind,
      body: Readable,
      bytes: number,
      contentType: string,
    ): Promise<PutBlob> => {
      const id = uuidv7();
      const key = blobKey(modelId, id);
      const stored = await store.putBlob(body, { key, size: bytes, contentType });
      const blob = { id, key, kind: kindOfBlob, contentType, ...stored };
      put.push(blob);
      return blob;
    };

    const fileId = uuidv7();
    try {
      const source = await putOne("source", createReadStream(tmpPath), size, CONTENT_TYPES[kind]);

      let project: Project | null = null;
      let parseStatus: ParseStatus = "ok";
      const thumbnails = new Map<number, string>();
      if (kind === "3mf") {
        project = await readProject(tmpPath, {
          onThumbnail: async (index, png) => {
            const blob = await putOne("thumbnail", Readable.from([png]), png.length, "image/png");
            thumbnails.set(index, blob.id);
          },
        });
        if (project === null) parseStatus = "no_plate_data";
      }

      await db.transaction().execute(async (trx) => {
        const repos = createRepos(trx);
        const found = metadataOf(project);

        if (target !== "new" && "modelId" in target) {
          // Still live now that the rows are written (a trash may have come
          // in while the bytes were uploading).
          const live = await trx
            .selectFrom("models")
            .select("id")
            .where("id", "=", modelId)
            .where("trashedAt", "is", null)
            .forUpdate()
            .executeTakeFirst();
          if (live === undefined) throw new IngestError("model_not_found", MODEL_NOT_FOUND_MESSAGE);
        } else if (target !== "new" && target.combine) {
          await sql`select pg_advisory_xact_lock(hashtext(${target.batch}))`.execute(trx);
          const existing = await trx
            .selectFrom("models")
            .select(["id", "trashedAt"])
            .where("id", "=", modelId)
            .forUpdate()
            .executeTakeFirst();
          if (existing === undefined) {
            await repos.models.create({ id: modelId, name: modelNameOf(originalName) });
          } else if (existing.trashedAt !== null) {
            throw new IngestError("model_not_found", MODEL_NOT_FOUND_MESSAGE);
          }
        } else {
          await repos.models.create({ id: modelId, name: modelNameOf(originalName) });
        }
        // One fill rule for a new model and an existing one (AC-022).
        await repos.models.fillMetadata(modelId, found);

        for (const blob of put) {
          await repos.blobs.insertPending({
            id: blob.id,
            modelId,
            kind: blob.kind,
            contentType: blob.contentType,
            size: blob.size,
          });
          await repos.blobs.markStored(blob.id, { size: blob.size, sha256: blob.sha256 });
        }

        await repos.files.create({
          id: fileId,
          modelId,
          blobId: source.id,
          name: baseName(originalName),
          originalName,
          kind,
          size: source.size,
          sha256: source.sha256,
          parseStatus,
        });
        if (project === null) return;

        const filaments = uniqueSlots(project.projectFilaments);
        if (filaments.length > 0) {
          await trx
            .insertInto("fileFilaments")
            .values(filaments.map((f) => ({ fileId, slot: f.slot, type: f.type, color: f.colour })))
            .execute();
        }
        for (const plate of project.plates) {
          const row = await repos.plates.create({
            fileId,
            index: plate.index,
            name: plate.name,
            objectCount: plate.objectCount,
            thumbnailBlobId: thumbnails.get(plate.index) ?? null,
          });
          if (
            !plate.sliced ||
            plate.predictionSeconds === undefined ||
            plate.weightGrams === undefined
          ) {
            continue;
          }
          await repos.estimates.insertFile({
            plateId: row.id,
            printerId: project.slicedFor?.printerModelId ?? UNKNOWN_FILE_PRINTER,
            printerModelId: project.slicedFor?.printerModelId ?? null,
            nozzle: project.slicedFor?.nozzle ?? null,
            processProfile: project.processName ?? null,
            timeSeconds: Math.round(plate.predictionSeconds),
            weightGrams: plate.weightGrams,
            filaments: uniqueSlots(plate.filaments).map((f) => ({
              slot: f.slot,
              type: f.type,
              color: f.colour,
              grams: f.grams,
            })),
          });
        }
      });
    } catch (error) {
      if (put.length > 0 && !(await mayHaveCommitted(fileId))) {
        try {
          await store.deleteBlobs(put.map((blob) => blob.key));
        } catch {
          // The failure that matters is already being thrown, and during an
          // outage this delete fails too. An object left behind has no blob
          // row, so the orphan sweep (orphans.ts) deletes it once it is 24
          // hours old; AC-010's reconciliation would only count it.
        }
      }
      if (error instanceof StoreUnavailable) {
        throw new IngestError("storage_unavailable", STORAGE_UNAVAILABLE_MESSAGE);
      }
      throw error;
    }
    return { modelId, fileId };
  }

  return { ingestFile };
}

export type Ingest = ReturnType<typeof createIngest>;
