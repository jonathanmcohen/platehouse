// The app's side of the slicer's render routes (Slicer HTTP contract v1):
// POST /v1/scad/stl, /v1/scad/png, /v1/step/glb and, for STL and STEP
// preview pictures (issue #316), /v1/stl/png. One request per call and
// no retry here: what went wrong is reported as one of the errors below, and
// the job decides (derived.ts). A 409 busy or a lost connection is
// retryable, and pg-boss retries the job under its own settings
// (SLICER_RETRY); a 422 is the program's own answer and final. A slicer
// that takes no connection, or answers 404 because its image is older
// than this app and lacks the route, is SlicerDown: not the file's
// doing, so the job waits for the slicer without using a retry, for up to
// 2 hours (SLICER_DOWN_LIMIT_MS in derived.ts). A 503 sandbox_off is
// SandboxOff: the slicer's sandbox is off, which the job records once with
// its reason instead of waiting. A streamed body that fails
// partway (the store went away while a STEP file was read from it) rejects
// with the body's own error, a StoreUnavailable for an outage or a
// StoreError for a store that refused, never as a lost slicer connection.
import { open, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { LIMITS, type SandboxOffBody, slicerContract } from "@platehouse/slicer-contract";

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
 * What the slicer answers, as a 422 render_failed, for a body that is not an
 * STL with at least one triangle (NOT_AN_STL in apps/slicer/src/scad.ts; a
 * test pins the two together). The slicer sends it before OpenSCAD runs.
 */
export const SLICER_NOT_AN_STL =
  "The file is not an STL with at least one triangle, so there is nothing to render.";

/** The sentence that starts every failed preview picture's message (issue #316). */
const PREVIEW_FAILED = "The preview picture could not be rendered.";

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
  /**
   * An STL's or a STEP mesh's preview picture could not be made (issue
   * #316), followed by why: the mesh could not be read, or was too large.
   * A STEP file keeps its mesh and 3D view.
   */
  previewFailed: PREVIEW_FAILED,
  /** The same, before OpenSCAD's own message when it rejects the STL. */
  previewRejected: `${PREVIEW_FAILED} OpenSCAD said:`,
  /**
   * A preview picture whose slicer stayed down past SLICER_DOWN_LIMIT_MS
   * (issue #379): the preview backfill tries it again by itself, so it says
   * so rather than asking for something the user cannot do.
   */
  previewSlicerDown:
    "The slicer is not answering, so the preview picture could not be made. It will be tried again automatically.",
  /** The same, for storage that stayed down. */
  previewStoreDown:
    "Storage is not answering, so the preview picture could not be made. It will be tried again automatically.",
  /** A preview picture whose job could not be queued; the backfill queues it again. */
  previewQueueFailed:
    "The preview picture could not be queued. It will be tried again automatically.",
  /**
   * A preview picture whose job could not write in its own temp folder
   * (TempFileError: a full disk, a read-only or missing TMP_DIR) on its
   * last attempt (issue #415). The backfill queues it again.
   */
  previewTempFailed:
    "Platehouse could not write a temporary file; it will be tried again automatically.",
  /**
   * The slicer's sandbox is off (HTTP 503 sandbox_off), so it refuses
   * pictures and OpenSCAD renders: its kernel is too old, or its check
   * failed. Recorded once with the real reason; the file is queued again
   * when the slicer says the sandbox is on (requeueSandboxOff).
   */
  sandboxOffKernel:
    "Pictures and OpenSCAD renders are off on this server: its kernel is older than Linux 6.12.",
  sandboxOffCheck:
    "Pictures and OpenSCAD renders are off on this server: its sandbox check failed.",
  /** The same for a STEP conversion, which can also run unsandboxed when the slicer allows it. */
  convertSandboxOffKernel:
    "STEP previews are off on this server: its kernel is older than Linux 6.12.",
  convertSandboxOffCheck: "STEP previews are off on this server: its sandbox check failed.",
  /** An STL over the contract's 256 MiB limit is never sent, and has no preview. */
  stlTooLarge:
    "This STL file is larger than the 256 MiB the preview renderer takes, so it has no preview picture.",
} as const;

/**
 * Every sentence Platehouse writes into files.derived_message, by the code
 * the app API sends it under (the maintainer, 2026-11-19): DERIVED_MESSAGES' own keys,
 * and previousScad and previousStep for PREVIOUS_RENDERS_SENTENCE, which
 * stands alone while a new render is pending.
 */
export const DERIVED_SENTENCES: Readonly<Record<string, string>> = Object.freeze({
  ...DERIVED_MESSAGES,
  previousScad: PREVIOUS_RENDERS_SENTENCE.scad,
  previousStep: PREVIOUS_RENDERS_SENTENCE.step,
});

/** The sentences longest first, so "... OpenSCAD said:" wins over the sentence it starts with. */
const BY_LENGTH = Object.entries(DERIVED_SENTENCES).sort((a, b) => b[1].length - a[1].length);

/**
 * A stored message split into Platehouse's own sentences at its start, by
 * code, and what follows them (the program's own words), so the page can
 * write the sentences in its language. A message whose start is no known
 * sentence (one cut short at its start by the scrub's length limit, or an
 * older wording) gives no codes, and the page shows it as it is. The codes
 * and the detail joined with spaces give back the message.
 */
export function splitDerivedMessage(message: string): { codes: string[]; detail: string | null } {
  const codes: string[] = [];
  let rest = message;
  for (;;) {
    const hit = BY_LENGTH.find(([, text]) => rest === text || rest.startsWith(`${text} `));
    if (hit === undefined) break;
    codes.push(hit[0]);
    rest = rest.slice(hit[1].length).replace(/^ /, "");
    if (rest === "") break;
  }
  return { codes, detail: rest === "" ? null : rest };
}

/** derivedCodes and derivedDetail for an app API answer (no codes for no message). */
export function derivedParts(message: string | null): {
  derivedCodes: string[];
  derivedDetail: string | null;
} {
  if (message === null) return { derivedCodes: [], derivedDetail: null };
  const { codes, detail } = splitDerivedMessage(message);
  return codes.length === 0
    ? { derivedCodes: [], derivedDetail: null }
    : { derivedCodes: codes, derivedDetail: detail };
}

/**
 * How long a render request may wait for its answer once its body is sent:
 * the slicer's own time cap for a render or a STEP conversion
 * (SCAD_TIMEOUT_SECONDS and STEP_TIMEOUT_SECONDS, both 120 s by default in
 * apps/slicer), plus 30 s, the same margin the app's slice timeout uses. Past it
 * the request counts as a lost connection.
 */
export const RENDER_TIMEOUT_MS = (120 + 30) * 1000;

/**
 * How long a streamed body (a STEP file, up to 256 MiB, read from the bucket
 * as it is sent) may take to send: the slicer's own allowance for a body,
 * UPLOAD_SECONDS in apps/slicer/src/server.ts. RENDER_TIMEOUT_MS starts only
 * once the body has been read to its end, so a slow bucket does not eat the
 * program's time; a body that stalls past this counts as a lost connection.
 * Both together are 750 s. A .scad body is at most 1 MiB and in memory, so it
 * gets RENDER_TIMEOUT_MS alone.
 */
export const RENDER_UPLOAD_TIMEOUT_MS = 600 * 1000;

/**
 * How long a STEP conversion job may run before pg-boss expires it: the
 * conversion's own budget (RENDER_UPLOAD_TIMEOUT_MS plus RENDER_TIMEOUT_MS,
 * 750 s) and 300 s more to store the GLB in the bucket afterwards, 1050 s in
 * all. Under pg-boss's default, 15 minutes, a slow bucket could have a job
 * that had already stored its mesh expired and run again. Each conversion
 * job is sent with it (slicerSendOptions in derived.ts), since the slicer
 * queue's other jobs keep their own expiry.
 */
export const CONVERT_EXPIRE_SECONDS = (RENDER_UPLOAD_TIMEOUT_MS + RENDER_TIMEOUT_MS) / 1000 + 300;

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
 * The slicer answered 503 sandbox_off: its sandbox is off, so it refuses
 * this route, and says why. Says nothing about the file. Not retried and
 * not an outage: the job records sandboxMessage once, and the file is
 * queued again when the sandbox is on.
 */
export class SandboxOff extends Error {
  readonly reason: SandboxOffBody["reason"];

  constructor(route: string, reason: SandboxOffBody["reason"]) {
    super(`The slicer's sandbox is off (${route}): ${reason}`);
    this.name = "SandboxOff";
    this.reason = reason;
  }
}

/**
 * The message a file shows when the sandbox is off, by the kind of job
 * refused: a picture of an STL or STEP mesh ("preview"), an OpenSCAD render
 * and an STL's picture share one pair, a STEP conversion has its own.
 */
export function sandboxMessage(
  kind: "scad" | "step" | "stl" | "preview",
  reason: SandboxOffBody["reason"],
): string {
  if (kind === "step") {
    return reason === "old_kernel"
      ? DERIVED_MESSAGES.convertSandboxOffKernel
      : DERIVED_MESSAGES.convertSandboxOffCheck;
  }
  return reason === "old_kernel"
    ? DERIVED_MESSAGES.sandboxOffKernel
    : DERIVED_MESSAGES.sandboxOffCheck;
}

/**
 * The network codes that mean no connection was made at all: the slicer is
 * stopped, restarting or not on the network, and never saw the request.
 * The same set the estimate client uses (estimates/client.ts).
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
 * connection (stopped, restarting or being re-pulled), or it has no such
 * route (an image older than this app). Not a
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

const MIB = 1024 * 1024;

/**
 * The slicer's answer passed its route's cap (ANSWER_LIMITS) while it was
 * streamed: it was not kept, and the job fails as for any answer the
 * program refused (render_failed). The contract says the slicer never
 * sends one (it refuses such an output with its own 422 first), so this is
 * an older or misbehaving slicer.
 */
export class AnswerTooLarge extends RenderFailed {
  constructor(maxBytes: number) {
    super(
      `The slicer's answer was over the ${Math.floor(maxBytes / MIB)} MiB limit for it, so it was not kept.`,
    );
    this.name = "AnswerTooLarge";
  }
}

/**
 * The largest answer each render route may send, from the slicer contract:
 * the answer is streamed to a temp file and stopped as soon as it passes
 * this, so no answer is ever held whole in the app's memory.
 */
export const ANSWER_LIMITS = Object.freeze({
  "/v1/scad/stl": LIMITS.renderOutputBytes,
  "/v1/scad/png": LIMITS.renderOutputBytes,
  "/v1/stl/png": LIMITS.renderOutputBytes,
  "/v1/step/glb": LIMITS.stepOutputBytes,
});

/**
 * The most of an error answer (any status but a 200) read into memory: 64
 * KiB. The slicer's refusals are short JSON, its 500s short text; a longer
 * one is a fault, and the rest is never read.
 */
export const ERROR_ANSWER_MAX_BYTES = 64 * 1024;

/**
 * The job could not write in its own temp folder (issue #415): making the
 * folder, writing a STEP preview's STL there, or opening or writing the
 * slicer's answer file. cause is the file system's own error. Neither the
 * file's fault nor the slicer's, so it is told apart from both; reading
 * from the store is never one.
 */
export class TempFileError extends Error {
  override readonly cause: NodeJS.ErrnoException;

  constructor(cause: unknown) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    super(`A temporary file could not be written: ${error.message}`, { cause: error });
    this.name = "TempFileError";
    this.cause = error;
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
  route: keyof typeof ANSWER_LIMITS;
  body: Buffer | Readable;
  contentType: string;
  /** The content type a 200 must carry. */
  accept: string;
  /** Which 422 body the route answers with. */
  refusal: "render" | "convert";
  /** What a 413 too_large shows. */
  tooLarge: string;
  /**
   * Where a 200's body is streamed (a file in the job's temp folder; it is
   * removed if the request fails), and the most it may be: the route's
   * ANSWER_LIMITS unless a test sets a smaller one.
   */
  answer: { path: string; maxBytes?: number };
}

/** A 200's body, streamed to a file. */
export interface RenderAnswer {
  path: string;
  size: number;
}

/**
 * Reads at most max bytes of an error answer into memory; a longer one is
 * the slicer's fault, and the rest of it is never read.
 */
async function readSmall(
  body: ReadableStream<Uint8Array> | null,
  max: number,
  route: string,
  status: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  if (body === null) return Buffer.alloc(0);
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > max) throw new SlicerFault(route, `${status} with a body over ${max} bytes`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Streams a 200's body to path a chunk at a time, stopping with
 * AnswerTooLarge as soon as it passes max; stopping cancels the body, so the
 * rest is never read. A failure to open or write the file is a
 * TempFileError, reported to onFileError before it is thrown, so it is told
 * apart from the connection failing, which comes from reading the body and
 * is thrown as it is.
 */
async function saveAnswer(
  body: ReadableStream<Uint8Array> | null,
  path: string,
  max: number,
  onFileError: (error: unknown) => void,
): Promise<number> {
  const onFile = async <T>(op: () => Promise<T>): Promise<T> => {
    try {
      return await op();
    } catch (error) {
      const failed = new TempFileError(error);
      onFileError(failed);
      throw failed;
    }
  };
  const file = await onFile(() => open(path, "w"));
  let size = 0;
  try {
    if (body !== null) {
      for await (const chunk of body) {
        size += chunk.byteLength;
        if (size > max) throw new AnswerTooLarge(max);
        // A write may take fewer bytes than it is given, so the rest of the
        // chunk is written until none is left.
        for (let at = 0; at < chunk.byteLength; ) {
          const { bytesWritten } = await onFile(() => file.write(chunk, at, chunk.byteLength - at));
          if (bytesWritten <= 0) {
            const error = new TempFileError(new Error(`no bytes written to ${path}`));
            onFileError(error);
            throw error;
          }
          at += bytesWritten;
        }
      }
    }
  } finally {
    await file.close().catch(() => undefined);
  }
  return size;
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
 * Posts one body to a render route and streams a 200's body to
 * req.answer.path, never holding it in memory, stopping with AnswerTooLarge
 * as soon as it passes the route's cap (ANSWER_LIMITS). Any other answer is
 * read into memory only up to ERROR_ANSWER_MAX_BYTES. A streamed request
 * body that fails while it is read rejects with that failure as it is (see
 * webBody), a temp file that cannot be written with TempFileError, holding
 * the file system's own error; every other failure to get an answer is
 * SlicerDown or SlicerUnreachable. Whenever it rejects, the answer file is
 * removed.
 */
export async function postRender(target: SlicerTarget, req: RenderRequest): Promise<RenderAnswer> {
  const path = req.answer.path;
  try {
    return await postRenderTo(target, req, path);
  } catch (error) {
    await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function postRenderTo(
  target: SlicerTarget,
  req: RenderRequest,
  path: string,
): Promise<RenderAnswer> {
  const maxBytes = req.answer.maxBytes ?? ANSWER_LIMITS[req.route];
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
  // A 200 of the right type is streamed to the answer file (size), anything
  // else read into memory up to ERROR_ANSWER_MAX_BYTES (bytes), or not read
  // at all when its status says enough.
  let size = 0;
  let bytes: Buffer = Buffer.alloc(0);
  let fileError: { error: unknown } | undefined;
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
    if (status === 200 && type === req.accept) {
      size = await saveAnswer(res.body, path, maxBytes, (error) => {
        fileError ??= { error };
      });
    } else if (status === 200 || KNOWN.has(status)) {
      // A 200 of the wrong type is a fault whatever it holds, and 409, 404
      // and 413 say all they mean in their status: none is read.
      await res.body?.cancel();
    } else {
      bytes = await readSmall(res.body, ERROR_ANSWER_MAX_BYTES, req.route, status);
    }
  } catch (error) {
    // Decided here, not a connection failure: an answer over its cap, an
    // error answer over its limit, or a temp file that cannot be written.
    if (error instanceof AnswerTooLarge || error instanceof SlicerFault) throw error;
    if (fileError !== undefined) throw fileError.error;
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
      if (type !== req.accept || size === 0) {
        throw new SlicerFault(req.route, `200 with ${type || "no content type"}`);
      }
      return { path, size };
    case 409:
      throw new SlicerBusy(req.route);
    // A slicer image older than this app has no such route (/v1/stl/png is
    // new in contract 1 with issue #316) and answers 404 not_found. That says
    // nothing about the file, so the job waits for the slicer as for one
    // that is down, until the image is updated or the wait runs out.
    case 404:
      throw new SlicerDown(
        req.route,
        "the slicer has no such route; its image is older than this app",
      );
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
    case 503: {
      let parsed: unknown;
      try {
        parsed = JSON.parse(bytes.toString("utf8"));
      } catch {
        throw new SlicerFault(req.route, "503 with a body that is not JSON");
      }
      const off = slicerContract.sandboxOff.safeParse(parsed);
      if (!off.success) throw new SlicerFault(req.route, "503 outside the contract");
      throw new SandboxOff(req.route, off.data.reason);
    }
    default:
      throw new SlicerFault(req.route, String(status));
  }
}

/**
 * The statuses whose answer says enough without its body: 409 busy, 404
 * (an older slicer image), 413 too_large. Their bodies are never read.
 */
const KNOWN: ReadonlySet<number> = new Set([409, 404, 413]);

/**
 * One derived blob before it is stored: the slicer's answer, in a file in
 * the job's temp folder (postRender), stored from the file and removed with
 * the folder when the job ends.
 */
export interface RenderOutput {
  kind: "render_stl" | "render_png" | "mesh_glb";
  contentType: string;
  path: string;
  size: number;
}
