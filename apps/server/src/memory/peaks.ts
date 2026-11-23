// What the process's memory gate (gate.ts) holds at its peak, for the app's
// memory budget: test/compose-example.test.ts adds up every term of the
// budget (one gate place, a late-freed STEP buffer, ingest's and the
// re-conversion's .3mf reads, the server's allowance) and checks the sum
// against the 2 GiB mem_limit in examples/docker-compose.yml.
import { LIMITS } from "@platehouse/slicer-contract";
import { MAX_ZIP_DIRECTORY_BYTES, PLATE_MESH_LIMITS } from "@platehouse/threemf";
import { PLATE_MESH_WORKER_LIMITS } from "../plate-mesh/worker-read.js";

const MiB = 1024 * 1024;

/**
 * What a plate read's worker costs before it reads anything: its isolate,
 * Node's runtime and the loaded modules, outside the heap limit. An
 * allowance for those, not a measurement.
 */
export const PLATE_WORKER_BASELINE_MB = 40;

/**
 * The most memory, in MiB, one plate read can hold at once: its worker's
 * heap (PLATE_MESH_WORKER_LIMITS, plate-mesh/worker-read.ts: 512 old plus
 * 64 young), the reader's mesh arrays (every one it allocates is charged to
 * PLATE_MESH_LIMITS.meshBytes, 256 MiB), the zip directory's listing (at
 * most MAX_ZIP_DIRECTORY_BYTES, 8 MiB, its records and the zip reader's
 * objects for them, not the file's size), and the worker's own baseline
 * (PLATE_WORKER_BASELINE_MB). That is 880 MiB. The worker's heap limit
 * covers only the first: the mesh arrays and the records are stored outside
 * the JavaScript heap (the listing's objects are inside it, and counted
 * twice).
 */
export const PLATE_MESH_READ_PEAK_MB =
  (PLATE_MESH_WORKER_LIMITS.maxOldGenerationSizeMb ?? 0) +
  (PLATE_MESH_WORKER_LIMITS.maxYoungGenerationSizeMb ?? 0) +
  PLATE_MESH_LIMITS.meshBytes / MiB +
  MAX_ZIP_DIRECTORY_BYTES / MiB +
  PLATE_WORKER_BASELINE_MB;

/**
 * The most memory, in MiB, a STEP preview's mesh read holds at once: the
 * mesh's chunks and their joined copy while Buffer.concat runs (readAll in
 * derived/derived.ts), twice the largest stored mesh a preview reads
 * (PREVIEW_MESH_MAX_BYTES in derived/preview.ts, the contract's
 * stepOutputBytes), so 512 MiB. The STL is made a chunk at a time and written
 * to disk, never held.
 */
export const STEP_PREVIEW_PEAK_MB = (2 * LIMITS.stepOutputBytes) / MiB;

/**
 * The most memory, in MiB, one place in the memory gate holds: a plate
 * read (PLATE_MESH_READ_PEAK_MB) or a STEP preview's mesh read
 * (STEP_PREVIEW_PEAK_MB), whichever is larger. The gate runs one of them at
 * a time in each place, never both.
 */
export const MEMORY_GATE_PEAK_MB = Math.max(PLATE_MESH_READ_PEAK_MB, STEP_PREVIEW_PEAK_MB);
