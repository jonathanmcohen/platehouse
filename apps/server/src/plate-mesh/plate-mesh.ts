// A .3mf plate's 3D view (issue #358): the GLB of the objects on one plate,
// made from the stored .3mf the first time the plate is opened and kept as
// a blob of the model, so every later open loads the same blob and the
// browser never downloads the whole .3mf for one plate.
//
// Why on first view rather than at ingest:
// - nothing to backfill: every .3mf already in a library gets its plate
//   views the first time someone opens one, with no job reading every file
//   in the bucket after an upgrade;
// - the bucket holds meshes only for plates someone looked at, not a second
//   copy of every plate of every file;
// - an upload is as fast as before, and a mesh the reader cannot make never
//   slows or fails one;
// - it needs no slicer (packages/threemf reads the meshes in this process),
//   so it never waits behind estimates on the slicer queue.
// The cost is the first open of each plate, which reads the .3mf once from
// the store; the page shows the 3D view loading meanwhile.
//
// How one plate is made (get):
// 1. The plate is looked up with its file and model; a plate of a model in
//    the trash, or being purged, is not_found. A plate already pointing at a
//    stored mesh_glb blob of its model answers that blob.
// 2. A plate that already had no 3D view (a PlateMeshError) answers the same
//    problem from memory, without reading the file again: the .3mf of a file
//    never changes. The memory is this process's, holds at most
//    REMEMBERED_PROBLEMS plates and is gone after a restart, so a later
//    version that reads more files tries them again. A too_large that came
//    from the read's timeout, or from a worker that stopped without
//    answering (PlateMeshBusy), may be the machine's fault rather than the
//    file's, so it is remembered for PLATE_MESH_BUSY_RETRY_MS only: long
//    enough that a file that never reads in time does not take a build for
//    a minute on every open, short enough that a plate whose read was slow
//    only because the server was busy is read again once the load is gone.
// 3. Builds go through one queue (limit.ts, review finding #385). Opens of
//    the same plate share one build. A process makes at most
//    PLATE_MESH_BUILDS plates' meshes at once (each run holds a temp copy of
//    the .3mf and the plate's meshes in memory), at most PLATE_MESH_WAITING
//    more wait, and an open past that is refused as busy (503, try again)
//    with nothing started. A waiting build whose browsers have all gone (the
//    route's signal) is dropped before it starts; a build that has started
//    finishes, so its mesh is kept for the next open. A build that waited
//    looks the plate up again first, so one made meanwhile is answered
//    without reading the file.
// 4. The source .3mf is copied from the store to a temp folder of its own
//    under tmpDir (the reader needs random access) and checked against its
//    recorded size, so a short read is never taken for a damaged file.
//    The plate is read in a worker thread (worker-read.ts: a heap limit,
//    a timeout past which the worker is terminated and the plate is
//    too_large, remembered for a short while as step 2 says), never on the main
//    thread, and what the worker sends back passes validatePlateMesh before
//    anything is made from it; encodePlateGlb makes the GLB as chunks
//    that are views of the plate's mesh arrays, which are streamed to the
//    store as they are, so the GLB is never a second copy of the meshes.
// 5. The GLB's object is put first, then one transaction records its blob
//    row and points the plate at it, holding the model row for share (the
//    order a purge takes its locks in) and the plate row for update. If the
//    plate got a mesh meanwhile (another process), or the model went to the
//    trash, the new object is deleted and the stored answer kept. An object
//    left with no row by a crash between the put and the commit is removed
//    by the orphan sweep (ingest/orphans.ts).
// 6. The temp folder is removed whatever happens.
//
// A store that is down or refuses, or a temp folder that cannot be written,
// throws (the route answers 503) and records nothing, so the next open tries
// again. Only the reader's own verdict on the file is remembered for good;
// a too_large that may be the machine's (PlateMeshBusy) for a short while.
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { PlateMeshError, type PlateMeshProblem, ReadUnavailable } from "@platehouse/threemf";
import type { Kysely, Transaction } from "kysely";
import type { AppPlateMeshes, PlateMeshAnswer } from "../app-api/plate-mesh.js";
import { isUuid, uuidv7 } from "../db/ids.js";
import type { DB } from "../db/types.js";
import { createRepos } from "../repos/index.js";
import { blobKey } from "../storage/keys.js";
import { BlobNotFound, type BlobStore, StoreError, StoreUnavailable } from "../storage/s3.js";
import { encodePlateGlb, GLB_CONTENT_TYPE, type PlateGlb } from "./glb.js";
import { createBuildQueue } from "./limit.js";
import { PlateMeshBusy, readPlateMeshInWorker, type WorkerReadOptions } from "./worker-read.js";

export type PlateMeshStore = Pick<BlobStore, "getBlobStream" | "putBlob" | "deleteBlobs">;

/** How many plates' problems one process remembers; the oldest is forgotten first. */
export const REMEMBERED_PROBLEMS = 1000;

/**
 * How long a too_large that may be the machine's (PlateMeshBusy: the read
 * timed out, or its worker stopped without answering) is answered from
 * memory before the plate is read again: 10 minutes.
 */
export const PLATE_MESH_BUSY_RETRY_MS = 10 * 60_000;

/** How many plates' meshes one process makes at once; the rest wait their turn. */
export const PLATE_MESH_BUILDS = 2;

/** How many more may wait; an open past that is answered busy. */
export const PLATE_MESH_WAITING = 8;

export interface PlateMeshDeps {
  db: Kysely<DB>;
  store: PlateMeshStore;
  /** TMP_DIR: the source .3mf is copied into a folder of its own here while it is read. */
  tmpDir: string;
  /** How the plate is read in its worker thread (worker-read.ts); the defaults when left out. */
  worker?: Partial<WorkerReadOptions>;
  /** The time in milliseconds, for PLATE_MESH_BUSY_RETRY_MS; Date.now when left out (tests move it). */
  now?: () => number;
}

interface PlateRow {
  id: string;
  index: number;
  modelId: string;
  sourceBlobId: string;
  meshId: string | null;
}

const NOT_FOUND: PlateMeshAnswer = { status: "not_found" };

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** A file-system error as ReadUnavailable (the route's 503); anything else as it is. */
function fileSystem(error: unknown): unknown {
  const e = error as NodeJS.ErrnoException;
  if (
    error instanceof Error &&
    typeof e.code === "string" &&
    typeof e.syscall === "string" &&
    !(error instanceof StoreUnavailable || error instanceof StoreError)
  ) {
    return new ReadUnavailable(e);
  }
  return error;
}

export function createPlateMeshes(deps: PlateMeshDeps): AppPlateMeshes {
  const { db, store } = deps;
  const repos = createRepos(db);
  const builds = createBuildQueue({ running: PLATE_MESH_BUILDS, waiting: PLATE_MESH_WAITING });
  /** For a caller with no signal of its own: one that never aborts. */
  const staying = new AbortController().signal;
  const now = deps.now ?? Date.now;
  /** Each plate's problem, and when it stops being answered from memory. */
  const problems = new Map<string, { problem: PlateMeshProblem; until: number }>();

  function remember(plateId: string, problem: PlateMeshProblem, until: number): void {
    problems.set(plateId, { problem, until });
    if (problems.size > REMEMBERED_PROBLEMS) {
      const oldest = problems.keys().next().value;
      if (oldest !== undefined) problems.delete(oldest);
    }
  }

  /** The plate of a live model's .3mf, with its stored mesh if it has one. */
  async function lookup(plateId: string): Promise<PlateRow | undefined> {
    return db
      .selectFrom("plates")
      .innerJoin("files", "files.id", "plates.fileId")
      .innerJoin("models", "models.id", "files.modelId")
      .leftJoin("blobs", (join) =>
        join
          .onRef("blobs.id", "=", "plates.meshBlobId")
          .onRef("blobs.modelId", "=", "files.modelId")
          .on("blobs.kind", "=", "mesh_glb")
          .on("blobs.state", "=", "stored"),
      )
      .select([
        "plates.id",
        "plates.index",
        "files.modelId",
        "files.blobId as sourceBlobId",
        "blobs.id as meshId",
      ])
      .where("plates.id", "=", plateId)
      .where("files.kind", "=", "3mf")
      .where("models.trashedAt", "is", null)
      .where("models.purgeStartedAt", "is", null)
      .executeTakeFirst();
  }

  /** Deletes objects, best effort: one left behind has no row, and the orphan sweep removes it. */
  async function deleteQuietly(keys: string[]): Promise<void> {
    try {
      await store.deleteBlobs(keys);
    } catch (error) {
      console.error(
        `plate mesh: ${keys.length} object(s) left for the orphan sweep: ${describe(error)}`,
      );
    }
  }

  /** Copies the stored .3mf to path, checking it is the size recorded. */
  async function copySource(sourceBlobId: string, path: string): Promise<void> {
    const source = await repos.blobs.get(sourceBlobId);
    if (source === undefined || source.state !== "stored" || source.size === null) {
      throw new BlobNotFound("GetObject");
    }
    const body = await store.getBlobStream(source.key);
    try {
      await pipeline(body, createWriteStream(path));
    } catch (error) {
      throw fileSystem(error);
    }
    const { size } = await stat(path).catch((error: unknown) => {
      throw fileSystem(error);
    });
    if (size !== Number(source.size)) throw new StoreError("GetObject", "SizeMismatch");
  }

  /**
   * Records the stored GLB as the plate's mesh, unless the plate got one
   * meanwhile or its model left the library. Returns the plate's mesh blob
   * id, or null for a plate no longer in a live model.
   */
  async function record(
    trx: Transaction<DB>,
    row: PlateRow,
    blob: { id: string; size: number; sha256: Buffer },
  ): Promise<string | null> {
    const live = await trx
      .selectFrom("models")
      .select("id")
      .where("id", "=", row.modelId)
      .where("trashedAt", "is", null)
      .where("purgeStartedAt", "is", null)
      .forShare()
      .executeTakeFirst();
    if (live === undefined) return null;
    const plate = await trx
      .selectFrom("plates")
      .select(["id", "meshBlobId"])
      .where("id", "=", row.id)
      .forUpdate()
      .executeTakeFirst();
    if (plate === undefined) return null;
    if (plate.meshBlobId !== null) {
      const other = await trx
        .selectFrom("blobs")
        .select("id")
        .where("id", "=", plate.meshBlobId)
        .where("state", "=", "stored")
        .executeTakeFirst();
      if (other !== undefined) return other.id;
    }
    const r = createRepos(trx);
    await r.blobs.insertPending({
      id: blob.id,
      modelId: row.modelId,
      kind: "mesh_glb",
      contentType: GLB_CONTENT_TYPE,
      size: blob.size,
    });
    await r.blobs.markStored(blob.id, { size: blob.size, sha256: blob.sha256 });
    await trx.updateTable("plates").set({ meshBlobId: blob.id }).where("id", "=", row.id).execute();
    return blob.id;
  }

  /** Stores the GLB and points the plate at it (steps 5 and 6 of the file comment). */
  async function storeGlb(row: PlateRow, glb: PlateGlb): Promise<PlateMeshAnswer> {
    const id = uuidv7();
    const key = blobKey(row.modelId, id);
    const put = await store.putBlob(Readable.from(glb.chunks), {
      key,
      size: glb.byteLength,
      contentType: GLB_CONTENT_TYPE,
    });
    // Set when the transaction's own work threw, so it rolled back.
    let rolledBack = false;
    let kept: string | null;
    try {
      kept = await db.transaction().execute(async (trx) => {
        try {
          return await record(trx, row, { id, ...put });
        } catch (error) {
          rolledBack = true;
          throw error;
        }
      });
    } catch (error) {
      // Nothing committed when the work itself threw, so the object can go.
      // A failed commit may have committed: the object is kept, and if no
      // row points at it the orphan sweep removes it.
      if (rolledBack) await deleteQuietly([key]);
      throw error;
    }
    if (kept !== id) await deleteQuietly([key]);
    return kept === null ? NOT_FOUND : { status: "ok", blobId: kept };
  }

  async function make(row: PlateRow): Promise<PlateMeshAnswer> {
    const dir = await mkdtemp(join(deps.tmpDir, "plate-mesh-")).catch((error: unknown) => {
      throw fileSystem(error);
    });
    try {
      const path = join(dir, "source.3mf");
      await copySource(row.sourceBlobId, path);
      let glb: PlateGlb;
      try {
        glb = encodePlateGlb(await readPlateMeshInWorker(path, row.index, deps.worker));
      } catch (error) {
        if (error instanceof PlateMeshError) {
          remember(
            row.id,
            error.problem,
            error instanceof PlateMeshBusy ? now() + PLATE_MESH_BUSY_RETRY_MS : Infinity,
          );
          return { status: "no_mesh", problem: error.problem };
        }
        throw error;
      }
      return await storeGlb(row, glb);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  return {
    async get(plateId, signal = staying) {
      if (!isUuid(plateId)) return NOT_FOUND;
      const row = await lookup(plateId);
      if (row === undefined) return NOT_FOUND;
      if (row.meshId !== null) return { status: "ok", blobId: row.meshId };
      const known = problems.get(row.id);
      if (known !== undefined) {
        if (now() < known.until) return { status: "no_mesh", problem: known.problem };
        problems.delete(row.id);
      }
      return builds.run(
        row.id,
        async (): Promise<PlateMeshAnswer> => {
          // The plate may have been made, or its model trashed, while this waited.
          const now = await lookup(row.id);
          if (now === undefined) return NOT_FOUND;
          if (now.meshId !== null) return { status: "ok", blobId: now.meshId };
          return make(now);
        },
        signal,
      );
    },
  };
}
