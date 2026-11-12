// The Fastify app (build plan Tasks 30 and 15). buildApp(deps) returns it
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
//   log Jon in with Pocket ID and out again.
// - GET /healthz answers 200 only when the database answers a query within
//   HEALTH_TIMEOUT_MS and pg-boss is started, else 503. The body is a fixed
//   word either way, never an error, a host or a port: the app image's
//   HEALTHCHECK (Task 24) reads only the status.
// - The tus upload handler (Task 9) is mounted at /app/uploads behind
//   requireSession and at /api/v1/uploads behind apiUploadHook: the bearer
//   check (api/tokens.ts), then, for a creation into an existing model, that
//   the model is live. Either hook runs before tus sees the request, so a
//   refused request stores nothing.
// - The Public API v1 (api/v1.ts, Task 16) is mounted at /api/v1, every route
//   behind the bearer check, and its OpenAPI document (api/openapi.ts) is
//   generated from those routes with servers[0].url = absoluteUrl('/api/v1').
//   A request to an unknown path under /api/v1 gets the bearer check before
//   its 404, so without a token it is 401 like every other API request. No
//   CORS plugin is registered.
// - The web app (web/shell.ts, Task 18): the shell pages (session-class)
//   answer with the built index.html, data-theme and the color-scheme meta
//   written in from the ph_theme cookie, and the hashed build output is
//   served under /assets/ (public-class).
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
//   reach it, and a fixed list of its headers (LOGGED_HEADERS), with
//   Upload-Metadata cut to its key names (not the file name or model id)
//   and pino redacting Authorization, Cookie and Proxy-Authorization
//   (LOG_REDACT_PATHS), so no API token or session cookie reaches the log.

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
import { createBearerHook } from "./api/tokens.js";
import { API_PREFIX, type ApiDeps, apiUploadHook, refusingApi, registerV1 } from "./api/v1.js";
import { installGate, patternClass, routeClass } from "./auth/gate.js";
import type { OidcClient } from "./auth/oidc.js";
import { registerAuthRoutes } from "./auth/routes.js";
import type { Sessions } from "./auth/sessions.js";
import { MAX_UPLOAD_BYTES, registerTus, releaseUnreadBody, type Uploads } from "./uploads/tus.js";
import { defaultWebDir, registerWeb, type WebDeps } from "./web/shell.js";

/** Where the tus upload handler is mounted (Public API v1 contract, Task 9). */
export const UPLOAD_PREFIXES = Object.freeze({
  app: "/app/uploads",
  api: "/api/v1/uploads",
});

/** How long /healthz waits for the database before it answers 503. */
export const HEALTH_TIMEOUT_MS = 3_000;

/** The slow link a whole upload must fit through in one request: 1 Mbit/s. */
export const SLOW_LINK_BYTES_PER_SECOND = 125_000;

/**
 * The HTTP request timeout: a 512 MiB single PATCH at
 * SLOW_LINK_BYTES_PER_SECOND, about 72 minutes. Fastify's own default is no
 * limit at all; this is the upper bound, sized for that one upload.
 */
export const REQUEST_TIMEOUT_MS = Math.ceil(MAX_UPLOAD_BYTES / SLOW_LINK_BYTES_PER_SECOND) * 1000;

export interface AppHealth {
  /** Resolves when the database answers a query. */
  database(): Promise<unknown>;
  /** True while pg-boss is started and the queues are worked. */
  queuesRunning(): boolean;
}

/** What login, sessions and the route-class gate need (Task 15). */
export interface AppAuth {
  oidc: OidcClient;
  sessions: Sessions;
  /** PUBLIC_ORIGIN, scheme and host only. */
  publicOrigin: string;
  /** Config.absoluteUrl: an absolute URL on PUBLIC_ORIGIN, never from a request. */
  absoluteUrl(path: string): string;
  /** OIDC_GROUP, named on the refusal page. */
  group: string;
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
   * The Public API v1's tokens and library (Task 16). The server always
   * passes its own; left out, no token is live (refusingApi), so every API
   * request is 401.
   */
  api?: ApiDeps;
  /**
   * Fastify's request log: off when left out or false, to stdout when true,
   * or to this stream (the tests read it). Either way each request is logged
   * by requestLogValue, so its query is never in the log.
   */
  logger?: boolean | { write(line: string): unknown };
  /** The built web app (Task 18); apps/web/dist beside the server when left out. */
  web?: WebDeps;
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

/**
 * The request log's view of a request: Fastify's default fields, with the
 * url cut at the "?". A query can carry a secret: GET /auth/callback has the
 * OAuth code and state in it.
 */
export function requestLogValue(request: FastifyRequest): RequestLogValue {
  const url = request.url;
  const at = url.indexOf("?");
  const value: RequestLogValue = {
    method: request.method,
    url: at === -1 ? url : url.slice(0, at),
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
 * REQUEST_TIMEOUT_MS. The body is Fastify's own.
 */
function frameworkError(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  const status = error.statusCode ?? 500;
  releaseUnreadBody(request, reply);
  return reply.code(status).send({
    error: STATUS_CODES[status] ?? "Error",
    code: error.code,
    message: error.message,
    statusCode: status,
  });
}

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

  app.get("/healthz", async (_request, reply) => {
    const up =
      deps.health.queuesRunning() && (await answers(deps.health.database, HEALTH_TIMEOUT_MS));
    reply.header("cache-control", "no-store");
    return reply.code(up ? 200 : 503).send({ status: up ? "ok" : "unavailable" });
  });

  // Fastify's own 404 answer; the gate's onSend hook releases any body. An
  // unknown path under /api/v1 is bearer-class: no token, no 404.
  const apiBearer = createBearerHook(api.tokens);
  app.setNotFoundHandler(async (request, reply) => {
    if (routeClass(request.url) === "bearer") {
      await apiBearer(request, reply);
      if (reply.sent) return reply;
    }
    return reply.code(404).send({
      message: `Route ${request.method}:${request.url} not found`,
      error: "Not Found",
      statusCode: 404,
    });
  });

  await registerAuthRoutes(app, {
    oidc: auth.oidc,
    sessions: auth.sessions,
    publicOrigin: auth.publicOrigin,
    absoluteUrl: auth.absoluteUrl,
    group: auth.group,
    ...(auth.now === undefined ? {} : { now: auth.now }),
  });

  await registerTus(app, {
    prefix: UPLOAD_PREFIXES.app,
    authHook: requireSession,
    uploads: deps.uploads,
  });
  await registerV1(app, api);
  await registerTus(app, {
    prefix: UPLOAD_PREFIXES.api,
    authHook: apiUploadHook(api),
    uploads: deps.uploads,
  });
  await registerWeb(app, deps.web ?? { dir: defaultWebDir() });

  return app;
}
