// What the process's memory gate (gate.ts) holds at its peak, for the app's
// memory budget: test/compose-example.test.ts checks one place of the gate
// against the 2 GiB mem_limit in examples/docker-compose.yml.
import { LIMITS } from "@platehouse/slicer-contract";
import { PLATE_MESH_LIMITS } from "@platehouse/threemf";
import { PLATE_MESH_WORKER_LIMITS } from "../plate-mesh/worker-read.js";
import { MAX_UPLOAD_BYTES } from "../uploads/tus.js";

const MiB = 1024 * 1024;

/**
 * The most memory, in MiB, one plate read can hold at once: its worker's
 * heap (PLATE_MESH_WORKER_LIMITS, plate-mesh/worker-read.ts), the reader's
 * mesh arrays (its budget's PLATE_MESH_LIMITS.meshBytes, 256 MiB), and the
 * zip reader's entry records, which are at most the file's central directory
 * and so at most the biggest file Platehouse takes (MAX_UPLOAD_BYTES, 512
 * MiB; the inbox has the same cap). That is 1344 MiB. The worker's heap limit
 * covers only the first: the mesh arrays and entry records are stored
 * outside the JavaScript heap, and Node does not count them against the
 * worker.
 */
export const PLATE_MESH_READ_PEAK_MB =
  (PLATE_MESH_WORKER_LIMITS.maxOldGenerationSizeMb ?? 0) +
  (PLATE_MESH_WORKER_LIMITS.maxYoungGenerationSizeMb ?? 0) +
  PLATE_MESH_LIMITS.meshBytes / MiB +
  MAX_UPLOAD_BYTES / MiB;

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
