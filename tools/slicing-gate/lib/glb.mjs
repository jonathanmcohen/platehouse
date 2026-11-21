// Packs occt-import-js meshes into one binary glTF 2.0 (GLB) file, for report
// item (h). occt-import-js returns three.js-style arrays (position, normal,
// index), not a GLB, so the gate writes the container itself: one buffer, one
// mesh and node per input mesh, float32 positions and normals, uint32 indices.
const FLOAT = 5126;
const UINT = 5125;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

function pad4(buf, fill) {
  const extra = (4 - (buf.length % 4)) % 4;
  return extra === 0 ? buf : Buffer.concat([buf, Buffer.alloc(extra, fill)]);
}

export function meshesToGlb(meshes) {
  if (!Array.isArray(meshes) || meshes.length === 0) throw new Error("no meshes to write");
  const chunks = [];
  let offset = 0;
  const json = {
    asset: { version: "2.0", generator: "platehouse slicing gate" },
    scene: 0,
    scenes: [{ nodes: [] }],
    nodes: [],
    meshes: [],
    accessors: [],
    bufferViews: [],
    buffers: [{ byteLength: 0 }],
  };
  const addView = (typed, target) => {
    const bytes = pad4(Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength), 0);
    json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: typed.byteLength, target });
    chunks.push(bytes);
    offset += bytes.length;
    return json.bufferViews.length - 1;
  };
  const addAccessor = (accessor) => {
    json.accessors.push(accessor);
    return json.accessors.length - 1;
  };

  for (const mesh of meshes) {
    const position = Float32Array.from(mesh.attributes.position.array);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < position.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], position[i + k]);
        max[k] = Math.max(max[k], position[i + k]);
      }
    }
    const attributes = {
      POSITION: addAccessor({
        bufferView: addView(position, ARRAY_BUFFER),
        componentType: FLOAT,
        count: position.length / 3,
        type: "VEC3",
        min,
        max,
      }),
    };
    if (mesh.attributes.normal?.array?.length) {
      const normal = Float32Array.from(mesh.attributes.normal.array);
      attributes.NORMAL = addAccessor({
        bufferView: addView(normal, ARRAY_BUFFER),
        componentType: FLOAT,
        count: normal.length / 3,
        type: "VEC3",
      });
    }
    const primitive = { attributes, mode: 4 };
    if (mesh.index?.array?.length) {
      const index = Uint32Array.from(mesh.index.array);
      primitive.indices = addAccessor({
        bufferView: addView(index, ELEMENT_ARRAY_BUFFER),
        componentType: UINT,
        count: index.length,
        type: "SCALAR",
      });
    }
    json.meshes.push({ primitives: [primitive] });
    json.nodes.push({ mesh: json.meshes.length - 1 });
    json.scenes[0].nodes.push(json.nodes.length - 1);
  }

  const bin = Buffer.concat(chunks);
  json.buffers[0].byteLength = bin.length;
  const jsonChunk = pad4(Buffer.from(JSON.stringify(json), "utf8"), 0x20);
  const header = Buffer.alloc(12);
  header.write("glTF", 0, "ascii");
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + bin.length, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonChunk.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(bin.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHeader, jsonChunk, binHeader, bin]);
}
