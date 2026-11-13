// Uploads through Task 9's tus endpoint (build plan Task 19, AC-020), with
// tus-js-client:
//
// - Every file goes to /app/uploads (session-class; the browser sends the
//   session cookie and Origin, which the gate checks) in 5 MiB chunks, so a
//   phone that loses its connection resends at most one chunk.
// - The metadata names the target (the Public API v1 contract): nothing for
//   a new model of its own, modelId for an existing model, or batch with
//   combine for the "Combine into one model" batch.
// - tus-js-client keeps a resume fingerprint in localStorage, so a dropped
//   upload resumes when the same file is sent again. The fingerprint
//   includes the target, so the same file sent to a different target starts
//   a new upload instead of resuming the old one (Jon, 2026-11-09, issue
//   #77). A finished upload's fingerprint is removed too: Task 9 answers a
//   HEAD on an ingested upload as finished, so resuming it would store
//   nothing (uploads/tus.ts).
// - When the last byte is accepted, GET <upload>/result is polled until the
//   ingest is done or failed. Only a 503 (the server cannot read the result
//   now) or a lost connection is asked again; a 401 says the file was sent
//   but the session ended, and any other refusal (a 404 for an upload the
//   server no longer knows) says the upload could not be confirmed.
// - A file over the server's 512 MiB limit (MAX_UPLOAD_BYTES in
//   apps/server/src/uploads/tus.ts) is listed with the reason and never
//   sent, like a type Platehouse does not take. A refused or failed upload
//   shows plain words (failureMessage): a line for the status (an ended
//   session, a refusal, a server that cannot take it now), or the tus
//   handler's own one-line plain-text reason, never tus-js-client's
//   diagnostic text and never a JSON body such as the session gate's.
//
// useTusUpload holds one dialog's files and their progress; the start and
// result calls can be replaced, which the tests do.
import { useCallback, useEffect, useRef, useState } from "react";
import { type HttpResponse, Upload, type UploadOptions } from "tus-js-client";

/** Task 9's tus handler for the UI: the path on this page's own origin. */
export const UPLOAD_ENDPOINT = "/app/uploads";

/**
 * The endpoint as tus-js-client needs it: absolute, on the page's origin.
 * tus-js-client resolves the upload's Location with new URL(location,
 * endpoint), which throws for a relative endpoint.
 */
export function uploadEndpoint(): string {
  return new URL(UPLOAD_ENDPOINT, window.location.href).href;
}

/** The chunk tus-js-client sends per PATCH: 5 MiB. */
export const CHUNK_SIZE = 5 * 1024 * 1024;

/** The file types Platehouse takes (AC-020); anything else is refused (AC-024). */
export const SUPPORTED_EXTENSIONS: readonly string[] = [".3mf", ".stl", ".step", ".stp", ".scad"];

/** What the file input offers. */
export const ACCEPT = SUPPORTED_EXTENSIONS.join(",");

/** Shown on a row whose file is not a supported type; it is never sent. */
export const UNSUPPORTED_TEXT = "Not a supported file type: use .3mf, .stl, .step, .stp or .scad";

/** The largest file the server takes: 512 MiB (uploads/tus.ts MAX_UPLOAD_BYTES). */
export const MAX_UPLOAD_BYTES = 536_870_912;

/** Shown on a row whose file is over MAX_UPLOAD_BYTES; it is never sent. */
export const TOO_LARGE_TEXT = "The file is too large: Platehouse takes files up to 512 MiB";

/** Longest server reason shown as it is; a longer body gets the status line. */
const REASON_CHARS = 300;

/** Shown on a row whose upload the session gate refused with 401. */
export const SESSION_ENDED_TEXT = "Your session has ended. Sign in again, then add the file again.";

/** Whether a body parses as JSON (the session gate answers in JSON). */
function isJson(body: string): boolean {
  try {
    JSON.parse(body);
    return true;
  } catch {
    return false;
  }
}

/**
 * The server's own reason, when the body is one: text/plain (or no
 * Content-Type), one printable line of at most REASON_CHARS, and not JSON.
 * The tus handler's refusals are such lines; the session gate's answers are
 * JSON and a proxy's are HTML, and neither is shown.
 */
function plainReason(response: HttpResponse): string | undefined {
  const type = response.getHeader("content-type");
  if (type !== undefined && !/^text\/plain\b/i.test(type.trim())) return undefined;
  const body = (response.getBody() ?? "").trim();
  if (body.length === 0 || body.length > REASON_CHARS) return undefined;
  if (body.startsWith("<") || !/^[\x20-\x7e]+$/.test(body)) return undefined;
  if (isJson(body)) return undefined;
  return body;
}

/**
 * What a failed upload's row says. tus-js-client's DetailedError carries the
 * server's answer as originalResponse, and its message is a diagnostic
 * (method, url, response text, request id) that is not for the user. The
 * status decides first: 413 is too large, 401 is an ended session (sign in
 * again), 403 a plain refusal and a 5xx a server that cannot take it now.
 * Any other refusal shows the server's own reason when plainReason finds
 * one, as the tus handler's 400 and 415 refusals are, and otherwise a short
 * line for the status. A DetailedError with no answer lost the connection.
 */
export function failureMessage(error: Error): string {
  const detailed = error as Error & {
    originalRequest?: unknown;
    originalResponse?: HttpResponse | null;
  };
  const response = detailed.originalResponse ?? null;
  if (response !== null) {
    const status = response.getStatus();
    if (status === 413) return `${TOO_LARGE_TEXT}.`;
    if (status === 401) return SESSION_ENDED_TEXT;
    if (status >= 500) {
      return `The server could not take the upload right now (HTTP ${status}). Try again shortly.`;
    }
    const reason = status === 403 ? undefined : plainReason(response);
    if (reason !== undefined) return `The upload was refused: ${reason}`;
    return `The server refused the upload (HTTP ${status}).`;
  }
  if (detailed.originalRequest !== undefined) return "The upload failed: the connection was lost.";
  return `The upload failed: ${error.message || "the connection was lost"}.`;
}

/** How often a finished upload's result is asked for while its ingest runs. */
export const RESULT_POLL_MS = 1_000;

/** How long a result is waited for before the row says it could not be confirmed. */
export const RESULT_TIMEOUT_MS = 10 * 60 * 1_000;

/** Shown when a sent file's ingest outcome cannot be known. */
export const NOT_CONFIRMED_TEXT =
  "The upload could not be confirmed; check the library before sending it again.";

/** Shown when the session ended after the last byte, while the ingest ran. */
export const SENT_SESSION_ENDED_TEXT =
  "The file was sent, but your session has ended. Sign in again, then check the library before adding it again.";

export type UploadTarget =
  | { kind: "new" }
  | { kind: "model"; modelId: string }
  | { kind: "batch"; batch: string };

export function isSupportedFile(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return SUPPORTED_EXTENSIONS.includes(name.slice(dot).toLowerCase());
}

/** The upload's target as one word for the fingerprint. */
function targetKey(target: UploadTarget): string {
  if (target.kind === "model") return `model:${target.modelId}`;
  if (target.kind === "batch") return `batch:${target.batch}`;
  return "new";
}

/** The tus Upload-Metadata for a file sent to this target. */
export function uploadMetadata(file: File, target: UploadTarget): Record<string, string> {
  if (target.kind === "model") return { filename: file.name, modelId: target.modelId };
  if (target.kind === "batch") return { filename: file.name, batch: target.batch, combine: "1" };
  return { filename: file.name };
}

/**
 * The resume fingerprint: tus-js-client's own fields (name, type, size, last
 * change, endpoint) plus the target.
 */
export function uploadFingerprint(file: File, target: UploadTarget, endpoint: string): string {
  return [
    "platehouse",
    targetKey(target),
    file.name,
    file.type,
    file.size,
    file.lastModified,
    endpoint,
  ].join("-");
}

export interface UploadHandlers {
  onProgress(bytesSent: number, bytesTotal: number): void;
  /** The last byte was accepted; uploadUrl is the upload's own URL. */
  onSuccess(uploadUrl: string): void;
  onError(error: Error): void;
}

/**
 * tus-js-client's options for one file. uploadUrl reads the Upload's own url
 * once it is known, for onSuccess.
 */
export function uploadOptions(
  file: File,
  target: UploadTarget,
  handlers: UploadHandlers,
  uploadUrl: () => string | null = () => null,
): UploadOptions & { endpoint: string } {
  const endpoint = uploadEndpoint();
  return {
    endpoint,
    chunkSize: CHUNK_SIZE,
    metadata: uploadMetadata(file, target),
    fingerprint: async () => uploadFingerprint(file, target, endpoint),
    storeFingerprintForResuming: true,
    removeFingerprintOnSuccess: true,
    retryDelays: [0, 1_000, 3_000, 5_000, 10_000],
    onProgress: (sent, total) => handlers.onProgress(sent, total),
    onSuccess: () => {
      const url = uploadUrl();
      if (url !== null) handlers.onSuccess(url);
      else handlers.onError(new Error("the server gave the upload no address"));
    },
    onError: (error) => handlers.onError(error),
  };
}

export interface UploadHandle {
  abort(): void;
}

export type StartUpload = (
  file: File,
  target: UploadTarget,
  handlers: UploadHandlers,
) => UploadHandle;

/** Starts a tus upload of the file, resuming an earlier one to the same target. */
export const startTusUpload: StartUpload = (file, target, handlers) => {
  let url: () => string | null = () => null;
  const upload = new Upload(
    file,
    uploadOptions(file, target, handlers, () => url()),
  );
  url = () => upload.url;
  let stopped = false;
  void upload
    .findPreviousUploads()
    .then((previous) => {
      if (stopped) return;
      const last = previous[0];
      if (last !== undefined) upload.resumeFromPreviousUpload(last);
      upload.start();
    })
    .catch((error: unknown) => {
      handlers.onError(error instanceof Error ? error : new Error(String(error)));
    });
  return {
    abort() {
      stopped = true;
      void upload.abort();
    },
  };
};

export interface UploadResult {
  status: "pending" | "done" | "failed";
  modelId?: string;
  fileId?: string;
  error?: string;
}

export type FetchResult = (uploadUrl: string) => Promise<UploadResult>;

/**
 * GET <upload>/result: Task 9's answer for a finished upload. A 503 is the
 * server saying it cannot read the result now, so it stays pending and is
 * asked again (as a lost connection is, by waitForResult). A 401 is a session
 * that ended while the ingest ran: the file was sent, so the row says to sign
 * in and check the library. Any other refusal, such as the 404 for an upload
 * the server no longer knows, will not change by asking again.
 */
export const fetchUploadResult: FetchResult = async (uploadUrl) => {
  const res = await fetch(`${uploadUrl}/result`, { headers: { accept: "application/json" } });
  if (res.status === 503) return { status: "pending" };
  if (res.status === 401) return { status: "failed", error: SENT_SESSION_ENDED_TEXT };
  if (!res.ok) return { status: "failed", error: NOT_CONFIRMED_TEXT };
  return (await res.json()) as UploadResult;
};

export type UploadStatus = "ready" | "unsupported" | "uploading" | "adding" | "done" | "failed";

export interface UploadItem {
  key: string;
  file: File;
  status: UploadStatus;
  sent: number;
  total: number;
  /** A failure's reason, or why a file is not sent. */
  message?: string;
  modelId?: string;
}

export interface UseTusUploadOptions {
  start?: StartUpload;
  fetchResult?: FetchResult;
  /** How long to wait between result polls; RESULT_POLL_MS when left out. */
  resultDelayMs?: number;
  /** Runs once when every sent file has finished, done or failed. */
  onFinished?: (items: UploadItem[]) => void;
}

let keyCounter = 0;

function itemFor(file: File): UploadItem {
  keyCounter += 1;
  const refused = !isSupportedFile(file.name)
    ? UNSUPPORTED_TEXT
    : file.size > MAX_UPLOAD_BYTES
      ? TOO_LARGE_TEXT
      : undefined;
  return {
    key: `u${keyCounter}`,
    file,
    status: refused === undefined ? "ready" : "unsupported",
    sent: 0,
    total: file.size,
    ...(refused === undefined ? {} : { message: refused }),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The files of one upload dialog and how far each has got. */
export function useTusUpload(opts: UseTusUploadOptions = {}) {
  const start = opts.start ?? startTusUpload;
  const fetchResult = opts.fetchResult ?? fetchUploadResult;
  const delay = opts.resultDelayMs ?? RESULT_POLL_MS;
  const [items, setItems] = useState<UploadItem[]>([]);
  const handles = useRef(new Map<string, UploadHandle>());
  const onFinished = useRef(opts.onFinished);
  onFinished.current = opts.onFinished;
  const latest = useRef<UploadItem[]>([]);
  latest.current = items;
  const running = useRef(false);

  const update = useCallback((key: string, patch: Partial<UploadItem>) => {
    setItems((list) => list.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  }, []);

  // Once every sent file has ended, report it once.
  useEffect(() => {
    if (!running.current) return;
    const sent = items.filter((i) => i.status !== "ready" && i.status !== "unsupported");
    if (sent.length === 0) return;
    if (sent.every((i) => i.status === "done" || i.status === "failed")) {
      running.current = false;
      onFinished.current?.(items);
    }
  }, [items]);

  useEffect(() => {
    const open = handles.current;
    return () => {
      for (const handle of open.values()) handle.abort();
    };
  }, []);

  /** Adds files to the list; a file already listed and not yet sent is not added twice. */
  const addFiles = useCallback((files: File[]) => {
    setItems((list) => {
      const fresh = files.filter(
        (f) =>
          !list.some(
            (i) =>
              i.status === "ready" &&
              i.file.name === f.name &&
              i.file.size === f.size &&
              i.file.lastModified === f.lastModified,
          ),
      );
      return [...list, ...fresh.map(itemFor)];
    });
  }, []);

  /** Removes the rows that are not in flight: done, failed, unsupported or not sent. */
  const clearSettled = useCallback(() => {
    setItems((list) => list.filter((i) => i.status === "uploading" || i.status === "adding"));
  }, []);

  async function waitForResult(key: string, uploadUrl: string) {
    const until = Date.now() + RESULT_TIMEOUT_MS;
    for (;;) {
      let result: UploadResult;
      try {
        result = await fetchResult(uploadUrl);
      } catch {
        result = { status: "pending" };
      }
      if (result.status === "done") {
        update(key, {
          status: "done",
          ...(result.modelId === undefined ? {} : { modelId: result.modelId }),
        });
        return;
      }
      if (result.status === "failed") {
        update(key, { status: "failed", message: result.error ?? "The upload failed." });
        return;
      }
      if (Date.now() > until) {
        update(key, { status: "failed", message: NOT_CONFIRMED_TEXT });
        return;
      }
      await sleep(delay);
    }
  }

  /** Sends every ready file to the target. */
  const begin = (target: UploadTarget) => {
    const ready = latest.current.filter((i) => i.status === "ready");
    if (ready.length === 0) return;
    running.current = true;
    setItems((list) =>
      list.map((i) => (i.status === "ready" ? { ...i, status: "uploading" as const } : i)),
    );
    for (const item of ready) {
      const handle = start(item.file, target, {
        onProgress: (sent, total) => update(item.key, { sent, total }),
        onSuccess: (uploadUrl) => {
          handles.current.delete(item.key);
          update(item.key, { status: "adding", sent: item.file.size, total: item.file.size });
          void waitForResult(item.key, uploadUrl);
        },
        onError: (error) => {
          handles.current.delete(item.key);
          update(item.key, { status: "failed", message: failureMessage(error) });
        },
      });
      handles.current.set(item.key, handle);
    }
  };

  const busy = items.some((i) => i.status === "uploading" || i.status === "adding");
  return { items, addFiles, begin, clearSettled, busy };
}
