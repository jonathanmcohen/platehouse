import assert from "node:assert/strict";
import { test } from "node:test";
import { meshesToGlb } from "../lib/glb.mjs";

const triangle = {
  attributes: {
    position: { array: [0, 0, 0, 1, 0, 0, 0, 1, 0] },
    normal: { array: [0, 0, 1, 0, 0, 1, 0, 0, 1] },
  },
  index: { array: [0, 1, 2] },
};

function parse(glb) {
  assert.equal(glb.toString("ascii", 0, 4), "glTF");
  assert.equal(glb.readUInt32LE(4), 2);
  assert.equal(glb.readUInt32LE(8), glb.length);
  const jsonLen = glb.readUInt32LE(12);
  assert.equal(glb.toString("ascii", 16, 20), "JSON");
  const json = JSON.parse(glb.toString("utf8", 20, 20 + jsonLen));
  const binHeader = 20 + jsonLen;
  const binLen = glb.readUInt32LE(binHeader);
  assert.equal(glb.readUInt32LE(binHeader + 4), 0x004e4942);
  assert.equal(jsonLen % 4, 0);
  assert.equal(binLen % 4, 0);
  return { json, binLen, bin: glb.subarray(binHeader + 8, binHeader + 8 + binLen) };
}

test("one indexed triangle becomes a valid GLB 2.0 with position min/max", () => {
  const { json, binLen, bin } = parse(meshesToGlb([triangle]));
  assert.equal(json.asset.version, "2.0");
  assert.equal(json.meshes.length, 1);
  const prim = json.meshes[0].primitives[0];
  const pos = json.accessors[prim.attributes.POSITION];
  assert.equal(pos.count, 3);
  assert.deepEqual(pos.min, [0, 0, 0]);
  assert.deepEqual(pos.max, [1, 1, 0]);
  assert.equal(json.accessors[prim.indices].componentType, 5125);
  assert.equal(json.buffers[0].byteLength, binLen);
  const view = json.bufferViews[pos.bufferView];
  assert.equal(new Float32Array(bin.buffer.slice(bin.byteOffset + view.byteOffset, bin.byteOffset + view.byteOffset + 36))[3], 1);
});

test("several meshes, one without normals, share one buffer with 4-byte aligned views", () => {
  const noNormals = { attributes: { position: triangle.attributes.position }, index: { array: [0, 1, 2] } };
  const { json } = parse(meshesToGlb([triangle, noNormals]));
  assert.equal(json.meshes.length, 2);
  assert.equal(json.nodes.length, 2);
  assert.equal(json.meshes[1].primitives[0].attributes.NORMAL, undefined);
  assert.ok(json.bufferViews.every((v) => v.byteOffset % 4 === 0));
});

test("no meshes is an error, not an empty file", () => {
  assert.throws(() => meshesToGlb([]), /no meshes/);
});
