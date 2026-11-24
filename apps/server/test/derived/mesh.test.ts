// Issue #316: a STEP file's preview is rendered from the GLB mesh it was
// already converted to, sent to the slicer's /v1/stl/png as a binary STL.
// stlFromGlb reads the GLB the slicer writes (apps/slicer/src/step.ts
// meshesToGlb: one buffer, float32 positions, uint32 indices, triangles) and
// refuses anything it cannot read as that, rather than guessing.
import { describe, expect, test } from "vitest";
import { MeshUnreadable, stlFromGlb } from "../../src/derived/mesh.js";

interface MeshSpec {
  positions: number[];
  indices?: number[];
  /** 5125 uint32 (what the slicer writes), 5123 uint16 or 5121 uint8. */
  indexType?: 5121 | 5123 | 5125;
  mode?: number;
}

const INDEX_BYTES = { 5121: 1, 5123: 2, 5125: 4 } as const;

function pad4(b: Buffer, fill: number): Buffer {
  const extra = (4 - (b.length % 4)) % 4;
  return extra === 0 ? b : Buffer.concat([b, Buffer.alloc(extra, fill)]);
}

/** A GLB laid out as the slicer's meshesToGlb lays one out. */
function glb(meshes: MeshSpec[], tweak: (json: Record<string, unknown>) => void = () => {}) {
  const chunks: Buffer[] = [];
  let offset = 0;
  const bufferViews: Record<string, number>[] = [];
  const accessors: Record<string, unknown>[] = [];
  const gltfMeshes: unknown[] = [];
  const view = (bytes: Buffer) => {
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length });
    const padded = pad4(bytes, 0);
    chunks.push(padded);
    offset += padded.length;
    return bufferViews.length - 1;
  };
  for (const m of meshes) {
    const pos = Buffer.alloc(m.positions.length * 4);
    m.positions.forEach((v, i) => {
      pos.writeFloatLE(v, i * 4);
    });
    accessors.push({
      bufferView: view(pos),
      componentType: 5126,
      count: m.positions.length / 3,
      type: "VEC3",
    });
    const primitive: Record<string, unknown> = {
      attributes: { POSITION: accessors.length - 1 },
      mode: m.mode ?? 4,
    };
    if (m.indices) {
      const type = m.indexType ?? 5125;
      const size = INDEX_BYTES[type];
      const idx = Buffer.alloc(m.indices.length * size);
      m.indices.forEach((v, i) => {
        if (size === 4) idx.writeUInt32LE(v, i * 4);
        else if (size === 2) idx.writeUInt16LE(v, i * 2);
        else idx.writeUInt8(v, i);
      });
      accessors.push({
        bufferView: view(idx),
        componentType: type,
        count: m.indices.length,
        type: "SCALAR",
      });
      primitive.indices = accessors.length - 1;
    }
    gltfMeshes.push({ primitives: [primitive] });
  }
  const bin = Buffer.concat(chunks);
  const json: Record<string, unknown> = {
    asset: { version: "2.0", generator: "platehouse slicer" },
    meshes: gltfMeshes,
    accessors,
    bufferViews,
    buffers: [{ byteLength: bin.length }],
  };
  tweak(json);
  const text = pad4(Buffer.from(JSON.stringify(json), "utf8"), 0x20);
  const header = Buffer.alloc(12);
  header.write("glTF", 0, "ascii");
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + text.length + 8 + bin.length, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(text.length, 0);
  jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(bin.length, 0);
  bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jh, text, bh, bin]);
}

async function bytesOf(glbBytes: Buffer): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stlFromGlb(glbBytes).open()) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/** The triangles of a binary STL, each as its nine coordinates. */
function trianglesOf(stl: Buffer): number[][] {
  const n = stl.readUInt32LE(80);
  const out: number[][] = [];
  for (let i = 0; i < n; i++) {
    const at = 84 + i * 50 + 12;
    out.push(Array.from({ length: 9 }, (_, k) => stl.readFloatLE(at + k * 4)));
  }
  return out;
}

const QUAD = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];

describe("stlFromGlb", () => {
  test("an indexed mesh becomes a binary STL of its triangles, the size known before reading", async () => {
    const input = glb([{ positions: QUAD, indices: [0, 1, 2, 0, 2, 3] }]);
    const made = stlFromGlb(input);
    expect(made.triangles).toBe(2);
    expect(made.size).toBe(84 + 2 * 50);
    const stl = await bytesOf(input);
    expect(stl.length).toBe(made.size);
    expect(stl.readUInt32LE(80)).toBe(2);
    expect(trianglesOf(stl)).toEqual([
      [0, 0, 0, 1, 0, 0, 1, 1, 0],
      [0, 0, 0, 1, 1, 0, 0, 1, 0],
    ]);
    // Facet normals are left zero; OpenSCAD works them out itself.
    expect(stl.readFloatLE(84)).toBe(0);
  });

  test("every mesh is kept, in order, and a mesh with no indices is read as a list of triangles", async () => {
    const input = glb([
      { positions: QUAD, indices: [0, 1, 2] },
      { positions: [5, 5, 5, 6, 5, 5, 5, 6, 5] },
    ]);
    expect(trianglesOf(await bytesOf(input))).toEqual([
      [0, 0, 0, 1, 0, 0, 1, 1, 0],
      [5, 5, 5, 6, 5, 5, 5, 6, 5],
    ]);
  });

  test("16-bit and 8-bit indices are read too", async () => {
    for (const indexType of [5123, 5121] as const) {
      const input = glb([{ positions: QUAD, indices: [0, 2, 3], indexType }]);
      expect(trianglesOf(await bytesOf(input))).toEqual([[0, 0, 0, 1, 1, 0, 0, 1, 0]]);
    }
  });

  test("a large mesh streams in more than one chunk and still adds up", async () => {
    const positions: number[] = [];
    for (let i = 0; i < 30_000; i++) positions.push(i, 0, 0, i, 1, 0, i, 0, 1);
    const input = glb([{ positions }]);
    const made = stlFromGlb(input);
    let pieces = 0;
    let total = 0;
    for await (const c of made.open()) {
      pieces += 1;
      total += (c as Buffer).length;
    }
    expect(made.triangles).toBe(30_000);
    expect(total).toBe(made.size);
    expect(pieces).toBeGreaterThan(1);
  });

  const BROKEN: [string, () => Buffer][] = [
    ["bytes that are not a GLB", () => Buffer.from("not a glb at all, just text")],
    [
      "a GLB of version 1",
      () => {
        const b = glb([{ positions: QUAD, indices: [0, 1, 2] }]);
        b.writeUInt32LE(1, 4);
        return b;
      },
    ],
    ["a GLB cut short", () => glb([{ positions: QUAD, indices: [0, 1, 2] }]).subarray(0, 60)],
    [
      "a JSON chunk that is not JSON",
      () => {
        const b = glb([{ positions: QUAD, indices: [0, 1, 2] }]);
        b.write("{{{{", 20, "latin1");
        return b;
      },
    ],
    ["an index past the last vertex", () => glb([{ positions: QUAD, indices: [0, 1, 9] }])],
    ["a primitive that is not triangles", () => glb([{ positions: QUAD, mode: 1 }])],
    [
      "an accessor past the end of the buffer",
      () =>
        glb([{ positions: QUAD, indices: [0, 1, 2] }], (json) => {
          (json.accessors as Record<string, unknown>[])[0] = {
            bufferView: 0,
            componentType: 5126,
            count: 1000,
            type: "VEC3",
          };
        }),
    ],
    [
      "positions that are not float VEC3",
      () =>
        glb([{ positions: QUAD, indices: [0, 1, 2] }], (json) => {
          (json.accessors as Record<string, unknown>[])[0] = {
            bufferView: 0,
            componentType: 5126,
            count: 4,
            type: "VEC2",
          };
        }),
    ],
    [
      "a node that moves its mesh, which the slicer never writes",
      () =>
        glb([{ positions: QUAD, indices: [0, 1, 2] }], (json) => {
          json.nodes = [{ mesh: 0, translation: [1, 0, 0] }];
        }),
    ],
    ["no meshes at all", () => glb([])],
    [
      "a null node",
      () =>
        glb([{ positions: QUAD, indices: [0, 1, 2] }], (json) => {
          json.nodes = [null];
        }),
    ],
    [
      "a nodes list that is not a list",
      () =>
        glb([{ positions: QUAD, indices: [0, 1, 2] }], (json) => {
          json.nodes = { mesh: 0 };
        }),
    ],
    [
      "a null mesh",
      () =>
        glb([{ positions: QUAD, indices: [0, 1, 2] }], (json) => {
          json.meshes = [null];
        }),
    ],
    [
      "a mesh whose primitives are not a list",
      () =>
        glb([{ positions: QUAD, indices: [0, 1, 2] }], (json) => {
          json.meshes = [{ primitives: 3 }];
        }),
    ],
    [
      "a null primitive",
      () =>
        glb([{ positions: QUAD, indices: [0, 1, 2] }], (json) => {
          json.meshes = [{ primitives: [null] }];
        }),
    ],
  ];

  test.each(BROKEN)("refuses %s with MeshUnreadable", (_label, make) => {
    expect(() => stlFromGlb(make())).toThrow(MeshUnreadable);
  });
});
