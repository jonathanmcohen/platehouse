// STEP to GLB (AC-050, build plan decision 2). occt-import-js 0.0.23 reads
// the STEP file and returns three.js-style arrays; meshesToGlb packs them
// into one binary glTF 2.0 file, ported from the slicing gate's lib/glb.mjs
// (gate item (h) converted NIST CTC-01 this way).
//
// The conversion runs in its own Node process, started by the server as
// `node step.js <in.stp> <out.glb>`, so a crash or runaway in OCCT's wasm
// on an untrusted file cannot take the server down, and the server can kill
// it at STEP_TIMEOUT_SECONDS. It exits 0 with the GLB written, or 1 with the
// reason on stderr.
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runGroup, tailLines } from "./sandbox.js";

export interface OcctMesh {
  attributes: {
    position: { array: ArrayLike<number> };
    normal?: { array: ArrayLike<number> };
  };
  index?: { array: ArrayLike<number> };
}

const FLOAT = 5126;
const UINT = 5125;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

function pad4(buf: Buffer, fill: number): Buffer {
  const extra = (4 - (buf.length % 4)) % 4;
  return extra === 0 ? buf : Buffer.concat([buf, Buffer.alloc(extra, fill)]);
}

interface Accessor {
  bufferView: number;
  componentType: number;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
}

/** One GLB: one buffer, one mesh and node per input mesh, float32 and uint32. */
export function meshesToGlb(meshes: OcctMesh[]): Buffer {
  if (meshes.length === 0) throw new Error("no meshes to write");
  const chunks: Buffer[] = [];
  let offset = 0;
  const bufferViews: Array<{ buffer: 0; byteOffset: number; byteLength: number; target: number }> =
    [];
  const accessors: Accessor[] = [];
  const gltfMeshes: Array<{ primitives: unknown[] }> = [];
  const nodes: Array<{ mesh: number }> = [];
  const addView = (typed: Float32Array | Uint32Array, target: number): number => {
    const bytes = pad4(Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength), 0);
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: typed.byteLength, target });
    chunks.push(bytes);
    offset += bytes.length;
    return bufferViews.length - 1;
  };
  const addAccessor = (a: Accessor): number => {
    accessors.push(a);
    return accessors.length - 1;
  };

  for (const mesh of meshes) {
    const position = Float32Array.from(mesh.attributes.position.array);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i + 2 < position.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = position[i + k] as number;
        min[k] = Math.min(min[k] as number, v);
        max[k] = Math.max(max[k] as number, v);
      }
    }
    const attributes: Record<string, number> = {
      POSITION: addAccessor({
        bufferView: addView(position, ARRAY_BUFFER),
        componentType: FLOAT,
        count: position.length / 3,
        type: "VEC3",
        min,
        max,
      }),
    };
    const normals = mesh.attributes.normal?.array;
    if (normals && normals.length > 0) {
      const normal = Float32Array.from(normals);
      attributes.NORMAL = addAccessor({
        bufferView: addView(normal, ARRAY_BUFFER),
        componentType: FLOAT,
        count: normal.length / 3,
        type: "VEC3",
      });
    }
    const primitive: { attributes: Record<string, number>; mode: number; indices?: number } = {
      attributes,
      mode: 4,
    };
    const indices = mesh.index?.array;
    if (indices && indices.length > 0) {
      const index = Uint32Array.from(indices);
      primitive.indices = addAccessor({
        bufferView: addView(index, ELEMENT_ARRAY_BUFFER),
        componentType: UINT,
        count: index.length,
        type: "SCALAR",
      });
    }
    gltfMeshes.push({ primitives: [primitive] });
    nodes.push({ mesh: gltfMeshes.length - 1 });
  }

  const bin = Buffer.concat(chunks);
  const json = {
    asset: { version: "2.0", generator: "platehouse slicer" },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes: gltfMeshes,
    accessors,
    bufferViews,
    buffers: [{ byteLength: bin.length }],
  };
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

interface OcctModule {
  ReadStepFile(content: Uint8Array, params: null): { success: boolean; meshes?: OcctMesh[] };
}

/** Converts one STEP file with occt-import-js and writes the GLB. */
export async function convertStepFile(input: string, output: string): Promise<void> {
  const require = createRequire(import.meta.url);
  const init = require("occt-import-js") as () => Promise<OcctModule>;
  const occt = await init();
  const parsed = occt.ReadStepFile(new Uint8Array(readFileSync(input)), null);
  if (!parsed.success) throw new Error("occt-import-js could not read the file as STEP");
  const meshes = parsed.meshes ?? [];
  if (meshes.length === 0) throw new Error("the STEP file has no shapes to mesh");
  writeFileSync(output, meshesToGlb(meshes));
}

export type ConvertResult = { ok: true; bytes: Buffer } | { ok: false; message: string };

/** The name the STEP file takes inside its job folder. */
export const STEP_INPUT = "input.stp";

/**
 * Runs the worker (this file, or a test stand-in) on dir/input.stp
 * (STEP_INPUT), which the caller has already written, so the server never
 * holds the body in memory.
 */
export async function runStepWorker(
  opts: { worker: string; timeoutSeconds: number },
  dir: string,
  track?: (kill: (() => void) | null) => void,
): Promise<ConvertResult> {
  const input = join(dir, STEP_INPUT);
  const output = join(dir, "output.glb");
  const run = await runGroup(process.execPath, [opts.worker, input, output], {
    cwd: dir,
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: dir, TMPDIR: dir, LANG: "C.UTF-8" },
    timeoutMs: opts.timeoutSeconds * 1000,
    ...(track ? { track } : {}),
  });
  if (run.timedOut) {
    return {
      ok: false,
      message: `The conversion took longer than ${opts.timeoutSeconds} s and was stopped.`,
    };
  }
  if (run.code === 0 && existsSync(output) && statSync(output).size > 0) {
    return { ok: true, bytes: readFileSync(output) };
  }
  return {
    ok: false,
    message: tailLines(run.stderrTail) || `The converter exited with ${run.signal ?? run.code}.`,
  };
}

function isMain(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(argv1);
  } catch {
    return false;
  }
}

if (isMain()) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    process.stderr.write("usage: step.js <in.stp> <out.glb>\n");
    process.exit(2);
  }
  convertStepFile(input, output).then(
    () => process.exit(0),
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
