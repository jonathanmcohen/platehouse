// The Fastify app, with the route-class gate in front of every route. buildApp(deps) returns it
// with every route registered and nothing listening; start() in main.ts
// listens.
//
// - The route-class gate (auth/gate.ts) is installed first, so it covers
//   every route and every 404: session routes need a live session (a page
//   without one is sent to /auth/login, anything else gets 401), every
//   state-changing request on a session route (/app/uploads included) needs
//   Origin to be PUBLIC_ORIGIN, and public, bearer and link routes pass to
//   their own checks.
// - GET /auth/login, GET /auth/callback and POST /auth/logout (auth/routes.ts)
//   log the user in with the OIDC provider and out again.
// - GET /healthz answers 200 only when the database answers a query within
//   HEALTH_TIMEOUT_MS and pg-boss is started (and, when web.required is
//   set, the web build is there), else 503. The body is a fixed
//   word either way, never an error, a host or a port: the app image's
//   HEALTHCHECK (docker/app.Dockerfile) reads only the status.
// - The tus upload handler (uploads/tus.ts) is mounted at /app/uploads behind
//   requireSession and at /api/v1/uploads behind apiUploadHook: the bearer
//   check (api/tokens.ts), then, for a creation into an existing model, that
//   the model is live. Either hook runs before tus sees the request, so a
//   refused request stores nothing.
// - The Public API v1 (api/v1.ts) is mounted at /api/v1, every route
//   behind the bearer check, and its OpenAPI document (api/openapi.ts) is
//   generated from those routes with servers[0].url = absoluteUrl('/api/v1').
//   A request to an unknown path under /api/v1 gets the bearer check before
//   its 404, so without a token it is 401 like every other API request. No
//   CORS plugin is registered.
// - The web app's own JSON API under /app/api (app-api/: the library,
//   the model page, settings, tokens, organising and the
//   trash, and the Activity page's GET /app/api/activity), session-class, so the gate's session and Origin checks cover
//   every route. Without library the library routes answer an empty
//   library, without model every model is 404 and nothing is retried, and
//   without appApi the settings, tokens and organising routes are still registered and answer 503, as
//   the Activity route does without activity.
// - The web app (web/shell.ts): the shell pages (session-class)
//   answer with the built index.html, data-theme and the color-scheme meta
//   written in from the ph_theme cookie, and the hashed build output is
//   served under /assets/ (public-class). A missing build is logged at
//   startup; it also makes /healthz 503 only when web.required is set.
// - File delivery (delivery/download.ts) streams a file's bytes at
//   GET /files/:id/download and a blob's at GET /blobs/:id, both session-
//   class, and slicer links (delivery/links.ts) are minted at POST
//   /app/api/files/:id/slicer-link (session-class, so the gate's Origin
//   check covers it) and served at GET /s/<token>/<name> (the route
//   /s/:token/*), link-class: no session, the token alone. Registered only
//   when deps.delivery is given. A path under /s/, or one that normalises to
//   /s/ (auth/gate.ts isLinkPath), that matches no route (no name segment,
//   another method, a doubled slash, or delivery not registered) is a
//   refused link: 403 with an empty body and Cache-Control: no-store, never
//   a 404 that echoes the path. So is such a path Fastify itself refuses (a
//   bad percent escape, a segment over its maxParamLength): frameworkError.
//   Off /s/ Fastify's own answers keep their status and code but not its
//   message, which repeated the path (issue #177).
// - The request timeout lets a whole 512 MiB upload through as one PATCH on
//   a slow link (SLOW_LINK_BYTES_PER_SECOND), as curl sends it.
// - Because that timeout is so long, an answer given before the request's
//   body is read (a refusal, a 404, /healthz with a trickled body) has the
//   body released by the gate's onSend hook (releaseUnreadBody): the answer
//   carries Connection: close and the connection closes within DRAIN_MS,
//   instead of Node reading the body for up to REQUEST_TIMEOUT_MS. The root
//   app parses no body at all, so nothing waits for one first. Fastify's own
//   400 for a bad URL and 414 for an over-long parameter come before any
//   hook, so frameworkErrors releases the body for those.
// - The request log records each request's path without its query
//   (requestLogValue), so the OAuth code and state on /auth/callback never
//   reach it, with a slicer link's token and name replaced
//   (LOGGED_LINK_PATH) on any path that is or normalises to a /s/ path, so
//   no live link reaches it either (issue #169), as on any path whose first
//   segment reads loosely as "s" (/S/, /%53/, /s;x/; PR #211 security
//   review), and a fixed list
//   of its headers (LOGGED_HEADERS), with
//   Upload-Metadata cut to its key names (not the file name or model id)
//   and pino redacting Authorization, Cookie and Proxy-Authorization
//   (LOG_REDACT_PATHS), so no API token or session cookie reaches the log.
// - Every answer carries the app's Content-Security-Policy, Referrer-Policy
//   and X-Content-Type-Options (web/security-headers.ts, issue #449),
//   unless its route set its own; frameworkError sets them on Fastify's own
//   400 and 414 too. HSTS is left to the TLS-terminating proxy.
// - An error on a root route (not in a scope with its own handler) is
//   answered by the root error handler: a 4xx keeps its status and message,
//   a store outage is 503 {error: "unavailable"}, anything else is logged
//   and answered 500 {error: "internal"} with no path or cause (issue #455).

import { STATUS_CODES } from "node:http";
import fastifyCookie from "@fastify/cookie";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import { registerOpenApi } from "./api/openapi.js";
import { createBearerHook, tokenOf } from "./api/tokens.js";
import { API_PREFIX, type ApiDeps, apiUploadHook, refusingApi, registerV1 } from "./api/v1.js";
import { type AppActivity, registerActivityApi } from "./app-api/activity.js";
import { type AppLibrary, emptyAppLibrary, registerLibraryApi } from "./app-api/library.js";
import { registerLocalesApi } from "./app-api/locales.js";
import { type AppModel, emptyAppModel, registerModelApi } from "./app-api/model.js";
import { type OrganiseDeps, registerOrganiseApi } from "./app-api/organise.js";
import {
  type AppPlateMeshes,
  emptyPlateMeshes,
  registerPlateMeshApi,
} from "./app-api/plate-mesh.js";
import { registerSettingsApi, type SettingsApiDeps } from "./app-api/settings.js";
import { registerTokensApi, type TokensApiDeps } from "./app-api/tokens.js";
import { registerUsersApi, type UsersApiDeps } from "./app-api/users.js";
import { installGate, isLinkPath, patternClass, routeClass, sessionOf } from "./auth/gate.js";
import type { OidcClient } from "./auth/oidc.js";
import { registerAuthRoutes } from "./auth/routes.js";
import type { Sessions } from "./auth/sessions.js";
import { type DeliveryDeps, isStoreOutage, registerDownloads } from "./delivery/download.js";
import { LINK_ROUTE, registerLinks } from "./delivery/links.js";
import { createLocales, type Locales } from "./locales/locales.js";
import {
  REQUEST_TIMEOUT_MS,
  registerTus,
  releaseUnreadBody,
  SLOW_LINK_BYTES_PER_SECOND,
  type Uploads,
} from "./uploads/tus.js";
import { addSecurityHeaders, setSecurityHeaders } from "./web/security-headers.js";
import { defaultWebDir, registerWeb, type WebDeps } from "./web/shell.js";

/** Where the tus upload handler is mounted: one for the UI, one for the Public API v1. */
export const UPLOAD_PREFIXES = Object.freeze({
  app: "/app/uploads",
  api: "/api/v1/uploads",
});

/** How long /healthz waits for the database before it answers 503. */
export const HEALTH_TIMEOUT_MS = 3_000;

// The request timeout and the slow link it is sized for live beside the
// upload cap in uploads/tus.ts; exported from here as well for callers that
// read them from the app.
export { REQUEST_TIMEOUT_MS, SLOW_LINK_BYTES_PER_SECOND };

export interface AppHealth {
  /** Resolves when the database answers a query. */
  database(): Promise<unknown>;
  /** True while pg-boss is started and the queues are worked. */
  queuesRunning(): boolean;
}

/** What login, sessions and the route-class gate need (auth/). */
export interface AppAuth {
  oidc: OidcClient;
  sessions: Sessions;
  /** PUBLIC_ORIGIN, scheme and host only. */
  publicOrigin: string;
  /** Config.absoluteUrl: an absolute URL on PUBLIC_ORIGIN, never from a request. */
  absoluteUrl(path: string): string;
  /** The login cookie's signing key (loginCookieKey). */
  cookieSecret: Buffer;
  /** The clock for the login cookie's 10 minutes; the real one when left out. */
  now?: () => Date;
}

export interface AppDeps {
  health: AppHealth;
  /** The one upload store both mounts share (createUploads). */
  uploads: Uploads;
  auth: AppAuth;
  /**
   * The Public API v1's tokens and library (api/). The server always
   * passes its own; left out, no token is live (refusingApi), so every API
   * request is 401.
   */
  api?: ApiDeps;
  /**
   * File delivery and slicer links (delivery/): GET /files/:id/download, GET
   * /blobs/:id, POST /app/api/files/:id/slicer-link and the link route
   * /s/:token/* (GET /s/<token>/<name>). The server always passes its own;
   * left out, those routes are not registered, so their paths are unknown:
   * /files/ and /blobs/ and the mint route are session-class (401 without a
   * session, 404 with one), and any /s/ path is link-class, answered by the
   * not-found handler as a refused link (403, empty body).
   */
  delivery?: DeliveryDeps;
  /**
   * The library's app API (app-api/library.ts): the cards and tag filter of the library
   * page, read from the database and the estimates module's plate numbers. Left out, the
   * routes are still there and answer an empty library, so the route-class
   * test walks them.
   */
  library?: AppLibrary;
  /**
   * The model page's app API (app-api/model.ts): a model with its files, plates and
   * numbers, and the retry of a failed estimate. Left out, the routes are
   * still there (every model is 404, nothing is retried), so the
   * route-class test walks them.
   */
  model?: AppModel;
  /**
   * A .3mf plate's 3D view (issue #358): GET /app/api/plates/:id/mesh makes
   * the plate's GLB the first time it is opened. Left out, the route is
   * still there (every plate is 404), so the route-class test walks it.
   */
  plateMeshes?: AppPlateMeshes;
  /**
   * Fastify's request log: off when left out or false, to stdout when true,
   * or to this stream (the tests read it). Either way each request is logged
   * by requestLogValue, so its query is never in the log.
   */
  logger?: boolean | { write(line: string): unknown };
  /**
   * The built web app; apps/web/dist beside the server, not
   * required, when left out. With required, /healthz is also 503 while the
   * build is missing.
   */
  web?: WebDeps;
  /**
   * The web app's own JSON API under /app/api (settings, tokens and
   * organising; issue #322: Sign out everywhere). Session-class like every
   * route outside the listed prefixes. A module left out (or all of them)
   * still has its routes (so the route-class gate covers them), and they
   * answer 503. The server passes every module (main.ts checks it against
   * AppApiDeps); a test passes the ones it is about.
   */
  appApi?: Partial<AppApiDeps>;
  /**
   * The Activity page's app API (app-api/activity.ts): library numbers, job
   * progress, the slicer's health and recent events, read-only. Left out,
   * GET /app/api/activity is still registered (so the route-class gate
   * covers it) and answers 503.
   */
  activity?: AppActivity;
  /**
   * The languages (locales/locales.ts, the maintainer, 2026-11-19): the built-in
   * catalogs and LOCALES_DIR. They decide the shell page's lang, the login
   * pages' words and GET /app/api/locales. Left out, the built-in languages
   * only.
   */
  locales?: Locales;
}

/** What the settings, tokens and organising routes under /app/api and Sign out everywhere read and change. */
export interface AppApiDeps {
  settings: SettingsApiDeps;
  tokens: TokensApiDeps;
  organise: OrganiseDeps;
  users: UsersApiDeps;
}

/**
 * What the request log records of a request; a field it does not know is
 * left out. A type, not an interface, so it fits pino's indexed record.
 */
export type RequestLogValue = {
  method: string;
  /** The path only: the query is left out. */
  url: string;
  host?: string;
  remoteAddress?: string;
  remotePort?: number;
  /**
   * The request's LOGGED_HEADERS and credential headers, Upload-Metadata cut
   * to its key names; pino then redacts LOG_REDACT_PATHS.
   */
  headers?: Record<string, string | string[] | undefined>;
};

/**
 * The headers whose values the request log records. Any other header is left
 * out, so a token sent in a header of a client's own choosing, or a Referer
 * carrying a query, never reaches the log. The credential headers are kept
 * only for pino to redact (LOG_REDACT_PATHS), so the log shows they were sent.
 */
export const LOGGED_HEADERS: readonly string[] = Object.freeze([
  "accept",
  "content-length",
  "content-type",
  "host",
  "origin",
  "tus-resumable",
  "upload-length",
  "upload-metadata",
  "upload-offset",
  "user-agent",
  "x-forwarded-for",
  "x-forwarded-proto",
  "authorization",
  "cookie",
  "proxy-authorization",
]);

/** What pino replaces with "[Redacted]" in every log line: credentials. */
export const LOG_REDACT_PATHS: readonly string[] = Object.freeze([
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["proxy-authorization"]',
]);

/**
 * The key names of a tus Upload-Metadata header, comma-separated, without
 * their values: the log shows what an upload named, never the file name or
 * model id it carried.
 */
export function uploadMetadataKeys(header: string | string[] | undefined): string {
  const text = Array.isArray(header) ? header.join(",") : (header ?? "");
  return text
    .split(",")
    .map((pair) => pair.trim().split(" ")[0] ?? "")
    .filter((key) => key !== "")
    .join(",");
}

/** A slicer link's path as the request log shows it: token and name replaced. */
export const LOGGED_LINK_PATH = "/s/[link]/[name]";

/**
 * The path the request log shows: the url cut at the "?", and a slicer
 * link's token and name segments replaced (LOGGED_LINK_PATH), since the token
 * alone fetches the file for 10 minutes. That covers any path under /s/,
 * live, refused or unrouted, any path that normalises to one (a doubled
 * slash, an escaped letter, a dot segment or an absolute-form target;
 * isLinkPath, issue #169), any path Fastify routed to the link route, and
 * any path whose first segment reads loosely as "s" (readsAsLinkPrefix). A
 * /s/ path with no name segment after the token is "/s/[link]".
 */
function loggedPath(request: FastifyRequest): string {
  const url = request.url;
  const at = url.indexOf("?");
  const path = at === -1 ? url : url.slice(0, at);
  if (path.startsWith("/s/")) {
    return path.indexOf("/", 3) === -1 ? "/s/[link]" : LOGGED_LINK_PATH;
  }
  if (request.routeOptions?.url === LINK_ROUTE || isLinkPath(path)) return LOGGED_LINK_PATH;
  if (readsAsLinkPrefix(path)) return LOGGED_LINK_PATH;
  return path;
}

/** How many rounds of percent-decoding readsAsLinkPrefix applies at most. */
const LOG_DECODE_ROUNDS = 8;

/**
 * For the request log only, never for classing or routing: true when the
 * path's first segment, with every valid percent escape decoded (repeated
 * until none is left, at most LOG_DECODE_ROUNDS rounds), backslashes made
 * slashes, cut at the first ";" and lower-cased, is "s". Such a path may
 * carry a link token though neither the router nor the link class reads it
 * as /s/: /S/<token>, /%53/<token>, an "s" encoded four times, /s;x/<token>
 * (PR #211 security review). No route's first segment is "s" but the link
 * route's, so this hides nothing else.
 */
function readsAsLinkPrefix(path: string): boolean {
  let p = path;
  for (let i = 0; i < LOG_DECODE_ROUNDS && /%[0-9A-Fa-f]{2}/.test(p); i++) {
    p = p.replace(/%([0-9A-Fa-f]{2})/g, (_m, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
  }
  const first = p.replace(/\\/g, "/").replace(/^\/+/, "").split("/")[0] ?? "";
  return (first.split(";")[0] ?? "").toLowerCase() === "s";
}

/**
 * The request log's view of a request: Fastify's default fields, with the
 * url cut at the "?" and a slicer link's segments replaced (loggedPath). A
 * query can carry a secret: GET /auth/callback has the OAuth code and state
 * in it.
 */
export function requestLogValue(request: FastifyRequest): RequestLogValue {
  const value: RequestLogValue = {
    method: request.method,
    url: loggedPath(request),
  };
  if (request.host !== undefined) value.host = request.host;
  if (request.ip !== undefined) value.remoteAddress = request.ip;
  const port = request.socket?.remotePort;
  if (port !== undefined) value.remotePort = port;
  if (request.headers !== undefined) {
    const headers: Record<string, string | string[] | undefined> = {};
    for (const name of LOGGED_HEADERS) {
      const header = request.headers[name];
      if (header === undefined) continue;
      headers[name] = name === "upload-metadata" ? uploadMetadataKeys(header) : header;
    }
    value.headers = headers;
  }
  return value;
}

/** True when check() resolves within ms; a rejection or no answer is false. */
async function answers(check: () => Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([check().then(() => true as const), late]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The answer to an error Fastify raises before any hook runs: a path it
 * cannot decode (FST_ERR_BAD_URL, 400), a route parameter over maxParamLength
 * (FST_ERR_MAX_PARAM_LENGTH, 414) or a failed async constraint (500). Without
 * this Fastify writes the answer straight to the socket, so the gate's onSend
 * hook never releases a body the client declared and Node reads it for up to
 * REQUEST_TIMEOUT_MS.
 *
 * Under /s/, or on a path that normalises to /s/ (routeClass link), it is a
 * refused link, as the link route and the not-found handler answer one:
 * 403, an empty body and no-store. Off /s/ the body is Fastify's status
 * and code without its message, which repeated the request path (issue
 * #177; the maintainer, 2026-11-14, plan item 11).
 */
function frameworkError(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  releaseUnreadBody(request, reply);
  // No onSend hook runs for this answer, so the security headers are set here.
  setSecurityHeaders(reply);
  if (routeClass(request.url) === "link") {
    return reply.code(403).header("cache-control", "no-store").send();
  }
  const status = error.statusCode ?? 500;
  return reply.code(status).send({
    error: STATUS_CODES[status] ?? "Error",
    code: error.code,
    statusCode: status,
  });
}

/** Headers a failed route may have set that must not stay on the error answer. */
const FAILED_ANSWER_HEADERS: readonly string[] = [
  "content-type",
  "content-length",
  "content-disposition",
  "content-range",
  "content-encoding",
  "accept-ranges",
  "cache-control",
  "etag",
  "last-modified",
];

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { auth } = deps;
  const api = deps.api ?? refusingApi;
  const log = deps.logger ?? false;
  const logger: NonNullable<FastifyServerOptions["logger"]> =
    log === false
      ? false
      : {
          serializers: { req: requestLogValue },
          redact: { paths: [...LOG_REDACT_PATHS], censor: "[Redacted]" },
          ...(log === true ? {} : { stream: log }),
        };
  const app = Fastify({
    logger,
    requestTimeout: REQUEST_TIMEOUT_MS,
    frameworkErrors: frameworkError,
  });

  // Errors on root routes (a static file that cannot be read, a hook that
  // fails). Scopes with their own handler keep it. A 4xx keeps its status
  // and message; a store outage is 503 as the scoped handlers answer it;
  // anything else is logged and answered 500 with no detail, so no path,
  // host or query reaches the client. The security headers are set by the
  // onSend hook below, which also runs for these answers.
  app.setErrorHandler(async (error: FastifyError, request, reply) => {
    // The status as Fastify's default handler works it out: the error's own,
    // else one the route already set, else 500.
    const loose = error as FastifyError & {
      status?: number;
      headers?: Record<string, string | number | string[]>;
    };
    const own = loose.statusCode ?? loose.status;
    const set = reply.statusCode;
    const fromError = own !== undefined && own >= 400 && own <= 599;
    const status = fromError ? own : set >= 400 && set <= 599 ? set : 500;
    // What the failed route had set for its own answer (a static file's type,
    // length, caching and validators) does not describe this one.
    for (const name of FAILED_ANSWER_HEADERS) reply.removeHeader(name);
    if (status < 500) {
      if (loose.headers !== undefined) reply.headers(loose.headers);
      // The error's own message and code are kept only when the error chose
      // the status; an error the route did not mean as a 4xx says nothing.
      return reply.code(status).send(
        fromError
          ? {
              error: STATUS_CODES[status] ?? "Error",
              code: error.code,
              message: error.message,
              statusCode: status,
            }
          : { error: STATUS_CODES[status] ?? "Error", statusCode: status },
      );
    }
    request.log.error({ err: error }, "app: a request failed");
    reply.header("cache-control", "no-store");
    if (isStoreOutage(error)) return reply.code(503).send({ error: "unavailable" });
    return reply.code(500).send({ error: "internal" });
  });
  // The CSP, Referrer-Policy and nosniff on every answer (web/security-headers.ts),
  // added first so every route, scope, refusal and error answer gets them.
  addSecurityHeaders(app);
  // Cookies are parsed before the gate runs; the login cookie is signed.
  await app.register(fastifyCookie, { secret: auth.cookieSecret });
  // The OpenAPI generator sees every route registered after it.
  await registerOpenApi(app, { serverUrl: auth.absoluteUrl(API_PREFIX) });
  const { requireSession } = installGate(app, {
    sessions: auth.sessions,
    publicOrigin: auth.publicOrigin,
    absoluteUrl: auth.absoluteUrl,
  });

  // Every bearer-class answer is no-store unless its route set its own
  // Cache-Control: the v1 routes, the tus mount at /api/v1/uploads (its own
  // scope, which registerV1's hook does not reach) and the 404 a token gets
  // on an unknown /api/v1 path. Added before the not-found handler, so that
  // handler's answers run it too.
  app.addHook("onSend", async (request, reply, payload) => {
    const pattern = request.routeOptions.url;
    const cls = pattern === undefined ? routeClass(request.url) : patternClass(pattern);
    if (cls === "bearer" && !reply.hasHeader("cache-control")) {
      reply.header("cache-control", "no-store");
    }
    return payload;
  });

  const webDeps = deps.web ?? { dir: defaultWebDir() };
  app.get("/healthz", async (_request, reply) => {
    const up =
      deps.health.queuesRunning() &&
      (await answers(deps.health.database, HEALTH_TIMEOUT_MS)) &&
      (webDeps.required !== true || (await web.built()));
    reply.header("cache-control", "no-store");
    return reply.code(up ? 200 : 503).send({ status: up ? "ok" : "unavailable" });
  });

  // The app's 404 answer; the gate's onSend hook releases any body. An
  // unknown path under /api/v1 is bearer-class: no token, no 404. An
  // unmatched link-class path (/s/ with no name segment, a POST or OPTIONS
  // on a link, junk) is a refused link, as the route answers one: 403 with
  // an empty body and no-store, so the path, a token in it included, is
  // never echoed and no cache keeps the answer. Any other 404 is Fastify's
  // status and error without its message, which repeated the method, path
  // and query (issue #177; PR #211 security review).
  const apiBearer = createBearerHook(api.tokens);
  app.setNotFoundHandler(async (request, reply) => {
    if (routeClass(request.url) === "link") {
      return reply.code(403).header("cache-control", "no-store").send();
    }
    if (routeClass(request.url) === "bearer") {
      await apiBearer(request, reply);
      if (reply.sent) return reply;
    }
    return reply.code(404).send({ error: "Not Found", statusCode: 404 });
  });

  const locales = deps.locales ?? createLocales();
  // The background reads of LOCALES_DIR stop with the server.
  app.addHook("onClose", async () => locales.close());
  await registerAuthRoutes(app, {
    locales,
    oidc: auth.oidc,
    sessions: auth.sessions,
    publicOrigin: auth.publicOrigin,
    absoluteUrl: auth.absoluteUrl,
    ...(auth.now === undefined ? {} : { now: auth.now }),
  });

  await registerTus(app, {
    prefix: UPLOAD_PREFIXES.app,
    authHook: requireSession,
    uploads: deps.uploads,
    // The web app shows a failure by its code, in its language.
    resultCodes: "all",
    // Each session may hold only so many unfinished uploads (Uploads.reserve).
    principalOf: (request) => {
      const id = sessionOf(request)?.id;
      return id === undefined ? undefined : `session:${id}`;
    },
    // Who the log names when uploads are refused for want of room: the
    // session's user, which outlives the session row.
    holderOf: (request) => {
      const subject = sessionOf(request)?.subject;
      return subject === undefined ? undefined : `user ${JSON.stringify(subject)}`;
    },
  });
  await registerLibraryApi(app, deps.library ?? emptyAppLibrary);
  await registerModelApi(app, deps.model ?? emptyAppModel);
  await registerPlateMeshApi(app, deps.plateMeshes ?? emptyPlateMeshes);
  await registerV1(app, api);
  await registerSettingsApi(app, deps.appApi?.settings);
  await registerTokensApi(app, deps.appApi?.tokens);
  await registerOrganiseApi(app, deps.appApi?.organise);
  await registerUsersApi(app, deps.appApi?.users);
  await registerActivityApi(app, deps.activity);
  await registerLocalesApi(app, locales);
  await registerTus(app, {
    prefix: UPLOAD_PREFIXES.api,
    authHook: apiUploadHook(api),
    uploads: deps.uploads,
    // Each API token may hold only so many unfinished uploads (Uploads.reserve).
    principalOf: (request) => {
      const id = tokenOf(request)?.id;
      return id === undefined ? undefined : `token:${id}`;
    },
    // The token's row id and the user who made it, never the token itself.
    holderOf: (request) => {
      const token = tokenOf(request);
      if (token === undefined) return undefined;
      const maker = token.createdBySubject;
      return maker === null
        ? `token ${token.id} (its maker was not recorded)`
        : `token ${token.id} made by user ${JSON.stringify(maker)}`;
    },
  });
  // /healthz reads web, which is set here before the app can answer.
  const web = await registerWeb(app, webDeps, locales);

  if (deps.delivery !== undefined) {
    await registerDownloads(app, deps.delivery);
    await registerLinks(app, { ...deps.delivery, absoluteUrl: auth.absoluteUrl });
  }

  return app;
}
