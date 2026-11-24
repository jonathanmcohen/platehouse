// A read-only Manyfold API client, first written as a standalone script. It
// never changes Manyfold and keeps every credential out of what the importer
// prints. It has no method that
// writes: the only request that is not a GET is the one token request.
//
// - One token request at start-up: POST /oauth/token with
//   grant_type=client_credentials and scope=read, never repeated after a
//   refusal (Manyfold allows 10 token requests per 3 minutes). After that a
//   token is renewed only before it expires (when expires_in is given) and
//   once after a 401 from Manyfold's own origin, never for a 401 from
//   another host. A renewal makes the same request and the same checks. A
//   failed renewal fails the request that needed it, and a second one in a
//   row, or one granted more than read, stops the run. The scope Manyfold
//   grants must be read and nothing else: a token answer with another scope,
//   or none, stops the run before anything is read, in case the OAuth app's
//   settings changed. A token never leaves this module; each one is handed to
//   the sensitive callback so the CLI's redactor knows it, the old ones too.
// - Every URL Manyfold hands back is rewritten from http: to https: (behind
//   a reverse proxy that terminates TLS it may send http:// links) and must
//   stay on the base origin, so the
//   token is never sent anywhere else. A link to another origin is refused
//   before anything is sent there.
// - A file download is the one exception. Manyfold answers it with a
//   redirect: to its own host over https (followed with the token), to
//   another https host such as its object store (followed without the
//   Authorization header, since the presigned URL's signature is its
//   credential, and that query string is handed to the sensitive callback and
//   never logged), or to anything that is not https, its own host included
//   (refused, not upgraded). At most 3 redirects. Every redirect's query,
//   one back to Manyfold's own host included, goes to the sensitive callback
//   before the redirect is followed or refused, and each sensitive value of
//   such a query (a signature, a credential, a session token) is handed to
//   the callback on its own too, raw and decoded, so a server that echoes
//   one parameter alone is still redacted (signedQueryValues; issue #168;
//   PR #211 security review). Nothing under 8 characters is handed over,
//   the whole query included, and a query on Manyfold's own host is handed
//   over only when it holds a sensitive parameter, so an ordinary query such
//   as "?download" never becomes a secret that mangles the output (PR #211
//   review).
// - Every request has a timeout. GETs retry network errors and 5xx with
//   backoff (2, 4, 8 s) and wait out a 429 for its Retry-After (at most 300
//   s; 60 s when there is none; the normal backoff when it is not a positive
//   number of seconds), up to 4 attempts in all.
// - A download's byte count is checked against Manyfold's contentSize while
//   it streams; a mismatch is a SizeMismatch and nothing is returned.
// - Log lines and errors name the path on Manyfold, and only the host and
//   path anywhere else. A download hop's log lines and errors name the path
//   without its query, even on Manyfold, since a redirect may have signed it
//   (downloadPath). An error answer's body is quoted (200 characters at
//   most, control characters taken out and then redacted before it is cut)
//   only when it came from Manyfold; the token request quotes only
//   Doorkeeper's error code.

import { type IdleWatch, idleReason, idleWatch } from "./idle.js";
import { fileNameFor } from "./plan.js";
import { quoteBody } from "./redact.js";

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

/**
 * A failure that must end the run, not just fail one model: a renewed token
 * granted more than read, or two renewals in a row that failed.
 */
export class TokenRenewalError extends ManyfoldError {
  constructor(message: string) {
    super(message);
    this.name = "TokenRenewalError";
  }
}

/** A token answer whose scope is not exactly read. */
class ScopeError extends ManyfoldError {}

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
  /** The clock for token expiry, in ms; Date.now when not given. */
  now?: () => number;
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
  /**
   * A file download's idle limit, in ms: the download fails when no byte has
   * arrived for this long, waiting for the answer included. It never limits
   * the whole transfer, so a large file over a slow link still finishes
   * (0.1.0 release review). DEFAULT_DOWNLOAD_IDLE_MS when not given.
   */
  downloadTimeoutMs?: number;
}

/** A download's idle limit when none is given: 2 minutes without a byte. */
export const DEFAULT_DOWNLOAD_IDLE_MS = 120_000;

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
  /** The name to upload it under (plan.ts fileNameFor), or the report's label when problem is set. */
  filename: string;
  contentUrl: string;
  contentSize: number | null;
  /** Why no file name with an extension could be found; the file then fails. */
  problem: string | null;
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

/** An error body as it may be quoted: see quoteBody for the order and why. */
function quoted(text: string, redact: (text: string) => string): string {
  return quoteBody(text, redact, BODY_QUOTE);
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

/**
 * The query parameters of an object-store link whose values are credentials:
 * a signature (X-Amz-Signature, Signature, sig), a credential or access key
 * id (X-Amz-Credential, AWSAccessKeyId, X-Goog-Credential) or a session
 * token (X-Amz-Security-Token).
 */
const SENSITIVE_PARAM = /signature|credential|security-token|token|accesskeyid|^sig$/i;

/** A value this short is not a credential, and redacting it would mangle ordinary output. */
const MIN_SENSITIVE_LENGTH = 8;

/**
 * Every value the output must never show for a signed link's query: the
 * whole query, and each sensitive parameter's value on its own, as sent and
 * decoded (issue #168). Nothing under MIN_SENSITIVE_LENGTH is registered,
 * the whole query included, so a short ordinary query such as "v=1" never
 * mangles the output. With requireSigned (a hop on Manyfold's own host,
 * whose queries are ordinary unless signed), nothing at all is registered
 * unless the query holds a sensitive parameter, so "?download" there never
 * makes the word "download" a secret (PR #211 review).
 */
export function signedQueryValues(
  search: string,
  options: { requireSigned?: boolean } = {},
): string[] {
  const query = search.startsWith("?") ? search.slice(1) : search;
  if (query === "") return [];
  let signed = false;
  const values: string[] = [];
  for (const pair of query.split("&")) {
    const at = pair.indexOf("=");
    if (at === -1) continue;
    const name = pair.slice(0, at);
    const raw = pair.slice(at + 1);
    let decodedName = name;
    let decoded = raw;
    try {
      decodedName = decodeURIComponent(name.replaceAll("+", " "));
      decoded = decodeURIComponent(raw.replaceAll("+", " "));
    } catch {
      // A malformed escape: the raw value is still registered.
    }
    if (!SENSITIVE_PARAM.test(decodedName)) continue;
    signed = true;
    for (const value of new Set([raw, decoded])) {
      if (value.length >= MIN_SENSITIVE_LENGTH) values.push(value);
    }
  }
  if (options.requireSigned === true && !signed) return [];
  return query.length >= MIN_SENSITIVE_LENGTH ? [query, ...values] : values;
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
  const downloadIdleMs = options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_IDLE_MS;
  const now = options.now ?? Date.now;
  let token: string | null = null;
  let asked = false;
  /** When the token expires and how long it lives, in ms; null without an expires_in. */
  let expiresAt: number | null = null;
  let lifetimeMs = 0;
  let renewing: Promise<void> | null = null;
  let renewalsFailed = 0;

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

  /**
   * For a download hop's log lines and errors: the path on Manyfold and host
   * and path elsewhere, never the query, which a redirect may have signed.
   */
  const downloadPath = (url: URL) =>
    url.origin === origin ? url.pathname : url.host + url.pathname;

  /**
   * One GET with retries. With a watch (a download), each attempt's limit is
   * the watch's idle limit instead of the whole-request timeout.
   */
  async function request(
    url: URL,
    accept: string,
    timeout: number,
    named: (url: URL) => string = shortPath,
    watch?: IdleWatch,
  ): Promise<Response> {
    const onManyfold = url.origin === origin;
    let renewedOn401 = false;
    for (let attempt = 1; ; attempt++) {
      if (onManyfold && expiresDue()) await renew();
      const headers: Record<string, string> = { Accept: accept };
      let sent: string | null = null;
      if (onManyfold) {
        sent = token;
        if (token === null) throw new ManyfoldError("no token: authenticate first");
        headers.Authorization = `Bearer ${token}`;
      }
      let res: Response;
      try {
        res = await doFetch(url, {
          method: "GET",
          headers,
          redirect: "manual",
          signal: watch === undefined ? AbortSignal.timeout(timeout) : watch.arm(),
        });
      } catch (error) {
        const reason = idleReason(watch) ?? why(error, timeout);
        if (attempt < attempts) {
          log(`  GET ${named(url)}: ${reason}, retry ${attempt}`);
          await sleep(backoff(attempt));
          continue;
        }
        throw new ManyfoldError(`GET ${named(url)}: ${reason}`);
      }
      if (res.status === 401 && onManyfold && !renewedOn401) {
        // Once per request: a renewal, then the same request again. A token
        // already renewed since this one was sent is just retried with.
        renewedOn401 = true;
        await res.body?.cancel();
        if (token === sent) await renew();
        attempt--;
        continue;
      }
      if (res.status === 429 && attempt < attempts) {
        const wait = retryAfter(res.headers.get("retry-after"), attempt);
        log(`  GET ${named(url)}: HTTP 429, waiting ${wait / 1000} s`);
        await res.body?.cancel();
        await sleep(wait);
        continue;
      }
      if (res.status >= 500 && attempt < attempts) {
        log(`  GET ${named(url)}: HTTP ${res.status}, retry ${attempt}`);
        await res.body?.cancel();
        await sleep(backoff(attempt));
        continue;
      }
      return res;
    }
  }

  async function failure(
    url: URL,
    res: Response,
    named: (url: URL) => string = shortPath,
  ): Promise<ManyfoldError> {
    let quote = "";
    if (url.origin === origin) {
      const text = await res.text().catch(() => "");
      quote = quoted(text, redact);
    } else {
      await res.body?.cancel();
    }
    return new ManyfoldError(
      `GET ${named(url)}: HTTP ${res.status}${quote === "" ? "" : ` ${quote}`}`,
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

  /** The token request and its checks, shared by start-up and renewal. */
  async function requestToken(): Promise<{ value: string; expiresIn: unknown }> {
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
      throw new ScopeError(`Manyfold granted ${what} not read only; nothing was read`);
    }
    return { value, expiresIn: isObject(body) ? body.expires_in : undefined };
  }

  /** Keeps a token, and when it runs out if the answer said so. */
  function keep(granted: { value: string; expiresIn: unknown }): void {
    token = granted.value;
    const seconds = granted.expiresIn;
    if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
      lifetimeMs = seconds * 1000;
      expiresAt = now() + lifetimeMs;
    } else {
      lifetimeMs = 0;
      expiresAt = null;
    }
  }

  async function authenticate(): Promise<void> {
    if (asked) {
      if (token !== null) return;
      throw new ManyfoldError("the token request already failed in this run");
    }
    asked = true;
    keep(await requestToken());
  }

  /** Whether the token is within its last tenth, or last 5 minutes, whichever is shorter. */
  function expiresDue(): boolean {
    if (expiresAt === null || renewing !== null) return false;
    return expiresAt - now() < Math.min(300_000, 0.1 * lifetimeMs);
  }

  /**
   * A new token, by the start-up request's shape and checks. A renewal never
   * triggers another (it does not go through request()), and callers that
   * arrive during one wait for it. One failure fails the request that needed
   * the renewal; a scope that is not read, or a second failure in a row,
   * stops the run.
   */
  function renew(): Promise<void> {
    if (renewing !== null) return renewing;
    const attempt = (async () => {
      try {
        keep(await requestToken());
        renewalsFailed = 0;
      } catch (error) {
        renewalsFailed++;
        const reason = error instanceof Error ? error.message : String(error);
        const text = `the Manyfold token could not be renewed: ${reason}`;
        if (error instanceof ScopeError || renewalsFailed >= 2) throw new TokenRenewalError(text);
        throw new ManyfoldError(text, error instanceof ManyfoldError ? error.status : null);
      } finally {
        renewing = null;
      }
    })();
    renewing = attempt;
    return attempt;
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

  const manyfold: Manyfold = {
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
      const content = str(j.contentUrl);
      if (content === null) throw new ManyfoldError(`${shortPath(self)}: no contentUrl`);
      const contentUrl = safeUrl(content).toString();
      // Never the name field alone: it is the display name, without the
      // extension (issue #226).
      const { name, problem } = fileNameFor({
        filename: str(j.filename),
        contentUrl,
        displayName: str(j.name),
      });
      const size = j.contentSize;
      return {
        url: self.toString(),
        filename: name,
        contentUrl,
        contentSize: typeof size === "number" && Number.isInteger(size) && size >= 0 ? size : null,
        problem,
      };
    },

    async download(link, expectedSize) {
      const watch = idleWatch(downloadIdleMs, "no data");
      try {
        return await downloadWith(watch, link, expectedSize);
      } finally {
        watch.stop();
      }
    },
  };

  /** download(), under one idle watch for every hop and attempt. */
  async function downloadWith(watch: IdleWatch, link: string, expectedSize: number) {
    let url = safeUrl(link);
    for (let hop = 0; ; hop++) {
      const res = await request(url, "*/*", downloadIdleMs, downloadPath, watch);
      watch.touch();
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location !== null) {
        await res.body?.cancel();
        if (hop >= MAX_REDIRECTS) {
          throw new ManyfoldError(`GET ${downloadPath(url)}: more than ${MAX_REDIRECTS} redirects`);
        }
        const next = new URL(location, url);
        // Every hop's query is registered before anything else, Manyfold's
        // own host included: a redirect there may be signed too. On that
        // host only a query holding a sensitive parameter is registered,
        // so an ordinary one such as "?download" never mangles the output.
        const sameHost = next.hostname === hostname;
        for (const value of signedQueryValues(next.search, { requireSigned: sameHost })) {
          sensitive(value);
        }
        if (next.protocol !== "https:") {
          // Refused on Manyfold's own host too, not upgraded: a non-https
          // redirect is always refused.
          throw new ManyfoldError(
            `GET ${downloadPath(url)}: refusing a redirect that is not https, to ${next.host}`,
          );
        }
        url = sameHost ? safeUrl(next.toString()) : next;
        continue;
      }
      if (res.status !== 200) throw await failure(url, res, downloadPath);
      const chunks: Buffer[] = [];
      let got = 0;
      if (res.body !== null) {
        const reader = res.body.getReader();
        // A stall ends the read even if the fetch does not error its body
        // when the signal aborts.
        const signal = watch.signal;
        let onAbort = () => {};
        const stalled = new Promise<never>((_, reject) => {
          onAbort = () => reject(signal.reason);
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        });
        stalled.catch(() => {});
        try {
          for (;;) {
            const next = await Promise.race([reader.read(), stalled]);
            if (next.done) break;
            watch.touch();
            got += next.value.byteLength;
            if (got > expectedSize) {
              throw new SizeMismatch(
                `size mismatch: got more than ${expectedSize} bytes, Manyfold says ${expectedSize}`,
                expectedSize,
                got,
              );
            }
            chunks.push(Buffer.from(next.value));
          }
        } catch (error) {
          await reader.cancel().catch(() => {});
          if (error instanceof SizeMismatch) throw error;
          const reason = idleReason(watch) ?? why(error, downloadIdleMs);
          throw new ManyfoldError(`GET ${downloadPath(url)}: ${reason}`);
        } finally {
          signal.removeEventListener("abort", onAbort);
        }
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
  }

  return manyfold;
}
