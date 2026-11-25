// The one contract a plate mesh meets before anything is made from it (issue
// #358, review findings #392 to #394). The reader runs in a worker thread on
// an untrusted file; the server runs this on the main thread over whatever
// the worker sends back, before the GLB is made or anything is stored. A
// mesh that fails is the file's fault: no_mesh when it is not well formed,
// too_large when it is past a limit.
//
// What passes:
// - an object with a plate number (a whole number from 1), at least one
//   piece and at least one instance, and no more instances than the limit;
// - every piece: x, y, z coordinates in a Float32Array, a whole number of
//   vertices, every one finite; triangle indices in a Uint32Array (so each
//   is a whole number from 0 to 0xFFFFFFFF), a whole number of triangles,
//   at least one, every index below the piece's vertex count; a colour that
//   is #RRGGBB or null;
// - the bytes of the buffers the pieces keep alive, each buffer counted
//   once (a view keeps its whole buffer), within the memory limit;
// - every instance: a piece that exists, and a transform of 12 numbers,
//   every one finite as a float32 (as the GLB and the GPU hold them);
// - triangles: the sum over the instances of their pieces' triangles, which
//   is the count the mesh claims, within the triangle limit.
// What comes back is built from the checked fields alone.
import {
  type MeshInstance,
  type MeshPiece,
  PLATE_MESH_LIMITS,
  type PlateMesh,
  PlateMeshError,
  type PlateMeshLimits,
} from "./plate-mesh.js";

const HEX = /^#[0-9A-Fa-f]{6}$/;

function notWellFormed(why: string): never {
  throw new PlateMeshError("no_mesh", `the plate mesh is not well formed: ${why}`);
}

function over(why: string): never {
  throw new PlateMeshError("too_large", why);
}

/** The limits, each lowered by the caller's when that is a positive finite number below it. */
function lowered(asked: Partial<PlateMeshLimits>): PlateMeshLimits {
  const out = { ...PLATE_MESH_LIMITS };
  for (const key of Object.keys(out) as Array<keyof PlateMeshLimits>) {
    const v = asked[key];
    if (v !== undefined && Number.isFinite(v) && v > 0 && v <= out[key]) out[key] = v;
  }
  return out;
}

/** The mesh, checked against the contract above; throws PlateMeshError when it fails. */
export function validatePlateMesh(
  value: unknown,
  limits: Partial<PlateMeshLimits> = {},
): PlateMesh {
  const max = lowered(limits);
  if (typeof value !== "object" || value === null) notWellFormed("not an object");
  const v = value as Record<string, unknown>;
  const plate = v.plate;
  if (typeof plate !== "number" || !Number.isSafeInteger(plate) || plate < 1) {
    notWellFormed("no plate number");
  }
  if (!Array.isArray(v.pieces) || v.pieces.length === 0) notWellFormed("no pieces");
  if (!Array.isArray(v.instances) || v.instances.length === 0) notWellFormed("no instances");
  if (v.instances.length > max.instances) over("more placed meshes than the limit");

  const pieces: MeshPiece[] = [];
  const buffers = new Set<ArrayBufferLike>();
  let bytes = 0;
  const keep = (buffer: ArrayBufferLike): void => {
    if (buffers.has(buffer)) return;
    buffers.add(buffer);
    bytes += buffer.byteLength;
    if (bytes > max.meshBytes) over("more mesh bytes than the limit");
  };
  for (const p of v.pieces as unknown[]) {
    if (typeof p !== "object" || p === null) notWellFormed("a piece that is not an object");
    const { positions, indices, colour } = p as Record<string, unknown>;
    if (!(positions instanceof Float32Array)) notWellFormed("coordinates not in a Float32Array");
    if (!(indices instanceof Uint32Array)) notWellFormed("indices not in a Uint32Array");
    if (colour !== null && (typeof colour !== "string" || !HEX.test(colour))) {
      notWellFormed("a colour that is not #RRGGBB");
    }
    if (positions.length === 0 || positions.length % 3 !== 0) {
      notWellFormed("coordinates that are not a whole number of vertices");
    }
    if (indices.length === 0 || indices.length % 3 !== 0) {
      notWellFormed("indices that are not a whole number of triangles");
    }
    // Sizes first, so a huge buffer is refused before it is walked.
    keep(positions.buffer);
    keep(indices.buffer);
    for (let i = 0; i < positions.length; i++) {
      if (!Number.isFinite(positions[i])) notWellFormed("a coordinate that is not finite");
    }
    const vertices = positions.length / 3;
    for (let i = 0; i < indices.length; i++) {
      if ((indices[i] as number) >= vertices) notWellFormed("an index past the last vertex");
    }
    pieces.push({ positions, indices, colour: colour as string | null });
  }

  const instances: MeshInstance[] = [];
  let triangles = 0;
  for (const inst of v.instances as unknown[]) {
    if (typeof inst !== "object" || inst === null)
      notWellFormed("an instance that is not an object");
    const { piece, transform } = inst as Record<string, unknown>;
    if (
      typeof piece !== "number" ||
      !Number.isSafeInteger(piece) ||
      piece < 0 ||
      piece >= pieces.length
    ) {
      notWellFormed("an instance naming no piece");
    }
    if (!Array.isArray(transform) || transform.length !== 12) {
      notWellFormed("a transform that is not 12 numbers");
    }
    const t: number[] = [];
    for (const n of transform as unknown[]) {
      if (typeof n !== "number" || !Number.isFinite(Math.fround(n))) {
        notWellFormed("a transform number that is not finite as a float32");
      }
      t.push(n);
    }
    triangles += (pieces[piece] as MeshPiece).indices.length / 3;
    if (triangles > max.triangles) over("more triangles drawn than the limit");
    instances.push({ piece, transform: t });
  }
  if (v.triangles !== triangles)
    notWellFormed("a triangle count that does not match its instances");
  return { plate, pieces, instances, triangles };
}
