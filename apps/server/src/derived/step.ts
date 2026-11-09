// STEP meshes (AC-050, decision 2): the STEP source is streamed from the
// bucket to the slicer's /v1/step/glb, where occt-import-js converts it, and
// the GLB that comes back is the only thing a browser loads for a STEP file.
// A source over the contract's 256 MiB limit is refused here and never sent.
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

/** The GLB mesh converted from the source that open() streams, size bytes long. */
export async function convertStepOutputs(
  target: SlicerTarget,
  open: () => Promise<Readable>,
  size: number,
): Promise<RenderOutput[]> {
  if (size > LIMITS.stepBodyBytes) throw new RenderFailed(DERIVED_MESSAGES.stepTooLarge);
  const bytes = await postRender(target, {
    route: "/v1/step/glb",
    body: await open(),
    contentType: "application/octet-stream",
    accept: GLB,
    refusal: "convert",
    tooLarge: DERIVED_MESSAGES.stepTooLarge,
  });
  return [{ kind: "mesh_glb", contentType: GLB, bytes }];
}
