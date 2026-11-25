// STEP to GLB, so a browser only ever loads a mesh, never a STEP file. occt-import-js 0.0.23 reads
// the STEP file and returns three.js-style arrays; meshesToGlb packs them
// into one binary glTF 2.0 file, ported from the slicing gate's lib/glb.mjs
// (gate item (h) converted NIST CTC-01 this way).
//
// The conversion runs in its own Node process, started by the server as
// `node step.js <in.stp> <out.glb>`, so a crash or runaway in OCCT's wasm
// on an untrusted file cannot take the server down, and the server can kill
// it at STEP_TIMEOUT_SECONDS. It runs under prlimit and landrun with the
// STEP worker's own rules (sandbox.ts): it may read the app and write only
// its job folder, with no TCP. It exits 0 with the GLB written, or 1
// with the reason on stderr.
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ledInMessage,
  prlimitCommand,
  readOutputFile,
  runGroup,
  type SandboxConfig,
  sandboxPaths,
  sandboxRules,
} from "./sandbox.js";

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

const MIB = 1024 * 1024;

export interface StepWorkerOptions extends SandboxConfig {
  /** The worker module (this file, or a test stand-in), run with this Node. */
  worker: string;
  timeoutSeconds: number;
  maxOutputBytes: number;
  /**
   * False only for a conversion the server runs while the sandbox is off
   * and SLICER_ALLOW_UNSANDBOXED is set: then the worker runs under prlimit
   * alone, without landrun.
   */
  sandboxed: boolean;
}

/** The size of `file` when it is a regular file itself (not a link), else null. */
function regularSize(file: string): number | null {
  try {
    const st = lstatSync(file);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

/**
 * Runs the worker on dir/input.stp (STEP_INPUT), which the caller has
 * already written, so the server never holds the body in memory: prlimit
 * with the worker's limits (its file-size limit is maxOutputBytes, the
 * contract's LIMITS.stepOutputBytes, 256 MiB), then landrun with its rules,
 * then this Node and the worker. A mesh over maxOutputBytes is refused from
 * its size, never read or sent: the app streams the answer under the same
 * cap. The output is read with readOutputFile, as a render's is: never
 * through a link, and anything but a regular file is refused unread.
 *
 * The file-size limit shows in two ways. The kernel sends SIGXFSZ to a
 * program that writes past it, but Node ignores that signal (a Node process
 * that sends itself SIGXFSZ keeps running), so the worker's write fails
 * instead (EFBIG) and it exits 1, leaving an output of exactly the limit's
 * size. Both, a SIGXFSZ or a failed run whose output reached the limit,
 * answer that the mesh went over the limit.
 */
export async function runStepWorker(
  opts: StepWorkerOptions,
  dir: string,
  track?: (kill: (() => void) | null) => void,
): Promise<ConvertResult> {
  const input = join(dir, STEP_INPUT);
  const output = join(dir, "output.glb");
  const rules = sandboxRules("step", sandboxPaths(opts, dir));
  const command = [process.execPath, opts.worker, input, output];
  const run = await runGroup(
    opts.prlimitBin,
    prlimitCommand({
      program: "step",
      timeoutSeconds: opts.timeoutSeconds,
      landrun: opts.sandboxed ? { bin: opts.landrunBin, rules } : null,
      command,
    }),
    {
      cwd: dir,
      env: rules.env,
      timeoutMs: opts.timeoutSeconds * 1000,
      ...(track ? { track } : {}),
    },
  );
  const limitMib = Math.floor(opts.maxOutputBytes / MIB);
  if (run.timedOut) {
    return {
      ok: false,
      message: `The conversion took longer than ${opts.timeoutSeconds} s and was stopped.`,
    };
  }
  const overLimit: ConvertResult = {
    ok: false,
    message: `The converted mesh went over the ${limitMib} MiB limit for a mesh, so it was stopped while writing it.`,
  };
  if (run.signal === "SIGXFSZ") return overLimit;
  if (run.code === 0) {
    const read = readOutputFile(output, opts.maxOutputBytes);
    if (!read.ok && "notRegular" in read) {
      return {
        ok: false,
        message: "The converted mesh was not a regular file, so it was not read.",
      };
    }
    if (!read.ok && "size" in read) {
      return {
        ok: false,
        message: `The converted mesh is ${Math.ceil(read.size / MIB)} MiB, over the ${limitMib} MiB limit for a mesh, so it was not sent.`,
      };
    }
    if (read.ok && read.bytes.length > 0) return { ok: true, bytes: read.bytes };
  }
  if (run.code !== 0 && (regularSize(output) ?? 0) >= opts.maxOutputBytes) return overLimit;
  // The worker's output is always led in; its exit status is the slicer's own.
  return {
    ok: false,
    message:
      ledInMessage("The converter said: ", run.stderrTail) ||
      `The converter exited with ${run.signal ?? run.code}.`,
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
