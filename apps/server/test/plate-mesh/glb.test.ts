// Issue #358: a plate's objects as one GLB (glTF 2.0 binary), the file the
// model page's 3D view loads (the same viewer and loader as a STEP file's
// mesh). The checks read the bytes back as a glTF reader would: the
// header and chunk layout, the accessors against the buffer, the placement
// of each piece and the colour of its material.
import type { PlateMesh } from "@platehouse/threemf";
import { describe, expect, test } from "vitest";
import { DEFAULT_COLOUR, encodePlateGlb, GLB_CONTENT_TYPE } from "../../src/plate-mesh/glb.js";

interface Gltf {
  asset: { version: string };
  scene: number;
  scenes: Array<{ nodes: number[] }>;
  nodes: Array<{ mesh?: number; matrix?: number[]; rotation?: number[]; children?: number[] }>;
  meshes: Array<{
    primitives: Array<{
      attributes: { POSITION: number };
      indices: number;
      material: number;
      mode: number;
    }>;
  }>;
  materials: Array<{ pbrMetallicRoughness: { baseColorFactor: number[] } }>;
  buffers: Array<{ byteLength: number }>;
  bufferViews: Array<{ buffer: number; byteOffset: number; byteLength: number; target?: number }>;
  accessors: Array<{
    bufferView: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: string;
    min?: number[];
    max?: number[];
  }>;
}

function readGlb(bytes: Buffer): { json: Gltf; bin: Buffer } {
  expect(bytes.readUInt32LE(0)).toBe(0x46546c67); // "glTF"
  expect(bytes.readUInt32LE(4)).toBe(2);
  expect(bytes.readUInt32LE(8)).toBe(bytes.length);
  const jsonLength = bytes.readUInt32LE(12);
  expect(bytes.readUInt32LE(16)).toBe(0x4e4f534a); // "JSON"
  expect(jsonLength % 4).toBe(0);
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8")) as Gltf;
  const at = 20 + jsonLength;
  const binLength = bytes.readUInt32LE(at);
  expect(bytes.readUInt32LE(at + 4)).toBe(0x004e4942); // "BIN\0"
  expect(binLength % 4).toBe(0);
  expect(at + 8 + binLength).toBe(bytes.length);
  return { json, bin: bytes.subarray(at + 8, at + 8 + binLength) };
}

function floats(json: Gltf, bin: Buffer, accessor: number): number[] {
  const a = json.accessors[accessor];
  if (a === undefined) throw new Error(`no accessor ${accessor}`);
  const view = json.bufferViews[a.bufferView];
  if (view === undefined) throw new Error(`no view ${a.bufferView}`);
  const start = view.byteOffset + (a.byteOffset ?? 0);
  const out: number[] = [];
  const size = a.type === "VEC3" ? 3 : 1;
  for (let i = 0; i < a.count * size; i++) {
    out.push(
      a.componentType === 5126 ? bin.readFloatLE(start + 4 * i) : bin.readUInt32LE(start + 4 * i),
    );
  }
  return out;
}

const box: PlateMesh["pieces"][number] = {
  positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 20, 0, 0, 0, 5]),
  indices: new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]),
  colour: "#FFFFFF",
};

const mesh: PlateMesh = {
  plate: 2,
  pieces: [box, { ...box, colour: null }, { ...box, colour: "#808080" }],
  instances: [
    { piece: 0, transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 100, 50, 0] },
    { piece: 0, transform: [0, 1, 0, -1, 0, 0, 0, 0, 1, 7, 8, 9] },
    { piece: 1, transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] },
    { piece: 2, transform: [2, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0] },
  ],
  triangles: 16,
};

describe("encodePlateGlb", () => {
  test("is a glTF 2.0 binary with one JSON and one BIN chunk, each 4-byte aligned", () => {
    const { json, bin } = readGlb(encodePlateGlb(mesh));
    expect(json.asset.version).toBe("2.0");
    expect(json.buffers).toEqual([{ byteLength: bin.length }]);
    for (const view of json.bufferViews) {
      expect(view.byteOffset % 4).toBe(0);
      expect(view.byteOffset + view.byteLength).toBeLessThanOrEqual(bin.length);
    }
    expect(GLB_CONTENT_TYPE).toBe("model/gltf-binary");
  });

  test("holds each piece once, with its vertices and triangles as they came", () => {
    const { json, bin } = readGlb(encodePlateGlb(mesh));
    expect(json.meshes).toHaveLength(3);
    for (const m of json.meshes) {
      const [p] = m.primitives;
      if (p === undefined) throw new Error("no primitive");
      expect(p.mode).toBe(4);
      expect(floats(json, bin, p.attributes.POSITION)).toEqual([...box.positions]);
      expect(floats(json, bin, p.indices)).toEqual([...box.indices]);
      const pos = json.accessors[p.attributes.POSITION];
      expect(pos?.componentType).toBe(5126);
      expect(pos?.min).toEqual([0, 0, 0]);
      expect(pos?.max).toEqual([10, 20, 5]);
      expect(json.accessors[p.indices]?.componentType).toBe(5125);
    }
  });

  test("places every instance under one root that turns the plate's Z up into glTF's Y up", () => {
    const { json } = readGlb(encodePlateGlb(mesh));
    const rootIndex = json.scenes[json.scene]?.nodes[0] ?? -1;
    const root = json.nodes[rootIndex];
    // A quarter turn about x, backwards: (x, y, z) goes to (x, z, -y).
    expect(root?.rotation).toEqual([-Math.SQRT1_2, 0, 0, Math.SQRT1_2]);
    const children = (root?.children ?? []).map((i) => json.nodes[i]);
    expect(children.map((c) => c?.mesh)).toEqual([0, 0, 1, 2]);
    // glTF matrices are column-major for column vectors; a 3MF transform is
    // for row vectors, so its 12 numbers fill the first three rows of each column.
    expect(children[0]?.matrix).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 50, 0, 1]);
    expect(children[1]?.matrix).toEqual([0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 7, 8, 9, 1]);
  });

  test("puts a point where the 3MF transform puts it", () => {
    const { json } = readGlb(encodePlateGlb(mesh));
    const m = json.nodes[json.nodes[0]?.children?.[1] ?? -1]?.matrix ?? [];
    const [x, y, z] = [3, 4, 5];
    // glTF: A * (x, y, z, 1), column-major.
    const g = [0, 1, 2].map(
      (r) => (m[r] ?? 0) * x + (m[4 + r] ?? 0) * y + (m[8 + r] ?? 0) * z + (m[12 + r] ?? 0),
    );
    // 3MF: x*m00 + y*m10 + z*m20 + m30, and so on.
    const t = mesh.instances[1]?.transform ?? [];
    const w = [0, 1, 2].map(
      (c) => x * (t[c] ?? 0) + y * (t[3 + c] ?? 0) + z * (t[6 + c] ?? 0) + (t[9 + c] ?? 0),
    );
    expect(g).toEqual(w);
  });

  test("colours each piece by its filament, in glTF's linear colour, and grey when it has none", () => {
    const { json } = readGlb(encodePlateGlb(mesh));
    const colourOf = (meshIndex: number) => {
      const material = json.meshes[meshIndex]?.primitives[0]?.material ?? -1;
      return json.materials[material]?.pbrMetallicRoughness.baseColorFactor.map(
        (n) => Math.round(n * 1e4) / 1e4,
      );
    };
    expect(colourOf(0)).toEqual([1, 1, 1, 1]);
    expect(colourOf(2)).toEqual([0.2159, 0.2159, 0.2159, 1]);
    const grey = Number.parseInt(DEFAULT_COLOUR.slice(1, 3), 16) / 255;
    const linear = grey <= 0.04045 ? grey / 12.92 : ((grey + 0.055) / 1.055) ** 2.4;
    expect(colourOf(1)).toEqual([linear, linear, linear, 1].map((n) => Math.round(n * 1e4) / 1e4));
  });

  test("shares one material between pieces of the same colour", () => {
    const { json } = readGlb(
      encodePlateGlb({ ...mesh, pieces: [box, { ...box }], instances: mesh.instances.slice(0, 2) }),
    );
    expect(json.materials).toHaveLength(1);
  });
});
