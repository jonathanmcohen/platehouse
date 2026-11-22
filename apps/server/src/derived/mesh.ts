// Skeleton for issue #316: the STL a STEP file's stored GLB mesh is sent to
// the slicer as. Not implemented yet; the tests that need it are written
// first.
import type { Readable } from "node:stream";

/** The GLB could not be read as the mesh the slicer writes. */
export class MeshUnreadable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeshUnreadable";
  }
}

/** A binary STL made from a GLB: its triangle count, its size, and its bytes. */
export interface StlFromGlb {
  triangles: number;
  size: number;
  open(): Readable;
}

export function stlFromGlb(_glb: Buffer): StlFromGlb {
  throw new Error("stlFromGlb is not implemented yet (issue #316)");
}
