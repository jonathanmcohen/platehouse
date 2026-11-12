// The importer's Platehouse client. It talks to Platehouse only through the
// Public API v1 (build plan Task 16, apps/server/src/api/v1.ts and
// apps/server/src/uploads/tus.ts), as that contract stands:
//
//   GET  /api/v1/models?limit=1                 check: the API answers, the token works
//   GET  /api/v1/models?externalRef=manyfold:<id>   the live model, or none
//   GET  /api/v1/models/:id                     its files, to match against Manyfold's
//   POST /api/v1/models                         201 {model} | 409 {error, trashed}
//   PUT  /api/v1/models/:id/tags/:tag           204
//   PUT  /api/v1/collections/:name/models/:id   204
//   POST /api/v1/uploads, PATCH and HEAD /api/v1/uploads/:id   tus 1.0.0
//   GET  /api/v1/uploads/:id/result             pending | done | failed
//   GET  /api/v1/files/:id                      the stored size and SHA-256
//
// Every request carries the bearer token and stays on the base origin: the
// API never redirects, so a 3xx is an error, and the tus Location must be an
// upload path on the same origin.
//
// Retries, and why each is safe to repeat:
// - GETs and the tag and collection PUTs retry network errors, 429 and 5xx
//   (2, 4, 8 s, or Retry-After), up to 4 attempts.
// - POST /api/v1/models retries the same way, because externalRef is unique
//   in Platehouse: if a first attempt made the model and its answer was lost,
//   the repeat is 409 with trashed false, and the model is then read back by
//   its externalRef rather than made again.
// - Creating an upload retries too: an upload that never gets its bytes
//   makes no model and is swept after 24 hours (Task 9).
// - A PATCH is never sent blind twice: after a failed PATCH the client asks
//   with HEAD where the upload stands and sends only the rest (tus resume).
// - Waiting for the result: GET .../result every second, up to 10 minutes.
//   A result that never comes is reported as an unknown outcome; the next
//   run finds the file if the ingest finished.

import { cleanText } from "./redact.js";

export class PlatehouseError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "PlatehouseError";
    this.status = status;
  }
}

export interface PlatehouseFile {
  id: string;
  modelId: string;
  name: string;
  originalName: string;
  size: number;
  sha256: string;
}

export interface PlatehouseModel {
  id: string;
  name: string;
  externalRef: string | null;
  tags: string[];
  collections: string[];
  files: PlatehouseFile[];
}

export interface NewModel {
  name: string;
  caption?: string;
  description?: string;
  creator?: string;
  license?: string;
  externalRef: string;
  tags?: string[];
  collections?: string[];
}

export type CreateResult = { created: PlatehouseModel } | { exists: true; trashed: boolean };

export interface PlatehouseOptions {
  base: string;
  /** The Platehouse API token. */
  bearer: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /**
   * Applied to an error body before it is cut to its quote length, so a
   * credential the server echoes is replaced whole rather than cut in two
   * (the CLI passes its redactor).
   */
  redact?: (text: string) => string;
  retries?: number;
  timeoutMs?: number;
}

export interface Platehouse {
  /** One read that proves the API answers and takes the token. */
  check(): Promise<void>;
  /** The live model with this externalRef, with its files; undefined when none is live. */
  findByExternalRef(ref: string): Promise<PlatehouseModel | undefined>;
  createModel(input: NewModel): Promise<CreateResult>;
  addTag(modelId: string, tag: string): Promise<void>;
  addToCollection(modelId: string, collection: string): Promise<void>;
  /** Uploads one file into the model and returns it as Platehouse stored it. */
  upload(modelId: string, filename: string, bytes: Buffer): Promise<PlatehouseFile>;
}

const MAX_RETRY_AFTER_S = 300;
const BODY_QUOTE = 200;
const POLL_MS = 1000;
const POLL_LIMIT = 600;
/** One PATCH may carry the whole file (Task 9); this bounds the time it may take. */
const UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

function why(error: unknown, timeout: number): string {
  const e = error as { name?: string; message?: string; cause?: { code?: string } };
  if (e.name === "TimeoutError") return `timed out after ${Math.round(timeout / 1000)} s`;
  const code = e.cause?.code;
  return `${e.message ?? String(error)}${code === undefined ? "" : ` (${code})`}`;
}

function toFile(j: Json): PlatehouseFile {
  const id = str(j.id);
  const sha = str(j.sha256);
  if (id === null || typeof j.size !== "number" || sha === null) {
    throw new PlatehouseError("Platehouse answered a file without id, size or sha256");
  }
  return {
    id,
    modelId: str(j.modelId) ?? "",
    name: str(j.name) ?? "",
    originalName: str(j.originalName) ?? str(j.name) ?? "",
    size: j.size,
    sha256: sha,
  };
}

function toModel(j: Json): PlatehouseModel {
  const id = str(j.id);
  if (id === null) throw new PlatehouseError("Platehouse answered a model without an id");
  return {
    id,
    name: str(j.name) ?? "",
    externalRef: str(j.externalRef),
    tags: strings(j.tags),
    collections: strings(j.collections),
    files: (Array.isArray(j.files) ? j.files : []).filter(isObject).map(toFile),
  };
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

/**
 * A value as one URL path segment. encodeURIComponent escapes "/", "?", "#"
 * and "%", but leaves "." and ".." as they are, and the URL parser resolves
 * those as dot segments, so a PUT would reach another route. plan.ts leaves
 * such a label out; this refuses one before anything is sent, as a floor.
 */
function segment(value: string): string {
  if (value === "." || value === "..") {
    throw new PlatehouseError(`"${value}" cannot be sent as one path segment`);
  }
  return encodeURIComponent(value);
}

export function createPlatehouse(options: PlatehouseOptions): Platehouse {
  const origin = new URL(options.base).origin;
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? realSleep;
  const log = options.log ?? (() => {});
  const redact = options.redact ?? ((text: string) => text);
  const attempts = options.retries ?? 4;
  const timeoutMs = options.timeoutMs ?? 30_000;

  const api = (path: string) => new URL(`/api/v1${path}`, origin);

  interface Send {
    method: string;
    headers?: Record<string, string>;
    body?: string | Uint8Array;
    retry: boolean;
    timeout?: number;
  }

  async function send(url: URL, how: Send): Promise<Response> {
    if (url.origin !== origin) throw new PlatehouseError(`refusing a URL off ${origin}`);
    const timeout = how.timeout ?? timeoutMs;
    const label = `${how.method} ${url.pathname}`;
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        const init: RequestInit = {
          method: how.method,
          headers: { ...how.headers, Authorization: `Bearer ${options.bearer}` },
          redirect: "manual",
          signal: AbortSignal.timeout(timeout),
        };
        if (how.body !== undefined) init.body = how.body;
        res = await doFetch(url, init);
      } catch (error) {
        const reason = why(error, timeout);
        if (how.retry && attempt < attempts) {
          log(`  ${label}: ${reason}, retry ${attempt}`);
          await sleep(2000 * 2 ** (attempt - 1));
          continue;
        }
        throw new PlatehouseError(`${label}: ${reason}`);
      }
      const busy = res.status === 429 || res.status >= 500;
      if (how.retry && busy && attempt < attempts) {
        const after = Number(res.headers.get("retry-after"));
        const wait =
          after > 0 ? Math.min(after, MAX_RETRY_AFTER_S) * 1000 : 2000 * 2 ** (attempt - 1);
        log(`  ${label}: HTTP ${res.status}, retry ${attempt}`);
        await res.body?.cancel();
        await sleep(wait);
        continue;
      }
      return res;
    }
  }

  async function failure(url: URL, method: string, res: Response): Promise<PlatehouseError> {
    const text = await res.text().catch(() => "");
    let detail = text;
    try {
      const j: unknown = JSON.parse(text);
      if (isObject(j)) detail = [str(j.error), str(j.message)].filter((x) => x !== null).join(": ");
    } catch {
      // Not JSON: quote the text.
    }
    // On one line and without control characters, then redacted, then cut:
    // stripping a control character after redaction could join a credential
    // back up, and a credential cut in two is not one the redactor can find.
    detail = redact(cleanText(detail.replace(/\s+/g, " ")))
      .trim()
      .slice(0, BODY_QUOTE);
    return new PlatehouseError(
      `${method} ${url.pathname}: HTTP ${res.status}${detail === "" ? "" : ` ${detail}`}`,
      res.status,
    );
  }

  async function getJson(url: URL): Promise<{ status: number; body: Json | null }> {
    const res = await send(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      retry: true,
    });
    if (res.status === 404) {
      await res.body?.cancel();
      return { status: 404, body: null };
    }
    if (res.status !== 200) throw await failure(url, "GET", res);
    const body: unknown = await res.json().catch(() => null);
    if (!isObject(body)) throw new PlatehouseError(`GET ${url.pathname}: the answer is not JSON`);
    return { status: 200, body };
  }

  async function getModel(id: string): Promise<PlatehouseModel | undefined> {
    const { body } = await getJson(api(`/models/${encodeURIComponent(id)}`));
    return body === null ? undefined : toModel(body);
  }

  async function findByExternalRef(ref: string): Promise<PlatehouseModel | undefined> {
    const url = api("/models");
    url.searchParams.set("externalRef", ref);
    const { body } = await getJson(url);
    const first = Array.isArray(body?.models) ? body.models.find(isObject) : undefined;
    const id = first === undefined ? null : str(first.id);
    return id === null ? undefined : getModel(id);
  }

  async function put(url: URL): Promise<void> {
    const res = await send(url, { method: "PUT", retry: true });
    if (res.status !== 204) throw await failure(url, "PUT", res);
    await res.body?.cancel();
  }

  /** Where the upload stands: its offset, or null when it is gone. */
  async function offsetOf(url: URL): Promise<number | null> {
    const res = await send(url, {
      method: "HEAD",
      headers: { "Tus-Resumable": "1.0.0" },
      retry: true,
    });
    await res.body?.cancel();
    if (res.status === 404 || res.status === 410) return null;
    if (res.status !== 200) throw new PlatehouseError(`HEAD ${url.pathname}: HTTP ${res.status}`);
    const offset = Number(res.headers.get("upload-offset"));
    if (!Number.isInteger(offset) || offset < 0) {
      throw new PlatehouseError(`HEAD ${url.pathname}: no Upload-Offset`);
    }
    return offset;
  }

  async function sendBytes(url: URL, bytes: Buffer): Promise<void> {
    let offset = 0;
    for (let attempt = 1; ; attempt++) {
      let problem: string;
      try {
        const res = await send(url, {
          method: "PATCH",
          headers: {
            "Tus-Resumable": "1.0.0",
            "Upload-Offset": String(offset),
            "Content-Type": "application/offset+octet-stream",
          },
          body: bytes.subarray(offset),
          retry: false,
          timeout: UPLOAD_TIMEOUT_MS,
        });
        if (res.status === 204) {
          await res.body?.cancel();
          const reached = Number(res.headers.get("upload-offset"));
          if (reached === bytes.length) return;
          if (Number.isInteger(reached) && reached > offset && reached < bytes.length) {
            offset = reached;
            attempt = 0;
            continue;
          }
          problem = `PATCH ${url.pathname}: Platehouse reports offset ${reached} of ${bytes.length}`;
        } else if (res.status === 409 || res.status >= 500) {
          problem = (await failure(url, "PATCH", res)).message;
        } else {
          throw await failure(url, "PATCH", res);
        }
      } catch (error) {
        if (!(error instanceof PlatehouseError) || error.status !== null) throw error;
        problem = error.message;
      }
      if (attempt >= attempts) throw new PlatehouseError(problem);
      log(`  ${problem}; asking where the upload stands, retry ${attempt}`);
      await sleep(2000 * 2 ** (attempt - 1));
      const at = await offsetOf(url);
      if (at === null) throw new PlatehouseError(`${problem}; the upload is gone`);
      if (at === bytes.length) return;
      offset = at;
    }
  }

  async function result(url: URL): Promise<{ modelId: string; fileId: string }> {
    const resultUrl = new URL(`${url.pathname}/result`, origin);
    for (let poll = 0; poll < POLL_LIMIT; poll++) {
      const { body } = await getJson(resultUrl);
      const status = str(body?.status);
      if (status === "done") {
        const modelId = str(body?.modelId);
        const fileId = str(body?.fileId);
        if (modelId === null || fileId === null) {
          throw new PlatehouseError("the upload is done, but its result names no model or file");
        }
        return { modelId, fileId };
      }
      if (status === "failed") {
        throw new PlatehouseError(
          `Platehouse did not take the file: ${str(body?.error) ?? "no reason given"}`,
        );
      }
      if (status !== "pending") {
        throw new PlatehouseError(
          `the upload's result is ${status ?? "missing"}; its outcome is unknown`,
        );
      }
      await sleep(POLL_MS);
    }
    throw new PlatehouseError(
      `the upload's result did not arrive in ${(POLL_LIMIT * POLL_MS) / 1000} s; its outcome ` +
        "is unknown, so check Platehouse before running again",
    );
  }

  return {
    async check() {
      const url = api("/models");
      url.searchParams.set("limit", "1");
      const res = await send(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        retry: true,
      });
      if (res.status === 401) {
        await res.body?.cancel();
        throw new PlatehouseError("Platehouse refused the token (HTTP 401)", 401);
      }
      if (res.status !== 200) throw await failure(url, "GET", res);
      await res.body?.cancel();
    },

    findByExternalRef,

    async createModel(input) {
      const url = api("/models");
      const res = await send(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(input),
        retry: true,
      });
      if (res.status === 201) {
        const body: unknown = await res.json().catch(() => null);
        const model = isObject(body) && isObject(body.model) ? body.model : null;
        if (model === null)
          throw new PlatehouseError("POST /api/v1/models: no model in the answer");
        return { created: toModel(model) };
      }
      if (res.status === 409) {
        const body: unknown = await res.json().catch(() => null);
        const trashed = isObject(body) && body.trashed === true;
        if (trashed) return { exists: true, trashed: true };
        // Live and taken: made by a first attempt whose answer was lost, or
        // by a run beside this one. Either way it is read back, not made again.
        const found = await findByExternalRef(input.externalRef);
        if (found === undefined) {
          throw new PlatehouseError(
            `POST /api/v1/models: ${input.externalRef} is taken, but no live model has it`,
          );
        }
        return { created: found };
      }
      throw await failure(url, "POST", res);
    },

    addTag: async (modelId, tag) => put(api(`/models/${segment(modelId)}/tags/${segment(tag)}`)),

    addToCollection: async (modelId, collection) =>
      put(api(`/collections/${segment(collection)}/models/${segment(modelId)}`)),

    async upload(modelId, filename, bytes) {
      const create = api("/uploads");
      const res = await send(create, {
        method: "POST",
        headers: {
          "Tus-Resumable": "1.0.0",
          "Upload-Length": String(bytes.length),
          "Upload-Metadata": `filename ${b64(filename)},modelId ${b64(modelId)}`,
        },
        retry: true,
      });
      if (res.status === 404) {
        await res.body?.cancel();
        throw new PlatehouseError("the Platehouse model is gone or in the trash", 404);
      }
      if (res.status !== 201) throw await failure(create, "POST", res);
      await res.body?.cancel();
      const location = res.headers.get("location");
      if (location === null) throw new PlatehouseError("POST /api/v1/uploads: no Location");
      const url = new URL(location, origin);
      if (url.origin !== origin || !url.pathname.startsWith("/api/v1/uploads/")) {
        throw new PlatehouseError(
          "POST /api/v1/uploads: the Location is not an upload on Platehouse",
        );
      }
      await sendBytes(url, bytes);
      const done = await result(url);
      if (done.modelId !== modelId) {
        throw new PlatehouseError(
          "Platehouse put the file in another model than the one asked for",
        );
      }
      const { body } = await getJson(api(`/files/${encodeURIComponent(done.fileId)}`));
      if (body === null) throw new PlatehouseError("the uploaded file cannot be read back");
      return toFile(body);
    },
  };
}
