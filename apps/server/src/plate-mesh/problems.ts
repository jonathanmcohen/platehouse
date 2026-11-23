// What the plate mesh service remembers about plates it could not make a
// mesh for, so a plate that cannot be made does not cost a read on every open.
//
// - The reader's own verdict on a plate (a PlateMeshError that is not a
//   PlateMeshBusy) is kept for good, for that plate: the .3mf of a file never
//   changes.
// - A PlateMeshBusy (the read timed out, or its worker stopped without
//   answering) may be the machine's fault rather than the file's, so the
//   first one is kept for PLATE_MESH_BUSY_RETRY_MS only. It is kept against
//   the file's blob, not the plate: a file whose plates all read slowly then
//   costs one timeout, not one per plate. A second one for the same blob is
//   kept for good, for every plate of it.
//
// Strikes are not reset by a later success, and forgetting an entry (it is
// the oldest past the maximum) resets that file's count.
//
// The memory is one process's and holds at most REMEMBERED_PROBLEMS entries
// (a plate or a file each); the oldest is forgotten first.
import type { PlateMeshError, PlateMeshProblem } from "@platehouse/threemf";
import { PlateMeshBusy } from "./worker-read.js";

/** How many entries one process remembers; the oldest is forgotten first. */
export const REMEMBERED_PROBLEMS = 1000;

/**
 * How long a first PlateMeshBusy for a file is answered from memory before
 * its plates are read again: 10 minutes.
 */
export const PLATE_MESH_BUSY_RETRY_MS = 10 * 60_000;

export interface ProblemMemory {
  remember(plateId: string, blobId: string, error: PlateMeshError): void;
  /** The problem to answer for the plate of this file without reading it, or undefined to read it. */
  lookup(plateId: string, blobId: string): PlateMeshProblem | undefined;
}

type Entry =
  | { kind: "plate"; problem: PlateMeshProblem }
  | { kind: "busy"; until: number; strikes: number };

export function createProblemMemory(opts: {
  now: () => number;
  max?: number | undefined;
}): ProblemMemory {
  const max = opts.max ?? REMEMBERED_PROBLEMS;
  // Keys are "plate:<id>" and "blob:<id>"; insertion order is age.
  const entries = new Map<string, Entry>();

  function put(key: string, entry: Entry): void {
    entries.delete(key);
    entries.set(key, entry);
    while (entries.size > max) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }

  return {
    remember(plateId, blobId, error) {
      if (error instanceof PlateMeshBusy) {
        const before = entries.get(`blob:${blobId}`);
        // A timeout inside the window of an earlier one (a build that was
        // already running or queued) is the same incident, not a second strike.
        if (before?.kind === "busy" && opts.now() < before.until) return;
        const strikes = before?.kind === "busy" ? before.strikes + 1 : 1;
        put(`blob:${blobId}`, {
          kind: "busy",
          until: opts.now() + PLATE_MESH_BUSY_RETRY_MS,
          strikes,
        });
        return;
      }
      put(`plate:${plateId}`, { kind: "plate", problem: error.problem });
    },
    lookup(plateId, blobId) {
      const plate = entries.get(`plate:${plateId}`);
      if (plate?.kind === "plate") return plate.problem;
      const busy = entries.get(`blob:${blobId}`);
      if (busy?.kind !== "busy") return undefined;
      if (busy.strikes >= 2 || opts.now() < busy.until) return "too_large";
      return undefined;
    },
  };
}
