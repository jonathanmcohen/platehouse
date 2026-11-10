// OpenSCAD renders and STEP meshes in the app (build plan Task 13; AC-050,
// AC-052, AC-053). A .scad file gets an STL and a PNG preview, a STEP file a
// GLB mesh, all made by the slicer container (scad.ts, step.ts, client.ts)
// and stored as new blobs. Ingest never calls the slicer: once a .scad or
// STEP file's row commits, ingest's afterCommit (afterUpload here) sends a
// job to Task 8's singleton slicer queue, and runJob does the work there.
//
// The jobs are kinds on the slicer queue (DERIVED_KINDS): the queue's one
// worker hands each to its handler from derivedJobHandlers, beside Task 12's
// "slice" handler, so there is never a second worker on that queue.
//
// Retries (Tasks 12 and 13): every job is sent with SLICER_RETRY. When the
// slicer answers 409 busy or the connection is lost, runJob throws and
// pg-boss runs the job again with backoff; there is no retry loop here. On
// the last attempt runJob records slicer_error instead (DERIVED_MESSAGES)
// and the job completes, so no file waits on a render forever. A render or
// conversion error is the program's own answer: it is never retried, the
// source is kept, and the program's message goes into files.derived_message
// exactly as written. It is text, for the page to show as text, never HTML.
//
// Replacing a file (replaceFile) stores the new source as a blob of its own,
// next to the file's current one, and queues a job for it. The staged
// source's row and its job are written in one transaction, so a staged
// source always has a job that will either swap it in or discard it, and a
// crash cannot leave a staged row, or a file pending, with no job. Only when
// that job has stored the new renders does one transaction point the file at
// the new source and renders and delete the old rows; the old objects are
// deleted after that commit. So a failure at any point before it (a store
// outage, a slicer that stays away) leaves the previous version whole: its
// source, its renders and its rows. A replacement whose render fails with
// OpenSCAD's own error is swapped in all the same, with the message, since
// the new source is the file Jon uploaded. An object left with no row by a
// crash between steps is removed by the orphan sweep (ingest/orphans.ts).
//
// derived_status is 'pending' while a job is queued or running, then 'ok' or
// 'failed'; it stays null for kinds with nothing derived (.3mf, .stl). A job
// that finishes while a newer replacement of the file is still queued leaves
// the file 'pending' (newerQueued), so the file never reads as done, or as
// failed, before its last upload has rendered.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { CompiledQuery, type Kysely, sql, type Transaction } from "kysely";
import type { PgBoss } from "pg-boss";
import { isUuid, uuidv7 } from "../db/ids.js";
import type { Blob, DB, FileKind, ModelFile } from "../db/types.js";
import { detectKind } from "../ingest/detect.js";
import {
  CONTENT_TYPES,
  readFirstBytes,
  STORAGE_UNAVAILABLE_MESSAGE,
  type StoredFile,
} from "../ingest/ingest.js";
import { QUEUE, SLICER_RETRY, type SlicerJobHandlers } from "../jobs/queues.js";
import { createRepos } from "../repos/index.js";
import { blobKey } from "../storage/keys.js";
import { type BlobStore, StoreUnavailable } from "../storage/s3.js";
import {
  DERIVED_MESSAGES,
  isRetryable,
  RENDER_TIMEOUT_MS,
  RENDER_UPLOAD_TIMEOUT_MS,
  RenderFailed,
  type RenderOutput,
  SlicerFault,
  type SlicerTarget,
} from "./client.js";
import { renderScadOutputs } from "./scad.js";
import { convertStepOutputs } from "./step.js";

export { DERIVED_MESSAGES } from "./client.js";

/** files.derived_status values. */
export type DerivedStatus = "pending" | "ok" | "failed";

/**
 * Task 13's job kinds on the slicer queue. The queue's one worker hands each
 * job to its kind's handler (slicerJobs in jobs/queues.ts); derivedJobHandlers
 * gives these two, beside Task 12's "slice".
 */
export const DERIVED_KINDS = {
  renderScad: "render-scad",
  convertStep: "convert-step",
} as const;

export type DerivedKind = (typeof DERIVED_KINDS)[keyof typeof DERIVED_KINDS];

/** A slicer queue job that makes a file's derived blobs; its kind picks the handler. */
export interface DerivedJob {
  kind: DerivedKind;
  fileId: string;
  /** The source blob to render: the file's own, or a replacement not yet swapped in. */
  sourceBlobId: string;
}

/** What a job ends with, kept by pg-boss as its output. */
export interface DerivedOutcome {
  status: "ok" | "failed" | "skipped";
  reason?: "render_failed" | "slicer_error" | "stale";
}

export type DerivedErrorCode = "not_found" | "not_derivable" | "wrong_type" | "storage_unavailable";

/** A call refused with a plain message for Jon. */
export class DerivedError extends Error {
  readonly code: DerivedErrorCode;

  constructor(code: DerivedErrorCode, message: string) {
    super(message);
    this.name = "DerivedError";
    this.code = code;
  }
}

const NOT_FOUND_MESSAGE = "That file does not exist or its model is in the trash";
const NOT_DERIVABLE_MESSAGE = "Only .scad and STEP files have renders";
const WRONG_TYPE_MESSAGE: Readonly<Record<"scad" | "step", string>> = {
  scad: "The replacement is not a .scad file; nothing was saved",
  step: "The replacement is not a STEP file; nothing was saved",
};

export type DerivedStore = Pick<BlobStore, "putBlob" | "getBlobStream" | "deleteBlobs">;

export interface DerivedDeps {
  db: Kysely<DB>;
  store: DerivedStore;
  /** SLICER_URL. */
  slicerUrl: string;
  /** Sends the jobs, and finds a file's queued ones; the started pg-boss. */
  queue: Pick<PgBoss, "send" | "findJobs">;
  /** Seconds before the first retry; SLICER_RETRY's when left out. */
  retryDelaySeconds?: number;
  /** A render request's wait for its answer once sent; RENDER_TIMEOUT_MS when left out. */
  requestTimeoutMs?: number;
  /** The time a streamed body may take to send; RENDER_UPLOAD_TIMEOUT_MS when left out. */
  uploadTimeoutMs?: number;
}

/** The kinds that have derived blobs. */
export function hasDerived(kind: FileKind): kind is "scad" | "step" {
  return kind === "scad" || kind === "step";
}

const JOB_KIND_OF: Readonly<Record<"scad" | "step", DerivedKind>> = {
  scad: DERIVED_KINDS.renderScad,
  step: DERIVED_KINDS.convertStep,
};

/** The file columns that point at each kind's derived blobs. */
type DerivedColumn = "renderStlBlobId" | "renderPngBlobId" | "meshBlobId";

const COLUMN_OF: Readonly<Record<RenderOutput["kind"], DerivedColumn>> = {
  render_stl: "renderStlBlobId",
  render_png: "renderPngBlobId",
  mesh_glb: "meshBlobId",
};

const COLUMNS_OF_KIND: Readonly<Record<DerivedKind, readonly DerivedColumn[]>> = {
  [DERIVED_KINDS.renderScad]: ["renderStlBlobId", "renderPngBlobId"],
  [DERIVED_KINDS.convertStep]: ["meshBlobId"],
};

/** The job's view of the file changed under it: a newer source landed, or the file or model went. */
class Superseded extends Error {
  constructor() {
    super("The file changed while its render ran");
    this.name = "Superseded";
  }
}

interface PutOutput {
  id: string;
  key: string;
  kind: RenderOutput["kind"];
  contentType: string;
  size: number;
  sha256: Buffer;
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * pg-boss's db option over a Kysely transaction, so a job is sent, or a
 * file's jobs are read, inside that transaction. Without plugins, so the
 * CamelCasePlugin leaves pg-boss's own SQL and rows alone.
 */
function bossDb(trx: Transaction<DB>) {
  const raw = trx.withoutPlugins();
  return {
    async executeSql(text: string, values: unknown[] = []) {
      const result = await raw.executeQuery(CompiledQuery.raw(text, values));
      return { rows: result.rows as unknown[] };
    },
  };
}

export function createDerived(deps: DerivedDeps) {
  const { db, store } = deps;
  const repos = createRepos(db);
  const target: SlicerTarget = {
    baseUrl: deps.slicerUrl,
    timeoutMs: deps.requestTimeoutMs ?? RENDER_TIMEOUT_MS,
    uploadTimeoutMs: deps.uploadTimeoutMs ?? RENDER_UPLOAD_TIMEOUT_MS,
  };
  const retry = {
    ...SLICER_RETRY,
    ...(deps.retryDelaySeconds === undefined ? {} : { retryDelay: deps.retryDelaySeconds }),
  };

  async function send(job: DerivedJob): Promise<string> {
    const id = await deps.queue.send(QUEUE.slicer, job, retry);
    if (id === null) throw new Error("pg-boss created no job");
    return id;
  }

  async function setStatus(
    fileId: string,
    status: DerivedStatus,
    message: string | null,
  ): Promise<void> {
    await db
      .updateTable("files")
      .set({ derivedStatus: status, derivedMessage: message, updatedAt: sql<Date>`now()` })
      .where("id", "=", fileId)
      .execute();
  }

  /** Deletes objects, best effort: one left behind has no row, and the orphan sweep removes it. */
  async function deleteQuietly(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    try {
      await store.deleteBlobs(keys);
    } catch (error) {
      console.error(
        `derived: ${keys.length} object(s) left for the orphan sweep: ${describe(error)}`,
      );
    }
  }

  /**
   * Removes a staged replacement source: its row, if no file points at it,
   * and then its object.
   */
  async function discardStaged(blobId: string): Promise<void> {
    const { rows } = await sql<{ key: string }>`
      delete from blobs b
       where b.id = ${blobId}
         and b.kind = 'source'
         and not exists (
           select 1 from files f
            where f.blob_id = b.id or f.render_stl_blob_id = b.id
               or f.render_png_blob_id = b.id or f.mesh_blob_id = b.id)
      returning b.key
    `.execute(db);
    await deleteQuietly(rows.map((r) => r.key));
  }

  /** Queues a render or mesh of the file's current source and marks it pending. */
  async function queueFor(fileId: string, kind: "scad" | "step"): Promise<string> {
    const file = isUuid(fileId) ? await repos.files.get(fileId) : undefined;
    if (file === undefined || (await repos.models.get(file.modelId)) === undefined) {
      throw new DerivedError("not_found", NOT_FOUND_MESSAGE);
    }
    if (file.kind !== kind) throw new DerivedError("not_derivable", NOT_DERIVABLE_MESSAGE);
    await setStatus(file.id, "pending", null);
    try {
      return await send({ kind: JOB_KIND_OF[kind], fileId: file.id, sourceBlobId: file.blobId });
    } catch (error) {
      await setStatus(file.id, "failed", DERIVED_MESSAGES.queueFailed).catch(() => {});
      throw error;
    }
  }

  /** Queues the OpenSCAD render (STL and PNG) of a .scad file; returns the job id. */
  function renderScad(fileId: string): Promise<string> {
    return queueFor(fileId, "scad");
  }

  /** Queues the GLB mesh of a STEP file; returns the job id. */
  function convertStep(fileId: string): Promise<string> {
    return queueFor(fileId, "step");
  }

  /**
   * Ingest's afterCommit: queues the render of a .scad or the mesh of a STEP
   * file whose row has committed. It never throws: the upload is stored
   * whatever happens here, and a job that cannot be queued leaves the file
   * failed with DERIVED_MESSAGES.queueFailed.
   */
  async function afterUpload(stored: StoredFile): Promise<void> {
    if (!hasDerived(stored.kind)) return;
    try {
      await queueFor(stored.fileId, stored.kind);
    } catch (error) {
      console.error(`derived: could not queue file ${stored.fileId}: ${describe(error)}`);
    }
  }

  /**
   * Replaces a .scad or STEP file's source with the file at tmpPath, which
   * must be of the same kind, and queues its render. The file keeps its
   * previous source and renders until the new renders are stored (runJob).
   * The file at tmpPath is left for its owner to delete.
   */
  async function replaceFile(
    fileId: string,
    tmpPath: string,
  ): Promise<{ fileId: string; sourceBlobId: string }> {
    const file = isUuid(fileId) ? await repos.files.get(fileId) : undefined;
    if (file === undefined || (await repos.models.get(file.modelId)) === undefined) {
      throw new DerivedError("not_found", NOT_FOUND_MESSAGE);
    }
    const kind = file.kind;
    if (!hasDerived(kind)) throw new DerivedError("not_derivable", NOT_DERIVABLE_MESSAGE);
    const { size } = await stat(tmpPath);
    if (detectKind(file.originalName, await readFirstBytes(tmpPath), size) !== kind) {
      throw new DerivedError("wrong_type", WRONG_TYPE_MESSAGE[kind]);
    }

    const blobId = uuidv7();
    const key = blobKey(file.modelId, blobId);
    const contentType = CONTENT_TYPES[kind];
    let stored: { sha256: Buffer; size: number };
    try {
      stored = await store.putBlob(createReadStream(tmpPath), { key, size, contentType });
    } catch (error) {
      if (error instanceof StoreUnavailable) {
        throw new DerivedError("storage_unavailable", STORAGE_UNAVAILABLE_MESSAGE);
      }
      throw error;
    }

    // The staged source's row, the file marked pending, and its job, in one
    // transaction.
    const stage = async (trx: Transaction<DB>): Promise<void> => {
      const live = await trx
        .selectFrom("models")
        .select("id")
        .where("id", "=", file.modelId)
        .where("trashedAt", "is", null)
        .where("purgeStartedAt", "is", null)
        .forShare()
        .executeTakeFirst();
      if (live === undefined) throw new DerivedError("not_found", NOT_FOUND_MESSAGE);
      const r = createRepos(trx);
      await r.blobs.insertPending({
        id: blobId,
        modelId: file.modelId,
        kind: "source",
        contentType,
        size,
      });
      await r.blobs.markStored(blobId, stored);
      await trx
        .updateTable("files")
        .set({ derivedStatus: "pending", derivedMessage: null, updatedAt: sql<Date>`now()` })
        .where("id", "=", file.id)
        .execute();
      const job: DerivedJob = { kind: JOB_KIND_OF[kind], fileId: file.id, sourceBlobId: blobId };
      const id = await deps.queue.send(QUEUE.slicer, job, { ...retry, db: bossDb(trx) });
      if (id === null) throw new Error("pg-boss created no job");
    };

    // Set when the transaction's own work threw, so it rolled back and
    // nothing in it committed.
    let rolledBack = false;
    try {
      await db.transaction().execute(async (trx) => {
        try {
          await stage(trx);
        } catch (error) {
          rolledBack = true;
          throw error;
        }
      });
    } catch (error) {
      // Refused or failed inside the transaction, so nothing committed and
      // the object can go. A failed commit may have committed: the object is
      // kept, and if no row points at it the orphan sweep removes it.
      if (rolledBack) await deleteQuietly([key]);
      throw error;
    }
    return { fileId: file.id, sourceBlobId: blobId };
  }

  /** The source's whole bytes; a .scad is at most 1 MiB by the time this runs. */
  async function readAll(key: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of await store.getBlobStream(key)) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  /**
   * The file row, locked, once the job is known to still apply to it. The
   * model row is locked first, the order a purge takes them in, so the two
   * never deadlock; a model whose purge has begun takes no new rows.
   */
  async function lockFor(
    trx: Transaction<DB>,
    file: ModelFile,
    source: Blob,
    replacing: boolean,
  ): Promise<ModelFile> {
    const open = await trx
      .selectFrom("models")
      .select("id")
      .where("id", "=", file.modelId)
      .where("purgeStartedAt", "is", null)
      .forShare()
      .executeTakeFirst();
    if (open === undefined) throw new Superseded();
    const row = await trx
      .selectFrom("files")
      .selectAll()
      .where("id", "=", file.id)
      .forUpdate()
      .executeTakeFirst();
    if (row === undefined) throw new Superseded();
    // The source the job started from is still the file's, or, for a
    // replacement, the file still has the source it had then and the staged
    // one is still there.
    if (row.blobId !== (replacing ? file.blobId : source.id)) throw new Superseded();
    if (replacing) {
      const staged = await trx
        .selectFrom("blobs")
        .select("id")
        .where("id", "=", source.id)
        .forUpdate()
        .executeTakeFirst();
      if (staged === undefined) throw new Superseded();
    }
    return row;
  }

  /**
   * Whether a job queued for the file will render a source newer than
   * sourceId: a replacement staged after it. Read in trx once the file row
   * is locked, so a replaceFile that commits later sets 'pending' itself
   * after this job's write, and one that committed earlier is seen here
   * (replaceFile writes the staged row and its job in one transaction). The
   * slicer queue runs one job at a time, so any other job for the file is
   * queued, not running.
   */
  async function newerQueued(
    trx: Transaction<DB>,
    fileId: string,
    sourceId: string,
  ): Promise<boolean> {
    const queued = await deps.queue.findJobs<DerivedJob>(QUEUE.slicer, {
      data: { fileId },
      queued: true,
      db: bossDb(trx),
    });
    const others = queued
      .map((j) => j.data?.sourceBlobId)
      .filter((id): id is string => typeof id === "string" && id !== sourceId && isUuid(id));
    if (others.length === 0) return false;
    const { rows } = await sql<{ newer: boolean }>`
      select exists (
        select 1 from blobs s, blobs mine
         where mine.id = ${sourceId}
           and s.id in (${sql.join(others)})
           and s.kind = 'source' and s.state = 'stored'
           and s.created_at > mine.created_at
      ) as newer
    `.execute(trx);
    return rows[0]?.newer ?? false;
  }

  /** outcome, or 'pending' with no message while a newer replacement is queued. */
  async function settledOutcome(
    trx: Transaction<DB>,
    fileId: string,
    sourceId: string,
    outcome: { status: DerivedStatus; message: string | null },
  ): Promise<{ status: DerivedStatus; message: string | null }> {
    return (await newerQueued(trx, fileId, sourceId))
      ? { status: "pending", message: null }
      : outcome;
  }

  /**
   * Points the file at a replacement source (when replacing) and at new
   * derived blobs for the job kind (none on a render error), deletes the rows of
   * the blobs that replaces, and returns their keys for deleting after the
   * commit.
   */
  async function swapIn(
    trx: Transaction<DB>,
    row: ModelFile,
    jobKind: DerivedKind,
    source: Blob,
    replacing: boolean,
    outputs: readonly PutOutput[],
    outcome: { status: DerivedStatus; message: string | null },
  ): Promise<string[]> {
    const r = createRepos(trx);
    for (const out of outputs) {
      await r.blobs.insertPending({
        id: out.id,
        modelId: row.modelId,
        kind: out.kind,
        contentType: out.contentType,
        size: out.size,
      });
      await r.blobs.markStored(out.id, { size: out.size, sha256: out.sha256 });
    }
    const columns = COLUMNS_OF_KIND[jobKind];
    const old = columns.map((c) => row[c]).filter((id): id is string => id !== null);
    if (replacing) old.push(row.blobId);
    const derived: Partial<Record<DerivedColumn, string | null>> = {};
    for (const c of columns) derived[c] = null;
    for (const out of outputs) derived[COLUMN_OF[out.kind]] = out.id;

    await trx
      .updateTable("files")
      .set({
        ...derived,
        ...(replacing
          ? { blobId: source.id, size: source.size ?? 0, sha256: source.sha256 ?? Buffer.alloc(0) }
          : {}),
        derivedStatus: outcome.status,
        derivedMessage: outcome.message,
        updatedAt: sql<Date>`now()`,
      })
      .where("id", "=", row.id)
      .execute();
    if (old.length === 0) return [];
    const deleted = await trx.deleteFrom("blobs").where("id", "in", old).returning("key").execute();
    return deleted.map((d) => d.key);
  }

  /** Stores new derived blobs and swaps them in; the old ones go after the commit. */
  async function commitOutputs(
    jobKind: DerivedKind,
    file: ModelFile,
    source: Blob,
    replacing: boolean,
    outputs: readonly RenderOutput[],
  ): Promise<void> {
    const put: PutOutput[] = [];
    try {
      for (const out of outputs) {
        const id = uuidv7();
        const key = blobKey(file.modelId, id);
        const stored = await store.putBlob(Readable.from([out.bytes]), {
          key,
          size: out.bytes.length,
          contentType: out.contentType,
        });
        put.push({ id, key, kind: out.kind, contentType: out.contentType, ...stored });
      }
    } catch (error) {
      // No row points at these yet.
      await deleteQuietly(put.map((p) => p.key));
      throw error;
    }

    let oldKeys: string[] = [];
    try {
      await db.transaction().execute(async (trx) => {
        const row = await lockFor(trx, file, source, replacing);
        const outcome = await settledOutcome(trx, file.id, source.id, {
          status: "ok",
          message: null,
        });
        oldKeys = await swapIn(trx, row, jobKind, source, replacing, put, outcome);
      });
    } catch (error) {
      // Superseded is decided inside the transaction, before any write, so
      // nothing committed. Any other error may have committed: the objects
      // are kept, and the orphan sweep removes any that no row points at.
      if (error instanceof Superseded) await deleteQuietly(put.map((p) => p.key));
      throw error;
    }
    await deleteQuietly(oldKeys);
  }

  /** Records a render or conversion error, swapping a replacement in. */
  async function commitRenderError(
    jobKind: DerivedKind,
    file: ModelFile,
    source: Blob,
    replacing: boolean,
    message: string,
  ): Promise<void> {
    let oldKeys: string[] = [];
    await db.transaction().execute(async (trx) => {
      const row = await lockFor(trx, file, source, replacing);
      const outcome = await settledOutcome(trx, file.id, source.id, { status: "failed", message });
      if (replacing) {
        oldKeys = await swapIn(trx, row, jobKind, source, true, [], outcome);
      } else {
        await trx
          .updateTable("files")
          .set({
            derivedStatus: outcome.status,
            derivedMessage: outcome.message,
            updatedAt: sql<Date>`now()`,
          })
          .where("id", "=", row.id)
          .execute();
      }
    });
    await deleteQuietly(oldKeys);
  }

  /**
   * Records slicer_error, while the file still has the source the job started
   * from; a replacement is dropped and the previous version kept.
   */
  async function commitSlicerError(
    file: ModelFile,
    source: Blob,
    replacing: boolean,
  ): Promise<void> {
    const message = replacing ? DERIVED_MESSAGES.replaceFailed : DERIVED_MESSAGES.slicerError;
    await db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom("files")
        .select("id")
        .where("id", "=", file.id)
        .where("blobId", "=", file.blobId)
        .forUpdate()
        .executeTakeFirst();
      if (row === undefined) return;
      const outcome = await settledOutcome(trx, file.id, source.id, { status: "failed", message });
      await trx
        .updateTable("files")
        .set({
          derivedStatus: outcome.status,
          derivedMessage: outcome.message,
          updatedAt: sql<Date>`now()`,
        })
        .where("id", "=", row.id)
        .execute();
    });
    if (replacing) await discardStaged(source.id);
  }

  /** Whether staged was stored after current (compared in Postgres, to the microsecond). */
  async function newerThan(staged: string, current: string): Promise<boolean> {
    const { rows } = await sql<{ newer: boolean | null }>`
      select (select created_at from blobs where id = ${staged})
           > (select created_at from blobs where id = ${current}) as newer
    `.execute(db);
    // With the current source's row gone, any staged source is newer.
    return rows[0]?.newer ?? true;
  }

  /**
   * Runs one render or mesh job (the slicer queue's worker calls this).
   * Throws only to have pg-boss retry: on a 409 busy, a lost connection or a
   * store outage before the last attempt, or an unexpected error.
   */
  async function runJob(
    job: DerivedJob,
    attempt: { retryCount: number; retryLimit: number },
  ): Promise<DerivedOutcome> {
    const stale: DerivedOutcome = { status: "skipped", reason: "stale" };
    const kind = job.kind === DERIVED_KINDS.renderScad ? "scad" : "step";
    const file = isUuid(job.fileId) ? await repos.files.get(job.fileId) : undefined;
    const source = isUuid(job.sourceBlobId) ? await repos.blobs.get(job.sourceBlobId) : undefined;
    if (file === undefined || file.kind !== kind) return stale;
    if (
      source === undefined ||
      source.kind !== "source" ||
      source.state !== "stored" ||
      source.modelId !== file.modelId
    ) {
      return stale;
    }
    const replacing = file.blobId !== source.id;
    // A replacement older than the file's current source was overtaken by a
    // newer one that has landed already.
    if (replacing && !(await newerThan(source.id, file.blobId))) {
      await discardStaged(source.id);
      return stale;
    }

    try {
      const size = source.size ?? 0;
      const outputs =
        kind === "scad"
          ? await renderScadOutputs(target, size, () => readAll(source.key))
          : await convertStepOutputs(target, () => store.getBlobStream(source.key), size);
      await commitOutputs(job.kind, file, source, replacing, outputs);
      return { status: "ok" };
    } catch (error) {
      if (error instanceof Superseded) {
        if (replacing) await discardStaged(source.id);
        return stale;
      }
      if (error instanceof RenderFailed) {
        try {
          await commitRenderError(job.kind, file, source, replacing, error.message);
        } catch (recordError) {
          if (recordError instanceof Superseded) return stale;
          throw recordError;
        }
        return { status: "failed", reason: "render_failed" };
      }
      const known = isRetryable(error) || error instanceof StoreUnavailable;
      const last = attempt.retryCount >= attempt.retryLimit;
      if (!last && !(error instanceof SlicerFault)) throw error;
      // The last attempt, or an answer a retry will not change: record
      // slicer_error so the file is never left waiting.
      await commitSlicerError(file, source, replacing);
      if (known || error instanceof SlicerFault) {
        console.error(`derived: file ${file.id} ended with slicer_error: ${describe(error)}`);
        return { status: "failed", reason: "slicer_error" };
      }
      throw error;
    }
  }

  return { renderScad, convertStep, replaceFile, afterUpload, runJob };
}

export type Derived = ReturnType<typeof createDerived>;

/**
 * Task 13's entries for the slicer queue's handler map (QueueDeps.slicerJobs):
 * the render and mesh kinds, each running runJob with the job's retry count
 * and limit, so the last attempt records slicer_error. Spread beside Task
 * 12's "slice" entry: { ...derivedJobHandlers(derived), slice: ... }.
 */
export function derivedJobHandlers(derived: Pick<Derived, "runJob">): SlicerJobHandlers {
  const handle: SlicerJobHandlers[string] = (job) =>
    derived.runJob(job.data as unknown as DerivedJob, {
      retryCount: job.retryCount,
      retryLimit: job.retryLimit,
    });
  return { [DERIVED_KINDS.renderScad]: handle, [DERIVED_KINDS.convertStep]: handle };
}
