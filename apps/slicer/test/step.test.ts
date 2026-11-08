// STEP to GLB (AC-050, build plan decision 2): occt-import-js returns
// three.js-style arrays, and the slicer packs them into one binary glTF 2.0
// file. Ported from the slicing gate's lib/glb.mjs and its tests; gate item
// (h) proved the path on NIST CTC-01.
import { describe, expect, test } from "vitest";
import { meshesToGlb, type OcctMesh } from "../src/step.js";

function parse(glb: Buffer) {
  expect(glb.subarray(0, 4).toString("ascii")).toBe("glTF");
  expect(glb.readUInt32LE(4)).toBe(2);
  expect(glb.readUInt32LE(8)).toBe(glb.length);
  const jsonLength = glb.readUInt32LE(12);
  expect(glb.readUInt32LE(16)).toBe(0x4e4f534a);
  const json = JSON.parse(glb.subarray(20, 20 + jsonLength).toString("utf8"));
  const binAt = 20 + jsonLength;
  expect(glb.readUInt32LE(binAt + 4)).toBe(0x004e4942);
  return { json, binLength: glb.readUInt32LE(binAt) };
}

const triangle: OcctMesh = {
  attributes: {
    position: { array: [0, 0, 0, 1, 0, 0, 0, 2, 3] },
    normal: { array: [0, 0, 1, 0, 0, 1, 0, 0, 1] },
  },
  index: { array: [0, 1, 2] },
};

describe("meshesToGlb", () => {
  test("one indexed triangle becomes a valid GLB 2.0 with position min/max", () => {
    const { json, binLength } = parse(meshesToGlb([triangle]));
    expect(json.asset.version).toBe("2.0");
    expect(json.meshes).toHaveLength(1);
    const pos = json.accessors[json.meshes[0].primitives[0].attributes.POSITION];
    expect(pos).toMatchObject({ count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 2, 3] });
    expect(json.accessors[json.meshes[0].primitives[0].indices]).toMatchObject({
      count: 3,
      type: "SCALAR",
    });
    expect(binLength).toBe(json.buffers[0].byteLength);
  });

  test("several meshes, one without normals, share one buffer with 4-byte aligned views", () => {
    const bare: OcctMesh = {
      attributes: { position: { array: [0, 0, 0, 1, 1, 1, 2, 2, 2] } },
      index: { array: [0, 1, 2] },
    };
    const { json } = parse(meshesToGlb([triangle, bare]));
    expect(json.meshes).toHaveLength(2);
    expect(json.meshes[1].primitives[0].attributes.NORMAL).toBeUndefined();
    for (const v of json.bufferViews) expect(v.byteOffset % 4).toBe(0);
    expect(json.scenes[0].nodes).toEqual([0, 1]);
  });

  test("no meshes is an error, not an empty file", () => {
    expect(() => meshesToGlb([])).toThrow(/no meshes/);
  });
});
