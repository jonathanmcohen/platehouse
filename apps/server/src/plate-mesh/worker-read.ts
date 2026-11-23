// Reads one plate's mesh in a worker thread, never on the server's main
// thread (issue #358, review finding #392 and the class behind it: each
// review round found another way a crafted .3mf made the reader do expensive
// or malformed work on the thread that answers every request).
//
// - The worker (worker.ts) runs readPlateMesh with its own budget, under a
//   heap limit (PLATE_MESH_WORKER_LIMITS) and a wall-clock timeout
//   (PLATE_MESH_TIMEOUT_MS). Past the timeout the main thread terminates it
//   and the plate is too_large: a file that cannot be read in that time is
//   treated like one too big to show. A worker that dies without answering
//   is too_large the same way. Both come back as PlateMeshBusy, a too_large
//   that measures how busy the machine was as much as the file (a large
//   plate read while the slicer runs can pass the timeout and read in time
//   later), so the server remembers it only for a short while
//   (plate-mesh.ts, PLATE_MESH_BUSY_RETRY_MS). A worker that runs out of
//   heap is a plain too_large: its heap limit is its own, whatever else the
//   machine is doing. A worker's failure ends only that worker. The heap
//   limit does not cap the worker's whole memory, though: its mesh arrays
//   and the zip reader's entry records are outside the heap. So the whole
//   of one read is bounded as PLATE_MESH_READ_PEAK_MB (memory/peaks.ts), and
//   the reads that run at once (PLATE_MESH_BUILDS) are sized against the
//   container's memory limit, past which the kernel would end the whole
//   server, not one worker.
// - Whatever the worker sends back passes validatePlateMesh (packages/threemf)
//   here, on the main thread, before it is used: a mesh that fails is the
//   file's fault (no_mesh or too_large) and nothing is made from it.
// - The reader's own verdict on the file comes back as that PlateMeshError;
//   a file that cannot be read right now as ReadUnavailable (not a verdict);
//   a bug in the reader, or a worker that cannot start (its code missing,
//   say), as a plain Error, which is the server's fault and is not
//   remembered against the file.
//
// The worker file is worker.js beside this module in the built server, and
// worker.ts when the server runs from its TypeScript source (e2e, tests);
// the worker then needs the same Node flags the source run uses, which it
// inherits from the process unless execArgv is given.
import { type ResourceLimits, Worker } from "node:worker_threads";
import {
  type PlateMesh,
  PlateMeshError,
  type PlateMeshProblem,
  ReadUnavailable,
  validatePlateMesh,
} from "@platehouse/threemf";

/**
 * A too_large that may not be the file's fault: the read passed its timeout,
 * or the worker stopped without answering. Either can come from a machine
 * busy with other work, so it is not a lasting verdict on the file.
 */
export class PlateMeshBusy extends PlateMeshError {
  constructor(detail: string) {
    super("too_large", detail);
    this.name = "PlateMeshBusy";
  }
}

/** How long a plate's read may take before its worker is terminated: 60 seconds. */
export const PLATE_MESH_TIMEOUT_MS = 60_000;

/**
 * The worker's JavaScript heap: room for the reader's parsed config, its
 * component lists and its entry index, and no more. These limits cap the
 * V8 heap only. The reader's mesh arrays (ArrayBuffers) and the zip
 * reader's entry records (Buffers) are stored outside it, and Node does
 * not count them against the worker, so they are bounded elsewhere: see
 * PLATE_MESH_READ_PEAK_MB in memory/peaks.ts.
 */
export const PLATE_MESH_WORKER_LIMITS: Readonly<ResourceLimits> = Object.freeze({
  maxOldGenerationSizeMb: 512,
  maxYoungGenerationSizeMb: 64,
  stackSizeMb: 4,
});

export interface WorkerReadOptions {
  timeoutMs: number;
  resourceLimits: ResourceLimits;
  /** Node flags for the worker; the process's own when left out. */
  execArgv?: string[];
  /** The worker file; worker.js or worker.ts beside this module when left out. */
  url?: URL;
  /** Handed the worker as it starts (the tests watch it end). */
  onSpawn?: (worker: Worker) => void;
}

const WORKER_URL = new URL(
  import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js",
  import.meta.url,
);

const PROBLEMS: ReadonlySet<string> = new Set<PlateMeshProblem>([
  "no_plate",
  "no_objects",
  "no_mesh",
  "too_large",
  "damaged",
]);

/** The worker's message as a mesh, or the error it stands for. */
function answerOf(message: unknown): PlateMesh {
  const m = (typeof message === "object" && message !== null ? message : {}) as Record<
    string,
    unknown
  >;
  const text = typeof m.message === "string" ? m.message : "";
  switch (m.type) {
    case "mesh":
      return validatePlateMesh(m.mesh);
    case "verdict":
      throw new PlateMeshError(
        typeof m.problem === "string" && PROBLEMS.has(m.problem)
          ? (m.problem as PlateMeshProblem)
          : "damaged",
        text,
      );
    case "unavailable":
      throw new ReadUnavailable(
        Object.assign(new Error(text), {
          code: typeof m.code === "string" ? m.code : "EIO",
          syscall: "read",
        }),
      );
    case "error":
      throw new Error(`the plate mesh reader failed: ${text}`);
    default:
      throw new PlateMeshError("no_mesh", "the plate mesh reader sent an answer that is not one");
  }
}

/**
 * The plate's mesh, read in a worker thread and validated here; throws
 * PlateMeshError for a verdict on the file (too_large past the heap limit),
 * PlateMeshBusy, a too_large that may be the machine's, past the timeout or
 * when the worker dies without answering, ReadUnavailable when the file
 * cannot be read right now, and Error for anything that is the server's
 * fault.
 */
export function readPlateMeshInWorker(
  path: string,
  plate: number,
  opts: Partial<WorkerReadOptions> = {},
): Promise<PlateMesh> {
  const timeoutMs = opts.timeoutMs ?? PLATE_MESH_TIMEOUT_MS;
  return new Promise<PlateMesh>((resolve, reject) => {
    const worker = new Worker(opts.url ?? WORKER_URL, {
      workerData: { path, plate },
      resourceLimits: { ...PLATE_MESH_WORKER_LIMITS, ...opts.resourceLimits },
      ...(opts.execArgv === undefined ? {} : { execArgv: opts.execArgv }),
    });
    opts.onSpawn?.(worker);
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle();
      // A worker that answered has nothing left to do; one that did not is stopped.
      void worker.terminate();
    };
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(new PlateMeshBusy(`reading the plate took longer than ${timeoutMs} ms`)),
        ),
      timeoutMs,
    );
    worker.once("message", (message: unknown) =>
      finish(() => {
        try {
          resolve(answerOf(message));
        } catch (error) {
          reject(error);
        }
      }),
    );
    worker.once("error", (error: Error & { code?: string }) =>
      finish(() =>
        reject(
          error.code === "ERR_WORKER_OUT_OF_MEMORY"
            ? new PlateMeshError("too_large", "reading the plate ran out of memory")
            : new Error(`the plate mesh worker failed: ${error.message}`, { cause: error }),
        ),
      ),
    );
    worker.once("exit", (code: number) =>
      finish(() =>
        reject(new PlateMeshBusy(`the plate mesh reader stopped (exit ${code}) without an answer`)),
      ),
    );
  });
}
