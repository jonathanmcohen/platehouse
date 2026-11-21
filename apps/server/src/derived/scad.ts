// OpenSCAD renders (AC-052): the .scad source goes to the slicer's
// /v1/scad/stl and then /v1/scad/png, where OpenSCAD renders it in the
// sandbox. Both come back before anything is stored, so a render error or a
// lost connection on the preview stores nothing. A source over the
// contract's 1 MiB limit is refused here and never sent.
import { LIMITS } from "@platehouse/slicer-contract";
import {
  DERIVED_MESSAGES,
  postRender,
  RenderFailed,
  type RenderOutput,
  type SlicerTarget,
} from "./client.js";

const SCAD_CONTENT_TYPE = "text/plain; charset=utf-8";

const OUTPUTS = [
  { route: "/v1/scad/stl", kind: "render_stl", contentType: "model/stl" },
  { route: "/v1/scad/png", kind: "render_png", contentType: "image/png" },
] as const;

/** The STL and the PNG preview OpenSCAD renders from the source read() returns, size bytes long. */
export async function renderScadOutputs(
  target: SlicerTarget,
  size: number,
  read: () => Promise<Buffer>,
): Promise<RenderOutput[]> {
  if (size > LIMITS.scadBodyBytes) throw new RenderFailed(DERIVED_MESSAGES.scadTooLarge);
  const source = await read();
  if (source.length > LIMITS.scadBodyBytes) throw new RenderFailed(DERIVED_MESSAGES.scadTooLarge);
  const outputs: RenderOutput[] = [];
  for (const out of OUTPUTS) {
    const bytes = await postRender(target, {
      route: out.route,
      body: source,
      contentType: SCAD_CONTENT_TYPE,
      accept: out.contentType,
      refusal: "render",
      tooLarge: DERIVED_MESSAGES.scadTooLarge,
    });
    outputs.push({ kind: out.kind, contentType: out.contentType, bytes });
  }
  return outputs;
}
