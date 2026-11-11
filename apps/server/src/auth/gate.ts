// The route-class gate (build plan Task 15; the Route classes contract).
//
// routeClass(path) is the contract's table:
//
//   /api/v1/                          bearer: a token, cookies ignored (Task 16)
//   /s/                               link: the link token (Task 17)
//   /auth/, /healthz, /assets/        public: nothing
//   everything else                   session
//
// Anything unlisted is session, and so is any path that is not a plain
// route path (a dot segment, a percent escape, a doubled slash or a
// backslash), whatever it starts with.
//
// installGate puts three things on the root app, so they cover every route
// registered after it, a 404 included:
//
// 1. An onRequest hook that classes each request by the route it matched
//    (request.routeOptions.url, the registered pattern, so the gate and the
//    router never read a path differently), or by its raw path when it
//    matched none. Session requests get, in order:
//    - the Origin check, which fails closed: every state-changing request
//      (any method but GET, HEAD and OPTIONS) must carry Origin equal to
//      PUBLIC_ORIGIN, or it is 403 before any session is looked up. It is
//      decided by the class of the route the request matched, never by a
//      path prefix, so it covers /app/api, the tus routes at /app/uploads
//      and every session route added later without anyone listing it. A
//      browser sends Origin on every POST, PUT, PATCH and DELETE, same-origin
//      ones included (tus-js-client's uploads among them), so only a request
//      from another site, or a non-browser client, is refused. SameSite=Lax
//      is not relied on here: a sibling subdomain is same-site and would get
//      the cookie. POST /auth/logout is a public route, so routes.ts makes the
//      same check itself;
//    - requireSession: a live session (sessions.ts), or the refusal: a page
//      (a GET or HEAD that accepts HTML) is sent to /auth/login on
//      PUBLIC_ORIGIN with 302, anything else is 401 JSON. A session store
//      that fails answers 503 with no detail.
//    Bearer and link requests pass to their routes' own checks; no such
//    route is open: /api/v1/uploads refuses everything until Task 16.
// 2. No body parser at the root: every content type is accepted unread, so
//    nothing reads a body before the gate or a 404 answers. A scope that
//    needs JSON (Tasks 16 and 19) adds its own parser; tus streams its own.
// 3. An onSend hook that releases any body still unread when the answer goes
//    out (releaseUnreadBody: Connection: close, the rest read off and
//    dropped for at most DRAIN_MS, then the connection closes). That is the
//    one place every refusal, 404 and early answer gets it: requireSession,
//    the Origin check, the API mount's 401 (and the bearer hook that will
//    replace it), /healthz with a trickled body (issues #107 and #108). An
//    answer that already says Connection: close was released by tus or
//    is closed by Node at once, so it is left alone.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Session } from "../db/types.js";
import { type AuthHook, releaseUnreadBody } from "../uploads/tus.js";
import { SESSION_COOKIE, SESSION_COOKIE_OPTIONS, type Sessions } from "./sessions.js";

export type RouteClass = "bearer" | "link" | "public" | "session";

/** The methods that do not change state; every other method needs the Origin check. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** True when a request with this method needs Origin to equal PUBLIC_ORIGIN on a session route. */
function needsSameOrigin(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

/** The path part of a request target or route pattern. */
function pathPart(path: string): string {
  const at = path.search(/[?#]/);
  return at === -1 ? path : path.slice(0, at);
}

/** True for a path a route can be registered at: no dot segment, escape, // or backslash. */
function isPlainPath(path: string): boolean {
  if (!path.startsWith("/") || path.includes("//") || path.includes("\\") || path.includes("%")) {
    return false;
  }
  return !path.split("/").some((segment) => segment === "." || segment === "..");
}

/** The class of a route path (the Route classes table); anything unlisted is session. */
export function routeClass(path: string): RouteClass {
  const p = pathPart(path);
  if (!isPlainPath(p)) return "session";
  if (p.startsWith("/api/v1/")) return "bearer";
  if (p.startsWith("/s/")) return "link";
  if (p.startsWith("/auth/") || p === "/healthz" || p.startsWith("/assets/")) return "public";
  return "session";
}

const sessions = new WeakMap<FastifyRequest, Session>();

/** The session requireSession found for this request, if any. */
export function sessionOf(request: FastifyRequest): Session | undefined {
  return sessions.get(request);
}

export interface GateDeps {
  sessions: Sessions;
  publicOrigin: string;
  absoluteUrl(path: string): string;
}

function acceptsHtml(request: FastifyRequest): boolean {
  const accept = request.headers.accept;
  return typeof accept === "string" && /\btext\/html\b/i.test(accept);
}

/** Installs the gate on the root app and returns requireSession. */
export function installGate(app: FastifyInstance, deps: GateDeps): { requireSession: AuthHook } {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", (_request, _payload, done) => done(null));

  function refuse(request: FastifyRequest, reply: FastifyReply) {
    reply.header("cache-control", "no-store");
    if ((request.method === "GET" || request.method === "HEAD") && acceptsHtml(request)) {
      return reply.redirect(deps.absoluteUrl("/auth/login"), 302);
    }
    return reply.code(401).send({ error: "unauthorized" });
  }

  const requireSession: AuthHook = async (request, reply) => {
    if (sessions.has(request)) return;
    const cookie = request.cookies[SESSION_COOKIE];
    let session: Session | undefined;
    try {
      session = await deps.sessions.find(cookie);
    } catch (error) {
      // The store's error (a database host, a port) goes to the log only.
      request.log.warn({ err: error }, "auth: could not read the session");
      return reply.code(503).header("cache-control", "no-store").send({ error: "unavailable" });
    }
    if (session !== undefined) {
      sessions.set(request, session);
      return;
    }
    if (cookie !== undefined && cookie !== "") {
      reply.clearCookie(SESSION_COOKIE, SESSION_COOKIE_OPTIONS);
    }
    return refuse(request, reply);
  };

  app.addHook("onRequest", async (request, reply) => {
    const path = request.routeOptions.url ?? request.url;
    if (routeClass(path) !== "session") return;
    if (needsSameOrigin(request.method) && request.headers.origin !== deps.publicOrigin) {
      return reply.code(403).header("cache-control", "no-store").send({ error: "forbidden" });
    }
    return requireSession(request, reply);
  });

  app.addHook("onSend", async (request, reply, payload) => {
    if (reply.getHeader("connection") !== "close") releaseUnreadBody(request, reply);
    return payload;
  });

  return { requireSession };
}
