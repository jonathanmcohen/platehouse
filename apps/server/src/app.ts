// The Fastify app (build plan Task 30). buildApp(deps) returns it with every
// route registered and nothing listening; start() in main.ts listens.
//
// - GET /healthz answers 200 only when the database answers a query within
//   HEALTH_TIMEOUT_MS and pg-boss is started, else 503. The body is a fixed
//   word either way, never an error, a host or a port: the app image's
//   HEALTHCHECK (Task 24) reads only the status.
// - The tus upload handler (Task 9) is mounted at /app/uploads and
//   /api/v1/uploads behind refuseUntilAuth, which answers every request 401.
//   Tasks 15 and 16 replace it with the session check and the bearer check;
//   until then no upload route is open and a refused request stores nothing,
//   since the hook runs before tus sees the request.
// - The request timeout lets a whole 512 MiB upload through as one PATCH on
//   a slow link (SLOW_LINK_BYTES_PER_SECOND), as curl sends it.
// - Because that timeout is so long, a request answered before its body is
//   read (the 401 refusal, a 404) has its body released (releaseUnreadBody):
//   the answer carries Connection: close and the connection closes within
//   DRAIN_MS, instead of Node reading the body for up to REQUEST_TIMEOUT_MS.
import Fastify, { type FastifyInstance } from "fastify";
import type { OidcClient } from "./auth/oidc.js";
import type { Sessions } from "./auth/sessions.js";
import {
  type AuthHook,
  MAX_UPLOAD_BYTES,
  registerTus,
  releaseUnreadBody,
  type Uploads,
} from "./uploads/tus.js";

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
 * SLOW_LINK_BYTES_PER_SECOND, about 72 minutes. Node's own default (5
 * minutes) would cut such an upload off part way.
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
 * The auth hook both upload mounts get until Tasks 15 and 16: every request
 * is refused with 401, whatever credentials it carries. The hook runs before
 * any body is read, so the body is released (releaseUnreadBody).
 */
export const refuseUntilAuth: AuthHook = async (request, reply) => {
  releaseUnreadBody(request, reply);
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
  const app = Fastify({
    logger: deps.logger ?? false,
    requestTimeout: REQUEST_TIMEOUT_MS,
  });

  app.get("/healthz", async (_request, reply) => {
    const up =
      deps.health.queuesRunning() && (await answers(deps.health.database, HEALTH_TIMEOUT_MS));
    reply.header("cache-control", "no-store");
    return reply.code(up ? 200 : 503).send({ status: up ? "ok" : "unavailable" });
  });

  // Fastify's own 404 answer, but with any body it left unread released: it
  // reads no body whose content type it has no parser for.
  app.setNotFoundHandler(async (request, reply) => {
    releaseUnreadBody(request, reply);
    return reply.code(404).send({
      message: `Route ${request.method}:${request.url} not found`,
      error: "Not Found",
      statusCode: 404,
    });
  });

  for (const prefix of [UPLOAD_PREFIXES.app, UPLOAD_PREFIXES.api]) {
    await registerTus(app, { prefix, authHook: refuseUntilAuth, uploads: deps.uploads });
  }

  return app;
}
