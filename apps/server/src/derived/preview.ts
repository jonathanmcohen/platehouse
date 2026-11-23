// Preview pictures for STL and STEP files (issue #316), made by the slicer's
// POST /v1/stl/png, which renders a PNG of an STL with the same OpenSCAD,
// sandbox and time cap as a .scad render.
//
// - An STL's own source is streamed from the bucket to the route, as a STEP
//   file is to /v1/step/glb. One over the contract's 256 MiB limit is never
//   opened or sent; it fails with DERIVED_MESSAGES.stlTooLarge.
// - A STEP file's preview is made from the GLB mesh already stored for its
//   3D view, so the STEP file is never converted twice: the GLB is read back,
//   turned into a binary STL (mesh.ts) and sent the same way. A mesh that
//   cannot be read, or whose STL would be over the limit, fails before
//   anything is sent.
//
// A STEP preview reads its whole mesh into the app's memory, so it shares
// the process's memory gate with the plate mesh builds (review of PR #409;
// memory/gate.ts, memoryGate), and at most one of them holds its peak
// at a time:
// - A mesh stored larger than PREVIEW_MESH_MAX_BYTES is refused from its
//   recorded size (a mesh with no recorded size is refused too), before it is read and before the gate is asked for, so
//   the read's peak is bounded: STEP_PREVIEW_PEAK_MB (memory/peaks.ts), which the memory
//   budget counts (test/compose-example.test.ts).
// - Inside the gate (hold) the mesh is read, turned into an STL and written
//   to a temp folder of its own under tmpDir; then the gate is let go and
//   the mesh with it. The STL is sent from the file after that, so the
//   preview never asks the slicer for anything while it holds or waits for
//   the gate, and a plate build never waits for the slicer.
// - The temp folder is removed whatever happens.
//
// A failure the file should show starts with Platehouse's own sentence
// (DERIVED_MESSAGES.previewFailed, or previewRejected before OpenSCAD's own
// words), so the page can say it in its language. Everything else (busy, a
// lost connection, a slicer that is down or older than this app) comes from
// postRender as it does for every render, and the job decides (derived.ts).
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { LIMITS } from "@platehouse/slicer-contract";
import {
  DERIVED_MESSAGES,
  postRender,
  RenderFailed,
  type RenderOutput,
  SLICER_NOT_AN_STL,
  type SlicerTarget,
} from "./client.js";
import { MeshUnreadable, stlFromGlb } from "./mesh.js";

const PNG = "image/png";
const MIB = 1024 * 1024;

/**
 * The largest stored mesh a STEP preview reads: 256 MiB, the contract's
 * stlBodyBytes. Refusing a larger one should turn away no preview that would
 * have worked: the GLB the slicer writes spends at most 48 bytes on a
 * triangle (three float32 positions and three uint32 indices) and the STL
 * spends 50, so a mesh over 256 MiB would make an STL over the same limit.
 */
export const PREVIEW_MESH_MAX_BYTES = LIMITS.stlBodyBytes;

/** Posts an STL to /v1/stl/png; OpenSCAD's refusal comes back after the preview sentence. */
async function postPreview(
  target: SlicerTarget,
  body: Readable,
  tooLarge: string,
): Promise<RenderOutput[]> {
  try {
    const bytes = await postRender(target, {
      route: "/v1/stl/png",
      body,
      contentType: "application/octet-stream",
      accept: PNG,
      refusal: "render",
      tooLarge,
    });
    return [{ kind: "render_png", contentType: PNG, bytes }];
  } catch (error) {
    // A 413 is already the sentence the file shows. A 422 is OpenSCAD's own
    // words, which get the sentence before them, except the slicer's own
    // refusal of an STL with no triangles, sent before OpenSCAD runs, which
    // gets the preview sentence alone (issue #379).
    if (error instanceof RenderFailed && error.message !== tooLarge) {
      const lead =
        error.message === SLICER_NOT_AN_STL
          ? DERIVED_MESSAGES.previewFailed
          : DERIVED_MESSAGES.previewRejected;
      throw new RenderFailed(`${lead} ${error.message}`);
    }
    throw error;
  }
}

/** The preview picture of an STL whose source open() streams, size bytes long. */
export async function stlPreviewOutputs(
  target: SlicerTarget,
  open: () => Promise<Readable>,
  size: number,
): Promise<RenderOutput[]> {
  if (size > LIMITS.stlBodyBytes) throw new RenderFailed(DERIVED_MESSAGES.stlTooLarge);
  return postPreview(target, await open(), DERIVED_MESSAGES.stlTooLarge);
}

/** What a STEP file's preview is made from, and how its memory is gated. */
export interface MeshPreviewInput {
  /** The stored mesh's size in bytes, from its blob row; null when the row has none. */
  size: number | null;
  /** Reads the whole stored mesh. */
  read: () => Promise<Buffer>;
  /**
   * Runs task, the part that holds the mesh in memory, under the memory gate
   * (memory/gate.ts, memoryGate), resolving with its result.
   */
  hold: <T>(task: () => Promise<T>) => Promise<T>;
  /** TMP_DIR: the STL is written to a folder of its own here while it is sent. */
  tmpDir: string;
  /** The largest STL that may be sent: the contract's, unless a test sets a smaller one. */
  limit?: number;
}

/** The preview picture of a STEP file, from its stored GLB mesh (see the file comment). */
export async function meshPreviewOutputs(
  target: SlicerTarget,
  input: MeshPreviewInput,
): Promise<RenderOutput[]> {
  const limit = input.limit ?? LIMITS.stlBodyBytes;
  if (input.size === null) {
    throw new RenderFailed(
      `${DERIVED_MESSAGES.previewFailed} The mesh's size is not recorded, so it cannot be checked before it is read.`,
    );
  }
  if (input.size > PREVIEW_MESH_MAX_BYTES) {
    throw new RenderFailed(
      `${DERIVED_MESSAGES.previewFailed} The mesh is too large to preview: ${Math.ceil(input.size / MIB)} MiB, over the ${Math.floor(PREVIEW_MESH_MAX_BYTES / MIB)} MiB a preview reads.`,
    );
  }
  const dir = await mkdtemp(join(input.tmpDir, "step-preview-"));
  try {
    const path = join(dir, "mesh.stl");
    const tooLarge = await input.hold(async () => {
      let stl: ReturnType<typeof stlFromGlb>;
      try {
        stl = stlFromGlb(await input.read());
      } catch (error) {
        if (error instanceof MeshUnreadable) {
          throw new RenderFailed(
            `${DERIVED_MESSAGES.previewFailed} The mesh could not be read: ${error.message}.`,
          );
        }
        throw error;
      }
      const message = `${DERIVED_MESSAGES.previewFailed} The mesh is too large to preview: ${Math.ceil(stl.size / MIB)} MiB as an STL, over the ${Math.floor(limit / MIB)} MiB the renderer takes.`;
      if (stl.size > limit) throw new RenderFailed(message);
      await pipeline(stl.open(), createWriteStream(path));
      return message;
    });
    return await postPreview(target, createReadStream(path), tooLarge);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
