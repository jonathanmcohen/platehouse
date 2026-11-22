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
// A failure the file should show starts with Platehouse's own sentence
// (DERIVED_MESSAGES.previewFailed, or previewRejected before OpenSCAD's own
// words), so the page can say it in its language. Everything else (busy, a
// lost connection, a slicer that is down or older than this app) comes from
// postRender as it does for every render, and the job decides (derived.ts).
import type { Readable } from "node:stream";
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

/**
 * The preview picture of a STEP file, from the GLB mesh readGlb returns.
 * limit is the largest STL that may be sent: the contract's, unless a test
 * sets a smaller one.
 */
export async function meshPreviewOutputs(
  target: SlicerTarget,
  readGlb: () => Promise<Buffer>,
  limit: number = LIMITS.stlBodyBytes,
): Promise<RenderOutput[]> {
  let stl: ReturnType<typeof stlFromGlb>;
  try {
    stl = stlFromGlb(await readGlb());
  } catch (error) {
    if (error instanceof MeshUnreadable) {
      throw new RenderFailed(
        `${DERIVED_MESSAGES.previewFailed} The mesh could not be read: ${error.message}.`,
      );
    }
    throw error;
  }
  const tooLarge = `${DERIVED_MESSAGES.previewFailed} The mesh is too large to preview: ${Math.ceil(stl.size / MIB)} MiB as an STL, over the ${Math.floor(limit / MIB)} MiB the renderer takes.`;
  if (stl.size > limit) throw new RenderFailed(tooLarge);
  return postPreview(target, stl.open(), tooLarge);
}
