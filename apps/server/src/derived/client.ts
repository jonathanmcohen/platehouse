// The app's side of the slicer's render routes (Slicer HTTP contract v1):
// POST /v1/scad/stl, /v1/scad/png and /v1/step/glb. One request per call and
// no retry here: what went wrong is reported as one of the errors below, and
// the job decides (derived.ts). A 409 busy or a lost connection is
// retryable, and pg-boss retries the job under its own settings
// (SLICER_RETRY); a 422 is the program's own answer and final.
import { Readable } from "node:stream";
import { slicerContract } from "@platehouse/slicer-contract";

/**
 * What files.derived_message holds when the slicer, not OpenSCAD or the STEP
 * converter, is why a file has no render. A render or conversion error
 * stores the program's own message instead.
 */
export const DERIVED_MESSAGES = {
  /** slicer_error: the slicer stayed busy or unreachable through every retry, or answered oddly. */
  slicerError: "The slicer could not render this file.",
  /** slicer_error on a replacement: the file keeps its previous source and renders. */
  replaceFailed: "The slicer could not render the replacement, so the previous version is kept.",
  /** The job could not be queued after the upload committed. */
  queueFailed: "The render could not be queued.",
  /** A .scad over the contract's 1 MiB limit is never sent. */
  scadTooLarge: "This .scad file is larger than the 1 MiB the renderer takes.",
  /** A STEP file over the contract's 256 MiB limit is never sent. */
  stepTooLarge: "This STEP file is larger than the 256 MiB the converter takes.",
} as const;

/**
 * How long one render request may take: the slicer's own time cap for a
 * render or a STEP conversion (SCAD_TIMEOUT_SECONDS and STEP_TIMEOUT_SECONDS,
 * both 120 s by default in apps/slicer), plus 30 s, as the plan sets the
 * app's slice timeout. Past it the request counts as a lost connection.
 */
export const RENDER_TIMEOUT_MS = (120 + 30) * 1000;

/** The slicer answered 409 busy: another heavy job holds its lock. Retryable. */
export class SlicerBusy extends Error {
  constructor(route: string) {
    super(`The slicer was busy (${route})`);
    this.name = "SlicerBusy";
  }
}

/** No answer: the connection failed or dropped, or the request timed out. Retryable. */
export class SlicerUnreachable extends Error {
  constructor(route: string, cause: unknown) {
    super(`The slicer could not be reached (${route})`, { cause });
    this.name = "SlicerUnreachable";
  }
}

/** An answer the contract does not allow for the route, or a 500. Not retried. */
export class SlicerFault extends Error {
  constructor(route: string, what: string) {
    super(`The slicer answered ${what} (${route})`);
    this.name = "SlicerFault";
  }
}

/**
 * The program refused the file: OpenSCAD's render error or the STEP
 * converter's, or a body over the route's limit. message is what the file
 * shows, kept exactly as the program wrote it.
 */
export class RenderFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenderFailed";
  }
}

/** True for the errors a pg-boss retry may cure: 409 busy and a lost connection. */
export function isRetryable(error: unknown): boolean {
  return error instanceof SlicerBusy || error instanceof SlicerUnreachable;
}

export interface SlicerTarget {
  /** SLICER_URL. */
  baseUrl: string;
  timeoutMs: number;
}

export interface RenderRequest {
  route: "/v1/scad/stl" | "/v1/scad/png" | "/v1/step/glb";
  body: Buffer | Readable;
  contentType: string;
  /** The content type a 200 must carry. */
  accept: string;
  /** Which 422 body the route answers with. */
  refusal: "render" | "convert";
  /** What a 413 too_large shows. */
  tooLarge: string;
}

function mediaType(header: string | null): string {
  return (header ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

/** Posts one body to a render route and returns the bytes of a 200. */
export async function postRender(target: SlicerTarget, req: RenderRequest): Promise<Buffer> {
  const url = new URL(req.route, target.baseUrl);
  const body =
    req.body instanceof Readable
      ? (Readable.toWeb(req.body) as ReadableStream<Uint8Array>)
      : new Uint8Array(req.body.buffer, req.body.byteOffset, req.body.byteLength);
  let status: number;
  let type: string;
  let bytes: Buffer;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": req.contentType },
      body,
      duplex: "half",
      signal: AbortSignal.timeout(target.timeoutMs),
    });
    status = res.status;
    type = mediaType(res.headers.get("content-type"));
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (error) {
    throw new SlicerUnreachable(req.route, error);
  } finally {
    if (req.body instanceof Readable) req.body.destroy();
  }

  switch (status) {
    case 200:
      if (type !== req.accept || bytes.length === 0) {
        throw new SlicerFault(req.route, `200 with ${type || "no content type"}`);
      }
      return bytes;
    case 409:
      throw new SlicerBusy(req.route);
    case 413:
      throw new RenderFailed(req.tooLarge);
    case 422: {
      let parsed: unknown;
      try {
        parsed = JSON.parse(bytes.toString("utf8"));
      } catch {
        throw new SlicerFault(req.route, "422 with a body that is not JSON");
      }
      const schema =
        req.refusal === "render" ? slicerContract.renderError : slicerContract.convertError;
      const refusal = schema.safeParse(parsed);
      if (!refusal.success) throw new SlicerFault(req.route, "422 outside the contract");
      throw new RenderFailed(refusal.data.message);
    }
    default:
      throw new SlicerFault(req.route, String(status));
  }
}

/** One derived blob's bytes, before they are stored. */
export interface RenderOutput {
  kind: "render_stl" | "render_png" | "mesh_glb";
  contentType: string;
  bytes: Buffer;
}
