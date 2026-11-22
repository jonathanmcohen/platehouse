// A .3mf plate's objects as one GLB, glTF 2.0's binary form (issue #358):
// the file the model page's 3D view loads, with the same viewer and loader
// (three.js's GLTFLoader) as a STEP file's mesh.
//
// The layout:
// - one glTF mesh per piece (a mesh in one colour), with its vertices
//   (POSITION, float32) and triangles (uint32 indices) as the .3mf has them,
//   so an object placed twice is held once;
// - one node per instance, carrying the instance's 3MF transform as a glTF
//   matrix. A 3MF transform is written for row vectors and a glTF matrix is
//   column-major for column vectors, which come to the same 16 numbers: the
//   transform's 12, three to a column, with 0 0 0 1 filling the last row;
// - every instance under one root node that turns the plate's Z up into
//   glTF's Y up (a quarter turn about x), as the 3D view expects;
// - one material per colour: the filament's #RRGGBB as baseColorFactor in
//   glTF's linear colour, or DEFAULT_COLOUR for a piece the file gives no
//   colour, with the roughness and metalness of the STL view's material.
// Every bufferView starts on a 4-byte boundary, the JSON chunk is padded with
// spaces and the BIN chunk with zeros, as the GLB format requires.
//
// The GLB is handed over as a list of chunks to write one after another, the
// mesh data as views of the reader's own arrays, never copied into one
// buffer (review of PR #368). Those arrays are what the reader's memory
// budget counts; a GLB joined into one buffer, and that into another, held
// up to three times the budget per build, outside it.
import type { PlateMesh } from "@platehouse/threemf";

export const GLB_CONTENT_TYPE = "model/gltf-binary";

/** The colour of a piece whose filament the file does not give: a neutral grey. */
export const DEFAULT_COLOUR = "#A0A0A0";

const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const FLOAT = 5126;
const UNSIGNED_INT = 5125;
const TRIANGLES = 4;
const HALF_SQRT2 = Math.SQRT1_2;

/** An sRGB channel, 0 to 255, in glTF's linear colour. */
function linear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function baseColour(hex: string): number[] {
  const n = (i: number) => Number.parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16);
  return [linear(n(0)), linear(n(1)), linear(n(2)), 1];
}

/** The instance's 3MF transform as a glTF matrix (see the file comment). */
function matrixOf(t: number[]): number[] {
  const at = (i: number) => t[i] ?? 0;
  return [
    at(0),
    at(1),
    at(2),
    0,
    at(3),
    at(4),
    at(5),
    0,
    at(6),
    at(7),
    at(8),
    0,
    at(9),
    at(10),
    at(11),
    1,
  ];
}

function bounds(positions: Float32Array): { min: number[]; max: number[] } {
  const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k] as number;
      if (v < (min[k] as number)) min[k] = v;
      if (v > (max[k] as number)) max[k] = v;
    }
  }
  return { min, max };
}

/** A GLB as the chunks to write in order, and their total length. */
export interface PlateGlb {
  chunks: Buffer[];
  byteLength: number;
}

/** The plate's objects as GLB bytes (see the file comment: no mesh data is copied). */
export function encodePlateGlb(mesh: PlateMesh): PlateGlb {
  const materials: object[] = [];
  const materialOf = new Map<string, number>();
  const bufferViews: object[] = [];
  const accessors: object[] = [];
  const meshes: object[] = [];
  const chunks: Buffer[] = [];
  let offset = 0;

  const addView = (bytes: Buffer, target: number): number => {
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target });
    chunks.push(bytes);
    // float32 and uint32 data are whole 4-byte words, so the next view
    // starts on a 4-byte boundary too.
    offset += bytes.length;
    return bufferViews.length - 1;
  };

  for (const piece of mesh.pieces) {
    const colour = piece.colour ?? DEFAULT_COLOUR;
    let material = materialOf.get(colour);
    if (material === undefined) {
      material = materials.length;
      materials.push({
        pbrMetallicRoughness: {
          baseColorFactor: baseColour(colour),
          metallicFactor: 0.05,
          roughnessFactor: 0.6,
        },
      });
      materialOf.set(colour, material);
    }
    const positionView = addView(
      Buffer.from(piece.positions.buffer, piece.positions.byteOffset, piece.positions.byteLength),
      ARRAY_BUFFER,
    );
    const indexView = addView(
      Buffer.from(piece.indices.buffer, piece.indices.byteOffset, piece.indices.byteLength),
      ELEMENT_ARRAY_BUFFER,
    );
    accessors.push({
      bufferView: positionView,
      componentType: FLOAT,
      count: piece.positions.length / 3,
      type: "VEC3",
      ...bounds(piece.positions),
    });
    accessors.push({
      bufferView: indexView,
      componentType: UNSIGNED_INT,
      count: piece.indices.length,
      type: "SCALAR",
    });
    meshes.push({
      primitives: [
        {
          attributes: { POSITION: accessors.length - 2 },
          indices: accessors.length - 1,
          material,
          mode: TRIANGLES,
        },
      ],
    });
  }

  const nodes: object[] = [
    {
      name: "plate",
      // Z up (the plate) to Y up (glTF): a quarter turn about x, backwards.
      rotation: [-HALF_SQRT2, 0, 0, HALF_SQRT2],
      children: mesh.instances.map((_, i) => i + 1),
    },
    ...mesh.instances.map((inst) => ({ mesh: inst.piece, matrix: matrixOf(inst.transform) })),
  ];

  const json = {
    asset: { version: "2.0", generator: "Platehouse" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: offset }],
  };

  const jsonBytes = pad(Buffer.from(JSON.stringify(json), "utf8"), 0x20);
  // The views are whole 4-byte words, so the BIN chunk needs no padding;
  // any would be zeros after the last view.
  const binPadding = Buffer.alloc((4 - (offset % 4)) % 4, 0);
  const binLength = offset + binPadding.length;
  const byteLength = 12 + 8 + jsonBytes.length + 8 + binLength;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // "glTF"
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(byteLength, 8);
  const out = [
    header,
    chunkHeader(jsonBytes.length, 0x4e4f534a), // "JSON"
    jsonBytes,
    chunkHeader(binLength, 0x004e4942), // "BIN\0"
    ...chunks,
  ];
  if (binPadding.length > 0) out.push(binPadding);
  return { chunks: out, byteLength };
}

/** The JSON padded to a 4-byte boundary; it is small, so it is joined. */
function pad(bytes: Buffer, fill: number): Buffer {
  const extra = (4 - (bytes.length % 4)) % 4;
  return extra === 0 ? bytes : Buffer.concat([bytes, Buffer.alloc(extra, fill)]);
}

function chunkHeader(length: number, type: number): Buffer {
  const out = Buffer.alloc(8);
  out.writeUInt32LE(length, 0);
  out.writeUInt32LE(type, 4);
  return out;
}
