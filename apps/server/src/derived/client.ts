// The app's side of the slicer's render routes (Slicer HTTP contract v1):
// POST /v1/scad/stl, /v1/scad/png and /v1/step/glb. One request per call and
// no retry here: what went wrong is reported as one of the errors below, and
// the job decides (derived.ts). A 409 busy or a lost connection is
// retryable, and pg-boss retries the job under its own settings
// (SLICER_RETRY); a 422 is the program's own answer and final. A slicer
// that takes no connection, or answers that OpenSCAD renders are off
// because its sandbox self-test failed, is SlicerDown: not the file's
// doing, so the job waits for the slicer without using a retry, for up to
// 2 hours (SLICER_DOWN_LIMIT_MS in derived.ts). A streamed body that fails
// partway (the store went away while a STEP file was read from it) rejects
// with the body's own error, a StoreUnavailable for an outage or a
// StoreError for a store that refused, never as a lost slicer connection.
import { Readable } from "node:stream";
import { slicerContract } from "@platehouse/slicer-contract";

/**
 * The sentence that says the renders a file shows are from an earlier
 * source than its own, for a .scad (STL and preview) and a STEP file
 * (mesh). It is written here once: previousRendersScad and
 * previousRendersStep below add the lead-in to the program's own words,
 * and derived.ts puts it, without a lead-in, before a later failure's
 * message while those renders are still shown (issue #104). It names the
 * file's own source "the current version" and the renders' source "an
 * earlier version", and the replace* messages say a dropped replacement
 * "was not saved", so a message that joins the two never uses one name
 * for two different uploads (issue #127).
 */
export const PREVIOUS_RENDERS_SENTENCE = {
  scad: "OpenSCAD rejected the current version of this file, so the STL and preview shown are from an earlier version.",
  step: "The STEP converter rejected the current version of this file, so the mesh shown is from an earlier version.",
} as const;

/**
 * What files.derived_message holds when the slicer or the store, not
 * OpenSCAD or the STEP converter, is why a file has no render. A render or
 * conversion error stores the program's own message instead, after
 * previousRendersScad or previousRendersStep when the renders the file
 * still shows are from an earlier source.
 */
export const DERIVED_MESSAGES = {
  /** slicer_error: the slicer stayed busy or unreachable through every retry, or answered oddly. */
  slicerError: "The slicer could not render this file.",
  /** slicer_error on a replacement: the file keeps its previous source and renders. */
  replaceFailed: "The slicer could not render the replacement, so it was not saved.",
  /** The slicer stayed down (SlicerDown) for more than 2 hours, so the job stopped waiting. */
  slicerDown: "The slicer is not answering. The render will need to be started again.",
  /** The same, for a replacement: its staged source is discarded and the previous version kept. */
  replaceSlicerDown:
    "The slicer is not answering, so the replacement was not saved. It will need to be sent again.",
  /** The store stayed unreachable (StoreUnavailable) for more than 2 hours, so the job stopped waiting. */
  storeDown: "Storage is not answering. The render will need to be started again.",
  /** The same, for a replacement: its staged source is discarded and the previous version kept. */
  replaceStoreDown:
    "Storage is not answering, so the replacement was not saved. It will need to be sent again.",
  /**
   * The store answered and refused (StoreError: an HTTP 500, AccessDenied,
   * NoSuchBucket, a body that failed with no network code), or the source
   * object is gone (BlobNotFound), so the job stopped.
   */
  storeRefused: "Storage refused this file, so the render could not finish.",
  /** The same, for a replacement: its staged source is discarded and the previous version kept. */
  replaceStoreRefused: "Storage refused the replacement, so it was not saved.",
  /** The job could not be queued after the upload committed. */
  queueFailed: "The render could not be queued.",
  /** The render check found the job's last attempt ended without an outcome. */
  renderLost: "The render did not finish.",
  /** The same, for a replacement: the file keeps its previous source and renders. */
  replaceLost: "The render of the replacement did not finish, so it was not saved.",
  /**
   * Put before OpenSCAD's own message when it rejects the file's source
   * while the file still shows an STL and preview rendered from an earlier
   * source (a replacement OpenSCAD rejected becomes the source, and the
   * previous version's renders stay until a render succeeds; issue #103).
   */
  previousRendersScad: `${PREVIOUS_RENDERS_SENTENCE.scad} OpenSCAD said:`,
  /** The same, before the STEP converter's own message, for a mesh from an earlier source. */
  previousRendersStep: `${PREVIOUS_RENDERS_SENTENCE.step} The converter said:`,
  /** A .scad over the contract's 1 MiB limit is never sent. */
  scadTooLarge: "This .scad file is larger than the 1 MiB the renderer takes.",
  /** A STEP file over the contract's 256 MiB limit is never sent. */
  stepTooLarge: "This STEP file is larger than the 256 MiB the converter takes.",
} as const;

/**
 * How long a render request may wait for its answer once its body is sent:
 * the slicer's own time cap for a render or a STEP conversion
 * (SCAD_TIMEOUT_SECONDS and STEP_TIMEOUT_SECONDS, both 120 s by default in
 * apps/slicer), plus 30 s, as the plan sets the app's slice timeout. Past it
 * the request counts as a lost connection.
 */
export const RENDER_TIMEOUT_MS = (120 + 30) * 1000;

/**
 * How long a streamed body (a STEP file, up to 256 MiB, read from the bucket
 * as it is sent) may take to send: the slicer's own allowance for a body,
 * UPLOAD_SECONDS in apps/slicer/src/server.ts. RENDER_TIMEOUT_MS starts only
 * once the body has been read to its end, so a slow bucket does not eat the
 * program's time; a body that stalls past this counts as a lost connection.
 * Both together, 750 s, fit inside pg-boss's default 15-minute job expiry. A
 * .scad body is at most 1 MiB and in memory, so it gets RENDER_TIMEOUT_MS
 * alone.
 */
export const RENDER_UPLOAD_TIMEOUT_MS = 600 * 1000;

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

/**
 * The start of the 422 render_failed message the slicer sends when its
 * OpenSCAD sandbox self-test failed (apps/slicer/src/server.ts): renders are
 * off on the slicer, which says nothing about the file. Contract v1 gives
 * it no error code of its own, so the message is matched; a test pins it to
 * the slicer's source.
 */
export const SANDBOX_OFF_PREFIX = "OpenSCAD renders are off:";

/**
 * The network codes that mean no connection was made at all: the slicer is
 * stopped, restarting or not on the network, and never saw the request.
 * The same set as Task 12's (estimates/client.ts).
 */
const NO_CONNECTION_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "ENETUNREACH",
  "ENETDOWN",
]);

/** The no-connection code in a fetch rejection or its causes, if there is one. */
function noConnectionCode(error: unknown): string | undefined {
  let e: unknown = error;
  for (let depth = 0; depth < 5 && e instanceof Error; depth += 1) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && NO_CONNECTION_CODES.has(code)) return code;
    e = e.cause;
  }
  return undefined;
}

/**
 * The slicer cannot render right now, and the file is not why: it took no
 * connection (stopped, restarting or being re-pulled), or it answered that
 * OpenSCAD renders are off because its sandbox self-test failed. Not a
 * pg-boss retry: the job waits for the slicer without using one, for up to
 * 2 hours (runJob).
 */
export class SlicerDown extends Error {
  constructor(route: string, detail: string) {
    super(`The slicer cannot render now (${route}): ${detail}`);
    this.name = "SlicerDown";
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
  /** The wait for an answer once the body is sent (RENDER_TIMEOUT_MS). */
  timeoutMs: number;
  /** The time a streamed body may take to send (RENDER_UPLOAD_TIMEOUT_MS). */
  uploadTimeoutMs: number;
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

/**
 * A web stream over a streamed body that tells onError when reading the body
 * itself fails, and not when the request gives up on the body (a timer, or
 * the slicer dropping the connection cancels it), so a store that went away
 * partway is told apart from a lost slicer connection.
 */
function webBody(source: Readable, onError: (error: unknown) => void): ReadableStream<Uint8Array> {
  const chunks = source[Symbol.asyncIterator]();
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let next: IteratorResult<unknown>;
      try {
        next = await chunks.next();
      } catch (error) {
        if (!cancelled) onError(error);
        throw error;
      }
      if (next.done) controller.close();
      else
        controller.enqueue(
          Buffer.isBuffer(next.value) ? next.value : Buffer.from(String(next.value)),
        );
    },
    cancel() {
      cancelled = true;
      source.destroy();
    },
  });
}

/**
 * Posts one body to a render route and returns the bytes of a 200. A
 * streamed body that fails while it is read rejects with that failure as it
 * is (see webBody); every other failure to get an answer is SlicerDown or
 * SlicerUnreachable.
 */
export async function postRender(target: SlicerTarget, req: RenderRequest): Promise<Buffer> {
  const url = new URL(req.route, target.baseUrl);
  let bodyError: { error: unknown } | undefined;
  const body =
    req.body instanceof Readable
      ? webBody(req.body, (error) => {
          bodyError ??= { error };
        })
      : new Uint8Array(req.body.buffer, req.body.byteOffset, req.body.byteLength);
  // Two timers, one after the other: the upload allowance while a streamed
  // body is read, then the program's time once it has ended.
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let settled = false;
  const arm = (ms: number, what: string): void => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error(`${what} within ${ms} ms`)), ms);
  };
  const answerTimer = (): void => {
    if (!settled) arm(target.timeoutMs, "no answer");
  };
  if (req.body instanceof Readable) {
    arm(target.uploadTimeoutMs, "the body was not sent");
    req.body.once("end", answerTimer);
  } else {
    answerTimer();
  }
  let status: number;
  let type: string;
  let bytes: Buffer;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": req.contentType },
      body,
      duplex: "half",
      signal: controller.signal,
    });
    status = res.status;
    type = mediaType(res.headers.get("content-type"));
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (error) {
    // The body failed, not the slicer: its own error, so a store outage
    // reaches the job as StoreUnavailable and the job waits for the store.
    if (bodyError !== undefined) throw bodyError.error;
    const code = noConnectionCode(error);
    if (code !== undefined) throw new SlicerDown(req.route, `no connection (${code})`);
    throw new SlicerUnreachable(req.route, error);
  } finally {
    settled = true;
    clearTimeout(timer);
    if (req.body instanceof Readable) {
      req.body.off("end", answerTimer);
      req.body.destroy();
    }
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
      if (req.refusal === "render" && refusal.data.message.startsWith(SANDBOX_OFF_PREFIX)) {
        throw new SlicerDown(req.route, refusal.data.message);
      }
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
