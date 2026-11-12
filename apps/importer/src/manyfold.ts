// A read-only Manyfold API client, ported from manyfold.mjs at automation
// 1ce8c57 (build plan Task 23; AC-001, AC-003). It has no method that
// writes: the only request that is not a GET is the one token request.
//
// - One token per run: POST /oauth/token with grant_type=client_credentials
//   and scope=read, never repeated, not even after a failure (Manyfold allows
//   10 token requests per 3 minutes). The scope Manyfold grants must be read
//   and nothing else: a token answer with another scope, or none, stops the
//   run before anything is read, in case the OAuth app's settings changed. The token never leaves this module; it
//   is handed to the sensitive callback so the CLI's redactor knows it.
// - Every URL Manyfold hands back is rewritten from http: to https: (behind
//   Traefik it sends http:// links) and must stay on the base origin, so the
//   token is never sent anywhere else. A link to another origin is refused
//   before anything is sent there.
// - A file download is the one exception. Manyfold answers it with a
//   redirect: to its own host over https (followed with the token), to
//   another https host such as its object store (followed without the
//   Authorization header, since the presigned URL's signature is its
//   credential, and that query string is handed to the sensitive callback and
//   never logged), or to anything that is not https, its own host included
//   (refused, not upgraded). At most 3 redirects.
// - Every request has a timeout. GETs retry network errors and 5xx with
//   backoff (2, 4, 8 s) and wait out a 429 for its Retry-After (at most 300
//   s; 60 s when there is none; the normal backoff when it is not a positive
//   number of seconds), up to 4 attempts in all.
// - A download's byte count is checked against Manyfold's contentSize while
//   it streams; a mismatch is a SizeMismatch and nothing is returned.
// - Log lines and errors name the path on Manyfold, and only the host and
//   path anywhere else. An error answer's body is quoted (200 characters at
//   most, control characters taken out and then redacted before it is cut)
//   only when it came from Manyfold; the token request quotes only
//   Doorkeeper's error code.

import { cleanText } from "./redact.js";

/** The media type of Manyfold's JSON API (v0). */
export const MANYFOLD_MEDIA_TYPE = "application/vnd.manyfold.v0+json";

export class ManyfoldError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "ManyfoldError";
    this.status = status;
  }
}

/** A download whose byte count is not Manyfold's contentSize. */
export class SizeMismatch extends ManyfoldError {
  readonly expected: number;
  readonly actual: number;
  constructor(message: string, expected: number, actual: number) {
    super(message);
    this.name = "SizeMismatch";
    this.expected = expected;
    this.actual = actual;
  }
}

export interface ManyfoldOptions {
  base: string;
  clientId: string;
  /** The OAuth client's secret. */
  clientKey: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** Called with every value the output must never show: the token, a signed query. */
  sensitive?: (value: string) => void;
  /**
   * Applied to an error body before it is cut to its quote length, so a
   * credential Manyfold echoes is replaced whole rather than cut in two
   * (the CLI passes its redactor).
   */
  redact?: (text: string) => string;
  retries?: number;
  timeoutMs?: number;
  downloadTimeoutMs?: number;
}

export interface ManyfoldListEntry {
  id: string;
  url: string;
  name: string;
}

export interface ManyfoldModel {
  id: string;
  url: string;
  name: string;
  caption: string | null;
  description: string | null;
  creatorUrl: string | null;
  license: string | null;
  keywords: string[];
  collectionUrls: string[];
  parts: Array<{ url: string; name: string | null }>;
}

export interface ManyfoldFile {
  url: string;
  filename: string;
  contentUrl: string;
  contentSize: number | null;
}

export interface Manyfold {
  /** Asks for the run's one token (scope read). */
  authenticate(): Promise<void>;
  listModels(): Promise<ManyfoldListEntry[]>;
  /** Creator URL to name, every page. */
  listCreators(): Promise<Map<string, string>>;
  /** Collection URL to name, every page. */
  listCollections(): Promise<Map<string, string>>;
  modelUrl(id: string): string;
  getModel(url: string): Promise<ManyfoldModel>;
  /** The name of a creator or collection, read by its URL. */
  getName(url: string): Promise<string | null>;
  getFile(url: string): Promise<ManyfoldFile>;
  download(url: string, expectedSize: number): Promise<Buffer>;
}

const MAX_REDIRECTS = 3;
const MAX_RETRY_AFTER_S = 300;
const BODY_QUOTE = 200;

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The backoff before retry n (1, 2, 3): 2, 4, 8 s. */
const backoff = (attempt: number) => 2000 * 2 ** (attempt - 1);

/**
 * How long to wait after a 429, in ms. No Retry-After: 60 s, as the prior
 * art waited. A positive number of seconds: that, at most 300 s. Anything
 * else, such as a negative or zero value, an HTTP date or junk: the normal
 * backoff, so a 429 is never retried with no wait.
 */
function retryAfter(header: string | null, attempt: number): number {
  if (header === null) return 60_000;
  const seconds = Number(header);
  return seconds > 0 ? Math.min(seconds, MAX_RETRY_AFTER_S) * 1000 : backoff(attempt);
}

/**
 * An error body as it may be quoted: on one line, without control
 * characters, redacted, then cut to BODY_QUOTE. The order matters. Control
 * characters go before redaction, or a credential echoed with one inside it
 * would get past the redactor and be joined up when they are taken out;
 * redaction goes before the cut, or a credential that crosses BODY_QUOTE
 * would be printed in part, which the redactor cannot recognise.
 */
function quoted(text: string, redact: (text: string) => string): string {
  return redact(cleanText(text.replace(/\s+/g, " ")))
    .trim()
    .slice(0, BODY_QUOTE);
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** The last segment of a URL's path: a Manyfold public id. */
function lastSegment(url: URL): string {
  const parts = url.pathname.split("/").filter((p) => p !== "");
  return decodeURIComponent(parts.at(-1) ?? "");
}

function why(error: unknown, timeout: number): string {
  const e = error as { name?: string; message?: string; cause?: { code?: string } };
  if (e.name === "TimeoutError") return `timed out after ${Math.round(timeout / 1000)} s`;
  const code = e.cause?.code;
  return `${e.message ?? String(error)}${code === undefined ? "" : ` (${code})`}`;
}

export function createManyfold(options: ManyfoldOptions): Manyfold {
  const origin = new URL(options.base).origin;
  const hostname = new URL(origin).hostname;
  const doFetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? realSleep;
  const log = options.log ?? (() => {});
  const sensitive = options.sensitive ?? (() => {});
  const redact = options.redact ?? ((text: string) => text);
  const attempts = options.retries ?? 4;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const downloadTimeoutMs = options.downloadTimeoutMs ?? 600_000;
  let token: string | null = null;
  let asked = false;

  /** A URL Manyfold gave, as https on the base origin; refuses any other origin. */
  function safeUrl(link: string): URL {
    let url: URL;
    try {
      url = new URL(link.replace(/^http:\/\//i, "https://"), origin);
    } catch {
      throw new ManyfoldError("Manyfold gave a link that is not a URL");
    }
    if (url.origin !== origin) {
      throw new ManyfoldError(`refusing to follow a link off ${origin}: ${url.origin}`);
    }
    return url;
  }

  /** For log lines and errors: the path on Manyfold, host and path elsewhere. */
  const shortPath = (url: URL) =>
    url.origin === origin ? url.pathname + url.search : url.host + url.pathname;

  async function request(url: URL, accept: string, timeout: number): Promise<Response> {
    const onManyfold = url.origin === origin;
    for (let attempt = 1; ; attempt++) {
      const headers: Record<string, string> = { Accept: accept };
      if (onManyfold) {
        if (token === null) throw new ManyfoldError("no token: authenticate first");
        headers.Authorization = `Bearer ${token}`;
      }
      let res: Response;
      try {
        res = await doFetch(url, {
          method: "GET",
          headers,
          redirect: "manual",
          signal: AbortSignal.timeout(timeout),
        });
      } catch (error) {
        const reason = why(error, timeout);
        if (attempt < attempts) {
          log(`  GET ${shortPath(url)}: ${reason}, retry ${attempt}`);
          await sleep(backoff(attempt));
          continue;
        }
        throw new ManyfoldError(`GET ${shortPath(url)}: ${reason}`);
      }
      if (res.status === 429 && attempt < attempts) {
        const wait = retryAfter(res.headers.get("retry-after"), attempt);
        log(`  GET ${shortPath(url)}: HTTP 429, waiting ${wait / 1000} s`);
        await res.body?.cancel();
        await sleep(wait);
        continue;
      }
      if (res.status >= 500 && attempt < attempts) {
        log(`  GET ${shortPath(url)}: HTTP ${res.status}, retry ${attempt}`);
        await res.body?.cancel();
        await sleep(backoff(attempt));
        continue;
      }
      return res;
    }
  }

  async function failure(url: URL, res: Response): Promise<ManyfoldError> {
    let quote = "";
    if (url.origin === origin) {
      const text = await res.text().catch(() => "");
      quote = quoted(text, redact);
    } else {
      await res.body?.cancel();
    }
    return new ManyfoldError(
      `GET ${shortPath(url)}: HTTP ${res.status}${quote === "" ? "" : ` ${quote}`}`,
      res.status,
    );
  }

  async function getJson(link: string): Promise<Json> {
    const url = safeUrl(link);
    const res = await request(url, MANYFOLD_MEDIA_TYPE, timeoutMs);
    if (res.status !== 200) throw await failure(url, res);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new ManyfoldError(`GET ${shortPath(url)}: the answer is not JSON`);
    }
    if (!isObject(body))
      throw new ManyfoldError(`GET ${shortPath(url)}: the answer is not an object`);
    return body;
  }

  async function authenticate(): Promise<void> {
    if (asked) {
      if (token !== null) return;
      throw new ManyfoldError("the token request already failed in this run");
    }
    asked = true;
    const url = new URL("/oauth/token", origin);
    const basic = Buffer.from(`${options.clientId}:${options.clientKey}`).toString("base64");
    sensitive(basic);
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: { Authorization: `Basic ${basic}`, Accept: "application/json" },
        body: new URLSearchParams({ grant_type: "client_credentials", scope: "read" }),
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new ManyfoldError(`token request failed: ${why(error, timeoutMs)}`);
    }
    if (res.status !== 200) {
      // Doorkeeper answers {error, error_description}; only a plain error code is shown.
      const code = await res
        .json()
        .then((j: unknown) => (isObject(j) ? str(j.error) : null))
        .catch(() => null);
      const shown = code !== null && /^[a-z_]{1,40}$/.test(code) ? ` ${code}` : "";
      throw new ManyfoldError(`token request refused: HTTP ${res.status}${shown}`, res.status);
    }
    const body: unknown = await res.json().catch(() => null);
    const value = isObject(body) ? str(body.access_token) : null;
    if (value === null || value === "") {
      throw new ManyfoldError("the token answer had no access_token");
    }
    // Known to the redactor even when it is refused below, though no message
    // here ever names it.
    sensitive(value);
    const scope = isObject(body) ? body.scope : undefined;
    if (typeof scope !== "string") {
      throw new ManyfoldError(
        "the token answer names no scope, so it cannot be shown to be read only",
      );
    }
    const granted = new Set(scope.split(/\s+/).filter((x) => x !== ""));
    if (granted.size !== 1 || !granted.has("read")) {
      // Quoted only when it is plain scope words, so nothing else Manyfold
      // put in the field is printed.
      const what = /^[a-z_: ]{0,60}$/.test(scope) ? `scope "${scope}",` : "a scope that is";
      throw new ManyfoldError(`Manyfold granted ${what} not read only; nothing was read`);
    }
    token = value;
  }

  /** Every member of a paged list, following view.next, checked against totalItems. */
  async function listAll(path: string): Promise<Array<{ url: string; name: string }>> {
    const members: Array<{ url: string; name: string }> = [];
    const visited = new Set<string>();
    let total: number | null = null;
    let next: string | null = path;
    let last = path;
    while (next !== null) {
      const url = safeUrl(next).toString();
      if (visited.has(url)) throw new ManyfoldError(`${path}: the pages loop back to ${url}`);
      visited.add(url);
      last = shortPath(new URL(url));
      let page: Json;
      try {
        page = await getJson(url);
      } catch (error) {
        const read = `${members.length} of ${total ?? "an unknown number"}`;
        throw new ManyfoldError(
          `${path}: read ${read} before ${last} failed: ${(error as Error).message}`,
        );
      }
      if (total === null && typeof page.totalItems === "number") total = page.totalItems;
      for (const m of Array.isArray(page.member) ? page.member : []) {
        const id = isObject(m) ? str(m["@id"]) : null;
        if (id === null) throw new ManyfoldError(`${path}: a member has no @id`);
        members.push({ url: safeUrl(id).toString(), name: str((m as Json).name) ?? "" });
      }
      const view = page.view;
      next = isObject(view) ? str(view.next) : null;
    }
    if (total !== null && members.length !== total) {
      throw new ManyfoldError(
        `${path}: read ${members.length} of ${total} (totalItems); the list ended at ${last}`,
      );
    }
    return members;
  }

  const names = async (path: string) =>
    new Map((await listAll(path)).map((m) => [m.url, m.name] as const));

  function refs(value: unknown): string[] {
    const list = Array.isArray(value)
      ? value
      : value === undefined || value === null
        ? []
        : [value];
    return list.map((r) => {
      const id = isObject(r) ? str(r["@id"]) : null;
      if (id === null) throw new ManyfoldError("a linked item has no @id");
      return safeUrl(id).toString();
    });
  }

  return {
    authenticate,

    async listModels() {
      return (await listAll("/models")).map((m) => ({
        id: lastSegment(new URL(m.url)),
        url: m.url,
        name: m.name,
      }));
    },

    listCreators: () => names("/creators"),
    listCollections: () => names("/collections"),

    modelUrl: (id) => safeUrl(`/models/${encodeURIComponent(id)}`).toString(),

    async getModel(link) {
      const j = await getJson(link);
      const self = safeUrl(str(j["@id"]) ?? link);
      const creator = isObject(j.creator) ? str(j.creator["@id"]) : null;
      const license = isObject(j["spdx:license"]) ? str(j["spdx:license"].licenseId) : null;
      const parts = (Array.isArray(j.hasPart) ? j.hasPart : []).map((p) => {
        const id = isObject(p) ? str(p["@id"]) : null;
        if (id === null) throw new ManyfoldError(`${shortPath(self)}: a file has no @id`);
        return { url: safeUrl(id).toString(), name: str((p as Json).name) };
      });
      return {
        id: lastSegment(self),
        url: self.toString(),
        name: str(j.name) ?? "",
        caption: str(j.caption),
        description: str(j.description),
        creatorUrl: creator === null ? null : safeUrl(creator).toString(),
        license,
        keywords: (Array.isArray(j.keywords) ? j.keywords : []).filter(
          (k): k is string => typeof k === "string",
        ),
        collectionUrls: refs(j.isPartOf),
        parts,
      };
    },

    async getName(link) {
      return str((await getJson(link)).name);
    },

    async getFile(link) {
      const j = await getJson(link);
      const self = safeUrl(str(j["@id"]) ?? link);
      const contentUrl = str(j.contentUrl);
      if (contentUrl === null) throw new ManyfoldError(`${shortPath(self)}: no contentUrl`);
      const filename = str(j.filename) ?? str(j.name);
      if (filename === null || filename === "") {
        throw new ManyfoldError(`${shortPath(self)}: no filename`);
      }
      const size = j.contentSize;
      return {
        url: self.toString(),
        filename,
        contentUrl: safeUrl(contentUrl).toString(),
        contentSize: typeof size === "number" && Number.isInteger(size) && size >= 0 ? size : null,
      };
    },

    async download(link, expectedSize) {
      let url = safeUrl(link);
      for (let hop = 0; ; hop++) {
        const res = await request(url, "*/*", downloadTimeoutMs);
        const location = res.headers.get("location");
        if (res.status >= 300 && res.status < 400 && location !== null) {
          await res.body?.cancel();
          if (hop >= MAX_REDIRECTS) {
            throw new ManyfoldError(`GET ${shortPath(url)}: more than ${MAX_REDIRECTS} redirects`);
          }
          const next = new URL(location, url);
          if (next.protocol !== "https:") {
            // Refused on Manyfold's own host too, not upgraded: the plan
            // says a non-https redirect is refused.
            if (next.search.length > 1) sensitive(next.search.slice(1));
            throw new ManyfoldError(
              `GET ${shortPath(url)}: refusing a redirect that is not https, to ${next.host}`,
            );
          }
          if (next.hostname === hostname) {
            url = safeUrl(next.toString());
          } else {
            if (next.search.length > 1) sensitive(next.search.slice(1));
            url = next;
          }
          continue;
        }
        if (res.status !== 200) throw await failure(url, res);
        const chunks: Buffer[] = [];
        let got = 0;
        try {
          if (res.body !== null) {
            for await (const chunk of res.body) {
              got += chunk.byteLength;
              if (got > expectedSize) {
                await res.body.cancel().catch(() => {});
                throw new SizeMismatch(
                  `size mismatch: got more than ${expectedSize} bytes, Manyfold says ${expectedSize}`,
                  expectedSize,
                  got,
                );
              }
              chunks.push(Buffer.from(chunk));
            }
          }
        } catch (error) {
          if (error instanceof SizeMismatch) throw error;
          throw new ManyfoldError(`GET ${shortPath(url)}: ${why(error, downloadTimeoutMs)}`);
        }
        if (got !== expectedSize) {
          throw new SizeMismatch(
            `size mismatch: got ${got} bytes, Manyfold says ${expectedSize}`,
            expectedSize,
            got,
          );
        }
        return Buffer.concat(chunks);
      }
    },
  };
}
