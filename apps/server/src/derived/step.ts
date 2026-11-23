// STEP meshes for the 3D viewer, converted on the server so no browser ever
// parses a STEP file: the STEP source is streamed from the
// bucket to the slicer's /v1/step/glb, where occt-import-js converts it, and
// the GLB that comes back is the only thing a browser loads for a STEP file.
// A source over the contract's 256 MiB limit is refused here and never sent.
// The GLB is streamed to a file in the job's folder, dir, under the
// contract's stepOutputBytes (postRender), never held in memory.
import { join } from "node:path";
import type { Readable } from "node:stream";
import { LIMITS } from "@platehouse/slicer-contract";
import {
  DERIVED_MESSAGES,
  postRender,
  RenderFailed,
  type RenderOutput,
  type SlicerTarget,
} from "./client.js";

const GLB = "model/gltf-binary";

/** The GLB mesh converted from the source that open() streams, size bytes long, as a file in dir. */
export async function convertStepOutputs(
  target: SlicerTarget,
  open: () => Promise<Readable>,
  size: number,
  dir: string,
): Promise<RenderOutput[]> {
  if (size > LIMITS.stepBodyBytes) throw new RenderFailed(DERIVED_MESSAGES.stepTooLarge);
  const answer = await postRender(target, {
    route: "/v1/step/glb",
    body: await open(),
    contentType: "application/octet-stream",
    accept: GLB,
    refusal: "convert",
    tooLarge: DERIVED_MESSAGES.stepTooLarge,
    answer: { path: join(dir, "mesh.glb") },
  });
  return [{ kind: "mesh_glb", contentType: GLB, ...answer }];
}
