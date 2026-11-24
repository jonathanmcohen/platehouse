// Uploads through the server's tus endpoint (uploads/tus.ts), with
// tus-js-client:
//
// - Every file goes to /app/uploads (session-class; the browser sends the
//   session cookie and Origin, which the gate checks) in 5 MiB chunks, so a
//   phone that loses its connection resends at most one chunk.
// - The metadata names the target (as uploads/tus.ts reads it and
//   api/openapi.ts documents it): nothing for a new model of its own,
//   modelId for an existing model, or batch with combine for the "Combine
//   into one model" batch.
// - tus-js-client keeps a resume fingerprint in localStorage, so a dropped
//   upload resumes when the same file is sent again. The fingerprint
//   includes the target, so the same file sent to a different target starts
//   a new upload instead of resuming the old one (the maintainer, 2026-11-09, issue
//   #77). A finished upload's fingerprint is removed too: the server answers a
//   HEAD on an ingested upload as finished, so resuming it would store
//   nothing (uploads/tus.ts).
// - Three files are sent at a time (UPLOAD_POOL); the rest wait their turn,
//   and a waiting file's upload is only created on the server when its turn
//   comes, so it never counts toward the server's 20 unfinished uploads per
//   session or ages out there before a byte is sent.
// - tus-js-client resends a request that failed for a reason that may pass
//   (shouldRetryUpload): never while the browser is offline, and never a
//   507 (the server is out of room) or a 429 (too many unfinished uploads),
//   which asking again at once will not change.
// - A failed row offers Retry, which sends the file again to where it was
//   first sent. A row that failed because the connection was lost starts
//   again by itself when the browser comes back online; while it is
//   offline, waiting rows are not started (they would only fail). While a file is
//   waiting or sending, leaving the page asks first (beforeunload).
// - When the last byte is accepted, GET <upload>/result is polled until the
//   ingest is done or failed: at once, then after waits of 1 s, 5 s, then
//   15 s each (RESULT_BACKOFF_MS). A pending answer, or a 503 (the server cannot read
//   the result now), keeps waiting, up to RESULT_TIMEOUT_MS. A lost
//   connection, or a 429, 502 or 504 (a proxy in the way), is asked again,
//   but RESULT_ERROR_LIMIT of them in a row give up. A 401 says the file was
//   sent but the session ended, and any other refusal (a 404 for an upload
//   the server no longer knows) says at once that the upload could not be
//   confirmed.
// - A file over the server's 512 MiB limit (MAX_UPLOAD_BYTES in
//   apps/server/src/uploads/tus.ts) is listed with the reason and never
//   sent, like a type Platehouse does not take. A refused or failed upload
//   shows plain words (failureMessage): a line for the status (an ended
//   session, a refusal, a server that cannot take it now), or the tus
//   handler's own one-line plain-text reason, never tus-js-client's
//   diagnostic text and never a JSON body such as the session gate's.
// - Duplicates (approved for 0.1.0 by the maintainer, 2026-11-19): every file is sent
//   with duplicates skip, so the server refuses a file whose SHA-256 a live
//   model already holds, stores nothing, and answers failed with code
//   duplicate and the files it matched. That row becomes "duplicate", not
//   "failed": nothing went wrong. importAnyway sends that one file again,
//   to the target it was first sent to, with duplicates allow. The policy is
//   part of the fingerprint, so the second send never resumes the first.
//
// useTusUpload holds one dialog's files and their progress; the start and
// result calls can be replaced, which the tests do.

import { useCallback, useEffect, useRef, useState } from "react";
import { type HttpResponse, Upload, type UploadOptions } from "tus-js-client";
import { ENGLISH_I18N, type I18n, type MessageKey, useI18n } from "../i18n/I18n";
import { serverTextWith } from "../i18n/serverText";
import { isFolder } from "./dropped";

/** Builds the sentences in a language; English when left out. */
type Words = Pick<I18n, "t" | "locale">;

/** The server's tus handler for the UI: the path on this page's own origin. */
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

/** The file types Platehouse takes; anything else is refused and nothing is stored. */
export const SUPPORTED_EXTENSIONS: readonly string[] = [".3mf", ".stl", ".step", ".stp", ".scad"];

/** What the file input offers. */
export const ACCEPT = SUPPORTED_EXTENSIONS.join(",");

/** Shown on a row whose file is not a supported type; it is never sent. */
export const UNSUPPORTED_TEXT = ENGLISH_I18N.t("upload.unsupported");

/** The largest file the server takes: 512 MiB (uploads/tus.ts MAX_UPLOAD_BYTES). */
export const MAX_UPLOAD_BYTES = 536_870_912;

/** Shown on a row whose file is over MAX_UPLOAD_BYTES; it is never sent. */
export const TOO_LARGE_TEXT = ENGLISH_I18N.t("upload.tooLarge");

/**
 * The words that mark the upload route's 429 for too many uploads on the
 * server in any state (uploads/tus.ts TOO_MANY_HELD_MESSAGE), as against
 * its 429 for too many unfinished ones.
 */
const TOO_MANY_HELD_WORDS = "uploads on the server";

/** Longest server reason shown as it is; a longer body gets the status line. */
const REASON_CHARS = 300;

/** Shown on a row whose upload the session gate refused with 401. */
export const SESSION_ENDED_TEXT = ENGLISH_I18N.t("upload.sessionEnded");

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
export function failureMessage(error: Error, i18n: Words = ENGLISH_I18N): string {
  const { t } = i18n;
  const detailed = error as Error & {
    originalRequest?: unknown;
    originalResponse?: HttpResponse | null;
  };
  const response = detailed.originalResponse ?? null;
  if (response !== null) {
    const status = response.getStatus();
    if (status === 413) return t("upload.tooLargeSentence");
    if (status === 401) return t("upload.sessionEnded");
    if (status === 507) return t("upload.serverFull");
    if (status === 429) {
      // The server's 429 for too many uploads in any state, finished ones
      // included (uploads/tus.ts TOO_MANY_HELD_MESSAGE), is not cured by a
      // Retry once others finish, so it has its own line.
      return plainReason(response)?.includes(TOO_MANY_HELD_WORDS)
        ? t("upload.tooManyRecent")
        : t("upload.tooManyUnfinished");
    }
    if (status >= 500) return t("upload.serverBusy", { status });
    // The tus handler's own reason is an English line: shown as it is in
    // English, and in another language replaced by a line for the status.
    const reason = status === 403 ? undefined : plainReason(response);
    if (reason !== undefined) {
      return serverTextWith(i18n, t("upload.refusedReason", { reason }), () =>
        status === 415 ? t("upload.refusedType") : t("upload.refusedStatus", { status }),
      );
    }
    return t("upload.refusedStatus", { status });
  }
  if (detailed.originalRequest !== undefined || error.message === "") {
    return t("upload.connectionLost");
  }
  // tus-js-client's own English words: as they are in English, else the plain line.
  return serverTextWith(i18n, t("upload.failedBecause", { reason: error.message }), () =>
    t("upload.connectionLost"),
  );
}

/**
 * Whether tus-js-client's failure was a lost connection: a request that got
 * no answer. Such a row starts again when the browser comes back online.
 */
export function isConnectionLost(error: Error): boolean {
  const detailed = error as Error & {
    originalRequest?: unknown;
    originalResponse?: HttpResponse | null;
  };
  return (detailed.originalResponse ?? null) === null && detailed.originalRequest !== undefined;
}

/** How many files are sent at once; the rest wait their turn. */
export const UPLOAD_POOL = 3;

/**
 * Whether tus-js-client sends a failed request again (its onShouldRetry).
 * Never while the browser says it is offline: the row fails with a lost
 * connection and starts again when it is back. Never a 507 (the server is
 * out of room) or a 429 (too many unfinished uploads): asking again at once
 * will not change either. Otherwise as tus-js-client decides by default: a
 * lost connection, a 5xx, a 409 or a 423 is sent again, any other 4xx not.
 */
export function shouldRetryUpload(error: Error): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
  const response = (error as Error & { originalResponse?: HttpResponse | null }).originalResponse;
  const status = response?.getStatus() ?? 0;
  if (status === 507 || status === 429) return false;
  return status < 400 || status >= 500 || status === 409 || status === 423;
}

/**
 * Whether an error is a refusal that asking again will not change: a 4xx the
 * server answered, other than the 429 (too many unfinished uploads, which
 * passes once some finish), the 409 and the 423, which tus-js-client sends
 * again itself (shouldRetryUpload) and which may then resume. A lost
 * connection, a 5xx and a 507 are not final either.
 */
export function isFinalRefusal(error: Error): boolean {
  const response = (error as Error & { originalResponse?: HttpResponse | null }).originalResponse;
  const status = response?.getStatus() ?? 0;
  return status >= 400 && status < 500 && status !== 429 && status !== 409 && status !== 423;
}

/**
 * Removes the resume fingerprints tus-js-client stored for an upload
 * (localStorage "tus::<fingerprint>::<n>"). tus removes one only on success,
 * so a refused file's would stay for ever and be offered for resuming.
 */
function forgetStoredUpload(fingerprint: string): void {
  try {
    const prefix = `tus::${fingerprint}::`;
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const key = localStorage.key(i);
      if (key?.startsWith(prefix)) localStorage.removeItem(key);
    }
  } catch {
    // Storage is off (a private window): nothing was kept.
  }
}

/**
 * The waits between asks for a finished upload's result: 1 s, then 5 s, then
 * 15 s each time after.
 */
export const RESULT_BACKOFF_MS: readonly number[] = [1_000, 5_000, 15_000];

/**
 * The wait before the next ask, after `attempt` asks have been answered
 * pending or failed: the backoff, or `fixedMs` for every wait when given.
 */
export function resultWaitMs(attempt: number, fixedMs?: number): number {
  if (fixedMs !== undefined) return fixedMs;
  return RESULT_BACKOFF_MS[Math.min(attempt, RESULT_BACKOFF_MS.length - 1)] ?? 15_000;
}

/**
 * How long a pending result is waited for before the row says it could not
 * be confirmed: 70 minutes. The server gives an import an hour
 * (INGEST_EXPIRE_SECONDS in apps/server/src/jobs/queues.ts) before it is
 * failed, and the rest is time it may wait for its turn.
 */
export const RESULT_TIMEOUT_MS = 70 * 60 * 1_000;

/** How many errors in a row asking for a result give up as not confirmed. */
export const RESULT_ERROR_LIMIT = 5;

/** Answers to GET <upload>/result that may pass: asked again, as a lost connection is. */
const PASSING_RESULT_STATUS: ReadonlySet<number> = new Set([429, 502, 504]);

/** A GET <upload>/result answer that may pass, as makeFetchUploadResult throws it. */
class ResultUnavailable extends Error {
  constructor(status: number) {
    super(`the upload's result could not be read (HTTP ${status})`);
    this.name = "ResultUnavailable";
  }
}

/** Shown when a sent file's ingest outcome cannot be known. */
export const NOT_CONFIRMED_TEXT = ENGLISH_I18N.t("upload.notConfirmed");

/** Shown when the session ended after the last byte, while the ingest ran. */
export const SENT_SESSION_ENDED_TEXT = ENGLISH_I18N.t("upload.sentSessionEnded");

/** Whether the server skips a file already in the library or stores it anyway. */
export type DuplicatePolicy = "skip" | "allow";

/** A live file that already held the same bytes, as the server's result names it. */
export interface DuplicateMatch {
  modelId: string;
  modelName: string;
  fileId: string;
  fileName: string;
}

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
export function uploadMetadata(
  file: File,
  target: UploadTarget,
  duplicates: DuplicatePolicy = "skip",
): Record<string, string> {
  if (target.kind === "model") {
    return { filename: file.name, modelId: target.modelId, duplicates };
  }
  if (target.kind === "batch") {
    return { filename: file.name, batch: target.batch, combine: "1", duplicates };
  }
  return { filename: file.name, duplicates };
}

/**
 * The resume fingerprint: tus-js-client's own fields (name, type, size, last
 * change, endpoint) plus the target and, for Import anyway, the policy.
 */
export function uploadFingerprint(
  file: File,
  target: UploadTarget,
  endpoint: string,
  duplicates: DuplicatePolicy = "skip",
): string {
  return [
    "platehouse",
    targetKey(target),
    // Left out for skip, so a skip upload keeps the fingerprint it had.
    ...(duplicates === "skip" ? [] : [`duplicates:${duplicates}`]),
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
  duplicates: DuplicatePolicy = "skip",
): UploadOptions & { endpoint: string } {
  const endpoint = uploadEndpoint();
  return {
    endpoint,
    chunkSize: CHUNK_SIZE,
    metadata: uploadMetadata(file, target, duplicates),
    fingerprint: async () => uploadFingerprint(file, target, endpoint, duplicates),
    storeFingerprintForResuming: true,
    removeFingerprintOnSuccess: true,
    retryDelays: [0, 1_000, 3_000, 5_000, 10_000],
    onShouldRetry: (error) => shouldRetryUpload(error),
    onProgress: (sent, total) => handlers.onProgress(sent, total),
    onSuccess: () => {
      const url = uploadUrl();
      if (url !== null) handlers.onSuccess(url);
      else handlers.onError(new Error("the server gave the upload no address"));
    },
    onError: (error) => {
      if (isFinalRefusal(error)) {
        forgetStoredUpload(uploadFingerprint(file, target, endpoint, duplicates));
      }
      handlers.onError(error);
    },
  };
}

export interface UploadHandle {
  abort(): void;
}

export type StartUpload = (
  file: File,
  target: UploadTarget,
  handlers: UploadHandlers,
  /** skip when left out. */
  duplicates?: DuplicatePolicy,
) => UploadHandle;

/** Starts a tus upload of the file, resuming an earlier one to the same target. */
export const startTusUpload: StartUpload = (file, target, handlers, duplicates = "skip") => {
  let url: () => string | null = () => null;
  const upload = new Upload(
    file,
    uploadOptions(file, target, handlers, () => url(), duplicates),
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
  /** "duplicate" on a file refused under duplicates skip. */
  code?: string;
  duplicates?: DuplicateMatch[];
}

export type FetchResult = (uploadUrl: string) => Promise<UploadResult>;

/**
 * GET <upload>/result: the server's answer for a finished upload. A 503 is the
 * server saying it cannot read the result now, so it stays pending and is
 * asked again. A 429, 502 or 504 (often a proxy in the way) may pass: it
 * throws ResultUnavailable, which waitForResult counts as an error
 * and asks again, as it does a lost connection. A 401 is a session that
 * ended while the ingest ran: the file was sent, so the row says to sign in
 * and check the library. Any other refusal, such as the 404 for an upload
 * the server no longer knows, will not change by asking again.
 */
export function makeFetchUploadResult(): FetchResult {
  return async (uploadUrl) => {
    const res = await fetch(`${uploadUrl}/result`, { headers: { accept: "application/json" } });
    if (res.status === 503) return { status: "pending" };
    if (PASSING_RESULT_STATUS.has(res.status)) throw new ResultUnavailable(res.status);
    // These two are the page's own outcomes, not the server's words, so they
    // carry a code and no error: resultMessage then says them in the shown
    // language every time, never as server English (issue 295).
    if (res.status === 401) return { status: "failed", code: "sent_session_ended" };
    if (!res.ok) return { status: "failed", code: "not_confirmed" };
    return (await res.json()) as UploadResult;
  };
}

/** GET <upload>/result. */
export const fetchUploadResult: FetchResult = makeFetchUploadResult();

/** The words for each code a failed upload's result carries (uploads/tus.ts). */
const RESULT_KEYS: Readonly<Record<string, MessageKey>> = {
  unsupported_type: "upload.result.unsupportedType",
  storage_unavailable: "upload.result.storageUnavailable",
  model_not_found: "upload.result.modelNotFound",
  ingest_failed: "upload.result.ingestFailed",
  upload_failed: "upload.result.uploadFailed",
  // The page's own codes (makeFetchUploadResult), which carry no server sentence.
  sent_session_ended: "upload.sentSessionEnded",
  not_confirmed: "upload.notConfirmed",
};

/**
 * A failed result's sentence in the shown language: the server's own English
 * sentence on an English page, never en.json's copy of it; on another, by its
 * code when the page knows it, else the plain "The upload failed.".
 */
export function resultMessage(result: UploadResult, i18n: Words = ENGLISH_I18N): string {
  const key = result.code === undefined ? undefined : RESULT_KEYS[result.code];
  const words = () => (key === undefined ? i18n.t("upload.failed") : i18n.t(key));
  return result.error === undefined ? words() : serverTextWith(i18n, result.error, words);
}

export type UploadStatus =
  | "ready"
  | "unsupported"
  /** Sent, waiting for one of the UPLOAD_POOL places; nothing is on the server yet. */
  | "waiting"
  | "uploading"
  | "adding"
  | "done"
  | "failed"
  | "duplicate";

export interface UploadItem {
  key: string;
  file: File;
  status: UploadStatus;
  sent: number;
  total: number;
  /** A failure's reason, or why a file is not sent. */
  message?: string;
  modelId?: string;
  /** Where the file was sent, so Import anyway and Retry send it to the same place. */
  target?: UploadTarget;
  /** The duplicates policy it was last sent with, so Retry sends it the same way. */
  policy?: DuplicatePolicy;
  /** A failure because the connection was lost: it starts again when back online. */
  offline?: boolean;
  /** For a duplicate: the live files that already hold it, oldest first. */
  duplicates?: DuplicateMatch[];
}

/** The entries of a result's duplicates that are a file and its model. */
function duplicateList(value: unknown): DuplicateMatch[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (m): m is DuplicateMatch =>
      typeof m?.modelId === "string" &&
      typeof m.modelName === "string" &&
      typeof m.fileId === "string" &&
      typeof m.fileName === "string",
  );
}

export interface UseTusUploadOptions {
  start?: StartUpload;
  fetchResult?: FetchResult;
  /** One wait for every result poll; RESULT_BACKOFF_MS when left out. */
  resultDelayMs?: number;
  /** Runs once when every sent file has finished, done or failed. */
  onFinished?: (items: UploadItem[]) => void;
}

let keyCounter = 0;

function itemFor(file: File, i18n: Words): UploadItem {
  keyCounter += 1;
  const refused = isFolder(file)
    ? i18n.t("upload.folder")
    : !isSupportedFile(file.name)
      ? i18n.t("upload.unsupported")
      : file.size > MAX_UPLOAD_BYTES
        ? i18n.t("upload.tooLarge")
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

/** A row sent and waiting for one of the UPLOAD_POOL places. */
interface Turn {
  item: UploadItem;
  target: UploadTarget;
  duplicates: DuplicatePolicy;
}

/** Whether a row's file is still to reach the server: leaving the page would lose it. */
const isSending = (item: UploadItem) => item.status === "waiting" || item.status === "uploading";

/** Asks before the page is left while a file is still sending. */
function askBeforeLeaving(event: BeforeUnloadEvent) {
  event.preventDefault();
  // Browsers that predate preventDefault here ask when returnValue is set.
  event.returnValue = "";
}

/** The files of one upload dialog and how far each has got. */
export function useTusUpload(opts: UseTusUploadOptions = {}) {
  const start = opts.start ?? startTusUpload;
  const i18n = useI18n();
  const words = useRef(i18n);
  words.current = i18n;
  const fetchResult = opts.fetchResult ?? fetchUploadResult;
  const fixedDelay = opts.resultDelayMs;
  const [items, setItems] = useState<UploadItem[]>([]);
  /** The uploads tus is sending now, at most UPLOAD_POOL, by row key. */
  const handles = useRef(new Map<string, UploadHandle>());
  /** The rows sent and waiting their turn, first sent first. */
  const queue = useRef<Turn[]>([]);
  const mounted = useRef(true);
  const onFinished = useRef(opts.onFinished);
  onFinished.current = opts.onFinished;
  const latest = useRef<UploadItem[]>([]);
  latest.current = items;
  const running = useRef(false);

  const update = useCallback((key: string, patch: Partial<UploadItem>) => {
    setItems((list) => list.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  }, []);

  // Once every sent file has ended, report it once. A waiting row has not.
  useEffect(() => {
    if (!running.current) return;
    const sent = items.filter((i) => i.status !== "ready" && i.status !== "unsupported");
    if (sent.length === 0) return;
    if (
      sent.every((i) => i.status === "done" || i.status === "failed" || i.status === "duplicate")
    ) {
      running.current = false;
      onFinished.current?.(items);
    }
  }, [items]);

  useEffect(() => {
    mounted.current = true;
    const open = handles.current;
    const waiting = queue.current;
    return () => {
      mounted.current = false;
      waiting.length = 0;
      for (const handle of open.values()) handle.abort();
    };
  }, []);

  // While a file is waiting or sending, leaving the page asks first.
  const sending = items.some(isSending);
  useEffect(() => {
    if (!sending) return;
    window.addEventListener("beforeunload", askBeforeLeaving);
    return () => window.removeEventListener("beforeunload", askBeforeLeaving);
  }, [sending]);

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
      return [...list, ...fresh.map((f) => itemFor(f, words.current))];
    });
  }, []);

  /** Removes the rows that are not in flight: done, failed, unsupported or not sent. */
  const clearSettled = useCallback(() => {
    setItems((list) =>
      list.filter(
        (i) => i.status === "waiting" || i.status === "uploading" || i.status === "adding",
      ),
    );
  }, []);

  /** Removes only the rows that went in; a failed or unsent row stays to be seen. */
  const clearDone = useCallback(() => {
    setItems((list) => list.filter((i) => i.status !== "done"));
  }, []);

  /**
   * Asks for a finished upload's result until it is done or failed: at once,
   * then after waits of 1 s, 5 s, then 15 s each. Pending keeps waiting, up
   * to RESULT_TIMEOUT_MS; RESULT_ERROR_LIMIT errors in a row give up.
   */
  async function waitForResult(key: string, uploadUrl: string) {
    const until = Date.now() + RESULT_TIMEOUT_MS;
    let errors = 0;
    for (let attempt = 0; ; attempt += 1) {
      let result: UploadResult | undefined;
      try {
        result = await fetchResult(uploadUrl);
        errors = 0;
      } catch {
        errors += 1;
      }
      if (!mounted.current) return;
      if (result?.status === "done") {
        update(key, {
          status: "done",
          ...(result.modelId === undefined ? {} : { modelId: result.modelId }),
        });
        return;
      }
      if (result?.status === "failed") {
        const duplicates = duplicateList(result.duplicates);
        if (result.code === "duplicate" && duplicates.length > 0) {
          update(key, { status: "duplicate", duplicates });
          return;
        }
        update(key, { status: "failed", message: resultMessage(result, words.current) });
        return;
      }
      if (errors >= RESULT_ERROR_LIMIT || Date.now() > until) {
        update(key, { status: "failed", message: words.current.t("upload.notConfirmed") });
        return;
      }
      await sleep(resultWaitMs(attempt, fixedDelay));
    }
  }

  /** Ends a row that failed to send: its place is freed for the next waiting row. */
  function sendFailed(key: string, error: Error) {
    handles.current.delete(key);
    update(key, {
      status: "failed",
      message: failureMessage(error, words.current),
      offline: isConnectionLost(error),
    });
    pump();
  }

  /**
   * Starts one waiting row's upload: only now is it created on the server.
   * Its place is taken before start, so a start that fails at once, by
   * calling onError or by throwing, frees it.
   */
  function send({ item, target, duplicates }: Turn) {
    const { key, file } = item;
    handles.current.set(key, { abort() {} });
    update(key, { status: "uploading", sent: 0 });
    let handle: UploadHandle;
    try {
      handle = start(
        file,
        target,
        {
          onProgress: (sent, total) => update(key, { sent, total }),
          onSuccess: (uploadUrl) => {
            handles.current.delete(key);
            update(key, { status: "adding", sent: file.size, total: file.size });
            // Asked for first, so the next row's start cannot keep this one unconfirmed.
            void waitForResult(key, uploadUrl);
            pump();
          },
          onError: (error) => sendFailed(key, error),
        },
        duplicates,
      );
    } catch (error) {
      sendFailed(key, error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (handles.current.has(key)) handles.current.set(key, handle);
  }

  /**
   * Starts waiting rows, first sent first, while fewer than UPLOAD_POOL are
   * sending. Not while the browser is offline: they would only fail, so they
   * wait, and the online handler starts them.
   */
  function pump() {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    while (mounted.current && handles.current.size < UPLOAD_POOL) {
      const turn = queue.current.shift();
      if (turn === undefined) return;
      send(turn);
    }
  }

  /** Puts a row in line to be sent, unless it is already waiting or sending. */
  function enqueue(item: UploadItem, target: UploadTarget, duplicates: DuplicatePolicy) {
    const { key } = item;
    if (handles.current.has(key) || queue.current.some((turn) => turn.item.key === key)) return;
    queue.current.push({ item, target, duplicates });
    setItems((list) =>
      list.map((i) => {
        if (i.key !== key) return i;
        const { message: _message, offline: _offline, ...rest } = i;
        return { ...rest, status: "waiting" as const, sent: 0, target, policy: duplicates };
      }),
    );
  }

  /** Sends every ready file to the target, skipping any already in the library. */
  const begin = (target: UploadTarget) => {
    const ready = latest.current.filter((i) => i.status === "ready");
    if (ready.length === 0) return;
    running.current = true;
    for (const item of ready) enqueue(item, target, "skip");
    pump();
  };

  /** Sends a skipped duplicate again, to where it was first sent, stored anyway. */
  const importAnyway = (key: string) => {
    const item = latest.current.find((i) => i.key === key);
    if (item?.status !== "duplicate" || item.target === undefined) return false;
    running.current = true;
    update(key, { duplicates: [] });
    enqueue(item, item.target, "allow");
    pump();
    return true;
  };

  /** Sends a failed row's file again, to where and how it was first sent. */
  const retry = (key: string) => {
    const item = latest.current.find((i) => i.key === key);
    if (item?.status !== "failed" || item.target === undefined) return false;
    running.current = true;
    enqueue(item, item.target, item.policy ?? "skip");
    pump();
    return true;
  };

  // Back online: each row that failed because the connection was lost starts
  // again, once (enqueue skips a row already waiting or sending), after the
  // rows that waited while the browser was offline.
  const resume = useRef(() => {});
  resume.current = () => {
    for (const item of latest.current) {
      if (item.status !== "failed" || item.offline !== true || item.target === undefined) continue;
      running.current = true;
      enqueue(item, item.target, item.policy ?? "skip");
    }
    pump();
  };
  useEffect(() => {
    const onOnline = () => resume.current();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, []);

  const busy = items.some((i) => isSending(i) || i.status === "adding");
  return { items, addFiles, begin, importAnyway, retry, clearSettled, clearDone, busy };
}
