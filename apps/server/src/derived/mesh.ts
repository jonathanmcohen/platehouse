// A STEP file's preview picture is rendered from the GLB mesh it was already
// converted to for the 3D viewer (issue #316), so the STEP file is never
// converted twice. OpenSCAD cannot import a GLB, so the mesh is sent to the
// slicer's /v1/stl/png as a binary STL, made here.
//
// stlFromGlb reads the GLB the slicer writes (apps/slicer/src/step.ts,
// meshesToGlb): glTF 2.0 binary, one buffer in the BIN chunk, one mesh per
// shape, float32 VEC3 positions, optional uint32 indices (uint16 and uint8
// are read too), triangle primitives, and nodes that carry no transform.
// Anything outside that is refused with MeshUnreadable rather than guessed
// at: a node transform, a strided or out-of-range accessor, an index past the
// last vertex, a primitive that is not triangles. Every bound is checked
// before a read, so a damaged object in the bucket fails cleanly.
//
// The triangle count, and so the STL's size, is known before any bytes are
// made, so the caller can refuse an STL over the contract's limit without
// building it. The bytes are made as they are read (open()), about 20,000
// triangles (1 MB) at a time, so a large mesh is never held twice in memory.
// Facet normals are written as zero; OpenSCAD works them out from the
// winding.
import { Readable } from "node:stream";

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
  /** 84 bytes of header and count, then 50 bytes per triangle. */
  size: number;
  /** The STL's bytes, made as they are read. */
  open(): Readable;
}

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const FLOAT = 5126;
const INDEX_SIZE: Readonly<Record<number, number>> = { 5121: 1, 5123: 2, 5125: 4 };
const TRIANGLES = 4;
const HEADER = "platehouse: a STEP file's mesh, for its preview picture";
const TRIANGLES_PER_CHUNK = 20_000;

interface Accessor {
  bufferView?: number;
  byteOffset?: number;
  componentType?: number;
  count?: number;
  type?: string;
}

interface BufferView {
  buffer?: number;
  byteOffset?: number;
  byteLength?: number;
  byteStride?: number;
}

interface Gltf {
  meshes?: Array<{ primitives?: Array<Record<string, unknown>> }>;
  nodes?: Array<Record<string, unknown>>;
  accessors?: Accessor[];
  bufferViews?: BufferView[];
}

/** One primitive, read and checked: where its positions and indices are. */
interface Part {
  positions: number;
  vertices: number;
  indices: { at: number; size: number; count: number } | null;
  triangles: number;
}

const isCount = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;

/** The bytes an accessor covers, checked against its buffer view and the BIN chunk. */
function locate(
  gltf: Gltf,
  index: unknown,
  elementSize: number,
  binLength: number,
): { at: number; count: number } {
  if (!isCount(index)) throw new MeshUnreadable("a primitive names no accessor");
  const accessor = gltf.accessors?.[index];
  if (accessor === undefined) throw new MeshUnreadable(`accessor ${index} does not exist`);
  const count = accessor.count;
  if (!isCount(count)) throw new MeshUnreadable(`accessor ${index} has no count`);
  if (!isCount(accessor.bufferView)) {
    throw new MeshUnreadable(`accessor ${index} has no buffer view`);
  }
  const view = gltf.bufferViews?.[accessor.bufferView];
  if (view === undefined) throw new MeshUnreadable(`accessor ${index} names a missing view`);
  if ((view.buffer ?? 0) !== 0) throw new MeshUnreadable("a view is outside the GLB's buffer");
  if (view.byteStride !== undefined && view.byteStride !== elementSize) {
    throw new MeshUnreadable(`accessor ${index} is interleaved, which the slicer never writes`);
  }
  const viewAt = view.byteOffset ?? 0;
  const viewLength = view.byteLength;
  const offset = accessor.byteOffset ?? 0;
  if (!isCount(viewAt) || !isCount(viewLength) || !isCount(offset)) {
    throw new MeshUnreadable(`accessor ${index} has a bad offset or length`);
  }
  const length = count * elementSize;
  if (offset + length > viewLength || viewAt + viewLength > binLength) {
    throw new MeshUnreadable(`accessor ${index} runs past the end of the buffer`);
  }
  return { at: viewAt + offset, count };
}

function readGltf(glb: Buffer): { gltf: Gltf; bin: Buffer } {
  if (glb.length < 20 || glb.readUInt32LE(0) !== GLB_MAGIC) {
    throw new MeshUnreadable("the mesh is not a GLB");
  }
  if (glb.readUInt32LE(4) !== 2) throw new MeshUnreadable("the GLB is not glTF 2.0");
  if (glb.readUInt32LE(8) !== glb.length) {
    throw new MeshUnreadable("the GLB's length does not match its header");
  }
  const jsonLength = glb.readUInt32LE(12);
  if (glb.readUInt32LE(16) !== CHUNK_JSON || 20 + jsonLength > glb.length) {
    throw new MeshUnreadable("the GLB has no JSON chunk");
  }
  let gltf: Gltf;
  try {
    gltf = JSON.parse(glb.subarray(20, 20 + jsonLength).toString("utf8")) as Gltf;
  } catch {
    throw new MeshUnreadable("the GLB's JSON chunk is not JSON");
  }
  if (gltf === null || typeof gltf !== "object") {
    throw new MeshUnreadable("the GLB's JSON chunk is not an object");
  }
  const binAt = 20 + jsonLength;
  if (binAt + 8 > glb.length || glb.readUInt32LE(binAt + 4) !== CHUNK_BIN) {
    throw new MeshUnreadable("the GLB has no BIN chunk");
  }
  const binLength = glb.readUInt32LE(binAt);
  if (binAt + 8 + binLength > glb.length)
    throw new MeshUnreadable("the GLB's BIN chunk is cut short");
  return { gltf, bin: glb.subarray(binAt + 8, binAt + 8 + binLength) };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A list the GLB's JSON may leave out; anything else that is not a list is refused. */
function listOf(value: unknown, what: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new MeshUnreadable(`the GLB's ${what} are not a list`);
  return value;
}

function readParts(gltf: Gltf, bin: Buffer): Part[] {
  for (const node of listOf(gltf.nodes, "nodes")) {
    if (!isRecord(node)) throw new MeshUnreadable("a node is not an object");
    for (const key of ["matrix", "translation", "rotation", "scale", "children"]) {
      if (key in node) {
        throw new MeshUnreadable(`a node has a ${key}, which the slicer never writes`);
      }
    }
  }
  const parts: Part[] = [];
  for (const mesh of listOf(gltf.meshes, "meshes")) {
    if (!isRecord(mesh)) throw new MeshUnreadable("a mesh is not an object");
    for (const primitive of listOf(mesh.primitives, "primitives")) {
      if (!isRecord(primitive)) throw new MeshUnreadable("a primitive is not an object");
      const mode = primitive.mode ?? TRIANGLES;
      if (mode !== TRIANGLES) throw new MeshUnreadable(`a primitive is drawn as mode ${mode}`);
      const attributes = primitive.attributes as Record<string, unknown> | undefined;
      const posIndex = attributes?.POSITION;
      const posAccessor = isCount(posIndex) ? gltf.accessors?.[posIndex] : undefined;
      if (posAccessor?.componentType !== FLOAT || posAccessor.type !== "VEC3") {
        throw new MeshUnreadable("a primitive's positions are not float VEC3");
      }
      const pos = locate(gltf, posIndex, 12, bin.length);
      let indices: Part["indices"] = null;
      let corners = pos.count;
      if (primitive.indices !== undefined) {
        const idxAccessor = isCount(primitive.indices)
          ? gltf.accessors?.[primitive.indices]
          : undefined;
        const size = INDEX_SIZE[idxAccessor?.componentType ?? -1];
        if (size === undefined || idxAccessor?.type !== "SCALAR") {
          throw new MeshUnreadable("a primitive's indices are not unsigned integers");
        }
        const idx = locate(gltf, primitive.indices, size, bin.length);
        for (let i = 0; i < idx.count; i++) {
          const at = idx.at + i * size;
          const v =
            size === 4
              ? bin.readUInt32LE(at)
              : size === 2
                ? bin.readUInt16LE(at)
                : bin.readUInt8(at);
          if (v >= pos.count) throw new MeshUnreadable("an index is past the last vertex");
        }
        indices = { at: idx.at, size, count: idx.count };
        corners = idx.count;
      }
      if (corners % 3 !== 0)
        throw new MeshUnreadable("a primitive's corners are not whole triangles");
      parts.push({ positions: pos.at, vertices: pos.count, indices, triangles: corners / 3 });
    }
  }
  if (parts.length === 0) throw new MeshUnreadable("the GLB holds no triangles");
  return parts;
}

export function stlFromGlb(glb: Buffer): StlFromGlb {
  const { gltf, bin } = readGltf(glb);
  const parts = readParts(gltf, bin);
  const triangles = parts.reduce((n, p) => n + p.triangles, 0);
  if (triangles > 0xffffffff)
    throw new MeshUnreadable("the mesh has too many triangles for an STL");

  function* chunks(): Generator<Buffer> {
    const header = Buffer.alloc(84);
    header.write(HEADER, 0, "latin1");
    header.writeUInt32LE(triangles, 80);
    yield header;
    for (const part of parts) {
      const vertexAt = (corner: number): number => {
        const { indices } = part;
        if (indices === null) return corner;
        const at = indices.at + corner * indices.size;
        return indices.size === 4
          ? bin.readUInt32LE(at)
          : indices.size === 2
            ? bin.readUInt16LE(at)
            : bin.readUInt8(at);
      };
      for (let first = 0; first < part.triangles; first += TRIANGLES_PER_CHUNK) {
        const n = Math.min(TRIANGLES_PER_CHUNK, part.triangles - first);
        const out = Buffer.alloc(n * 50);
        for (let t = 0; t < n; t++) {
          const facet = t * 50;
          for (let c = 0; c < 3; c++) {
            const from = part.positions + vertexAt((first + t) * 3 + c) * 12;
            bin.copy(out, facet + 12 + c * 12, from, from + 12);
          }
        }
        yield out;
      }
    }
  }

  return { triangles, size: 84 + 50 * triangles, open: () => Readable.from(chunks()) };
}
