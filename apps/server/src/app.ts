// The Fastify app (build plan Tasks 30 and 15). buildApp(deps) returns it
// with every route registered and nothing listening; start() in main.ts
// listens.
//
// - The route-class gate (auth/gate.ts) is installed first, so it covers
//   every route and every 404: session routes need a live session (a page
//   without one is sent to /auth/login, anything else gets 401), state-
//   changing /app/api requests need Origin to be PUBLIC_ORIGIN, and public,
//   bearer and link routes pass to their own checks.
// - GET /auth/login, GET /auth/callback and POST /auth/logout (auth/routes.ts)
//   log Jon in with Pocket ID and out again.
// - GET /healthz answers 200 only when the database answers a query within
//   HEALTH_TIMEOUT_MS and pg-boss is started, else 503. The body is a fixed
//   word either way, never an error, a host or a port: the app image's
//   HEALTHCHECK (Task 24) reads only the status.
// - The tus upload handler (Task 9) is mounted at /app/uploads behind
//   requireSession and at /api/v1/uploads behind refuseUntilAuth, which
//   answers every request 401 until Task 16 replaces it with the bearer
//   check. Either hook runs before tus sees the request, so a refused
//   request stores nothing.
// - The request timeout lets a whole 512 MiB upload through as one PATCH on
//   a slow link (SLOW_LINK_BYTES_PER_SECOND), as curl sends it.
// - Because that timeout is so long, an answer given before the request's
//   body is read (a refusal, a 404, /healthz with a trickled body) has the
//   body released by the gate's onSend hook (releaseUnreadBody): the answer
//   carries Connection: close and the connection closes within DRAIN_MS,
//   instead of Node reading the body for up to REQUEST_TIMEOUT_MS. The root
//   app parses no body at all, so nothing waits for one first.
import fastifyCookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import { installGate } from "./auth/gate.js";
import type { OidcClient } from "./auth/oidc.js";
import { registerAuthRoutes } from "./auth/routes.js";
import type { Sessions } from "./auth/sessions.js";
import { type AuthHook, MAX_UPLOAD_BYTES, registerTus, type Uploads } from "./uploads/tus.js";

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
  /** Fastify's request log; off when left out. */
  logger?: boolean;
}

/**
 * The auth hook /api/v1/uploads gets until Task 16: every request is refused
 * with 401, whatever credentials it carries. The gate's onSend hook releases
 * the body it leaves unread.
 */
export const refuseUntilAuth: AuthHook = async (_request, reply) => {
  return reply.code(401).send({ error: "unauthorized" });
};

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

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { auth } = deps;
  const app = Fastify({
    logger: deps.logger ?? false,
    requestTimeout: REQUEST_TIMEOUT_MS,
  });

  // Cookies are parsed before the gate runs; the login cookie is signed.
  await app.register(fastifyCookie, { secret: auth.cookieSecret });
  const { requireSession } = installGate(app, {
    sessions: auth.sessions,
    publicOrigin: auth.publicOrigin,
    absoluteUrl: auth.absoluteUrl,
  });

  app.get("/healthz", async (_request, reply) => {
    const up =
      deps.health.queuesRunning() && (await answers(deps.health.database, HEALTH_TIMEOUT_MS));
    reply.header("cache-control", "no-store");
    return reply.code(up ? 200 : 503).send({ status: up ? "ok" : "unavailable" });
  });

  // Fastify's own 404 answer; the gate's onSend hook releases any body.
  app.setNotFoundHandler(async (request, reply) => {
    return reply.code(404).send({
      message: `Route ${request.method}:${request.url} not found`,
      error: "Not Found",
      statusCode: 404,
    });
  });

  await registerAuthRoutes(app, {
    oidc: auth.oidc,
    sessions: auth.sessions,
    absoluteUrl: auth.absoluteUrl,
    group: auth.group,
    ...(auth.now === undefined ? {} : { now: auth.now }),
  });

  await registerTus(app, {
    prefix: UPLOAD_PREFIXES.app,
    authHook: requireSession,
    uploads: deps.uploads,
  });
  await registerTus(app, {
    prefix: UPLOAD_PREFIXES.api,
    authHook: refuseUntilAuth,
    uploads: deps.uploads,
  });

  return app;
}
