// The route-class gate (build plan Task 15; the Route classes contract).
//
// patternClass(pattern) and routeClass(path) are the contract's table:
//
//   /api/v1/                          bearer: a token, cookies ignored (Task 16)
//   /s/                               link: the link token (Task 17)
//   /auth/, /healthz, /assets/        public: nothing
//   the icon files (ROOT_FILES)       public: nothing
//   everything else                   session
//
// The icon files are the favicons, app icons and web manifest at their exact
// root paths (web/shell.ts), public since Jon's decision A-1 (2026-11-19) so
// a signed-out browser can load them: on the auth pages, while the login
// redirect returns, and for the manifest, which browsers fetch without
// cookies. Only those exact paths: /favicon.ico/x or /icon-1024.png is
// session like anything else unlisted.
//
// Anything unlisted is session. patternClass classes a matched route's
// registered pattern by its prefix alone, so a regex-constrained param
// (written with backslashes) keeps its route's class. routeClass classes the
// raw path of a request that matched no route: any path under /api/v1/ is
// bearer, since an unmatched one serves only the 404 (issue #140); any path
// under /s/, or one that normalises to /s/ (isLinkPath: a doubled slash, a
// percent-escaped letter, a backslash, a dot segment or an absolute-form
// target), is link, since an unmatched one is answered only as a refused
// link (issue #169); and any other path that is not a plain route path (a
// dot segment, a percent escape, a doubled slash or a backslash) is
// session, whatever it starts with.
//
// installGate puts three things on the root app, so they cover every route
// registered after it, a 404 included:
//
// 1. An onRequest hook that classes each request by the route it matched
//    (patternClass of request.routeOptions.url, the registered pattern, so
//    the gate and the router never read a path differently), or by its raw
//    path (routeClass) when it matched none. Session requests get, in order:
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
//    route is open: every /api/v1 route, the tus uploads at /api/v1/uploads
//    included (app.ts apiUploadHook), and the 404 for an unknown /api/v1
//    path need a valid bearer token (Task 16).
// 2. No body parser at the root: every content type is accepted unread, so
//    nothing reads a body before the gate or a 404 answers. A scope that
//    needs JSON (Tasks 16 and 19) adds its own parser; tus streams its own.
// 3. An onSend hook that releases any body still unread when the answer goes
//    out (releaseUnreadBody: Connection: close, the rest read off and
//    dropped for at most DRAIN_MS, then the connection closes). That is the
//    one place every refusal, 404 and early answer gets it: requireSession,
//    the Origin check, the API's bearer 401, /healthz with a trickled body
//    (issues #107 and #108). An
//    answer that already says Connection: close was released by tus or
//    is closed by Node at once, so it is left alone.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Session } from "../db/types.js";
import { type AuthHook, releaseUnreadBody } from "../uploads/tus.js";
import { ROOT_FILES } from "../web/shell.js";
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

/**
 * The class of a matched route's registered pattern, by its prefix alone (the
 * Route classes table); anything unlisted is session. A pattern is code, not
 * a request, and Fastify writes a regex-constrained param with backslashes
 * (/api/v1/models/:id(\\d+)), so the plain-path test is not applied to it.
 */
export function patternClass(pattern: string): RouteClass {
  if (pattern.startsWith("/api/v1/")) return "bearer";
  if (pattern.startsWith("/s/")) return "link";
  if (
    pattern.startsWith("/auth/") ||
    pattern === "/healthz" ||
    pattern.startsWith("/assets/") ||
    Object.hasOwn(ROOT_FILES, pattern)
  ) {
    return "public";
  }
  return "session";
}

/** How many rounds of percent-decoding normalisedPath applies, so %2573 reads as s. */
const DECODE_ROUNDS = 3;

/**
 * The path a raw request target could be read as, for classing only, never
 * for routing: an absolute-form target's scheme and authority dropped, each
 * valid percent escape decoded (repeated, so a double-encoded letter reads
 * as itself; an escape that is not valid is left as it is), backslashes
 * made slashes, runs of slashes made one, and dot segments resolved.
 */
function normalisedPath(target: string): string {
  let p = pathPart(target).replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*/, "");
  for (let i = 0; i < DECODE_ROUNDS && p.includes("%"); i++) {
    p = p.replace(/%([0-9A-Fa-f]{2})/g, (_m, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
  }
  p = p.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  const out: string[] = [];
  for (const segment of p.split("/")) {
    if (segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  const joined = out.join("/");
  return joined.startsWith("/") ? joined : `/${joined}`;
}

/**
 * True for a raw request target under /s/, as sent or as it normalises
 * (normalisedPath): a doubled slash, a percent-escaped letter, a backslash,
 * a dot segment or an absolute-form target that reads as a /s/ path. Such a
 * path is link-class when it matched no route, so it is answered as a
 * refused link and its segments are kept out of the request log (issue
 * #169). It can only ever be refused: the link route itself is matched by
 * the router and classed by its pattern.
 */
export function isLinkPath(target: string): boolean {
  return pathPart(target).startsWith("/s/") || normalisedPath(target).startsWith("/s/");
}

/**
 * The class of a raw request path that matched no route (the Route classes
 * table): any /api/v1/ path is bearer; any path under /s/, or that
 * normalises to it, is link; anything else unlisted, or not a plain route
 * path, is session.
 */
export function routeClass(path: string): RouteClass {
  const p = pathPart(path);
  // An unmatched /api/v1/ path serves nothing but the 404, so it is bearer
  // even when it is not a plain path: as session, a typo such as
  // /api/v1/model/Big%20thing was sent to the login or refused for Origin,
  // and a valid token never got its 404 (issue #140).
  if (p.startsWith("/api/v1/")) return "bearer";
  // An unmatched link path is answered only as a refused link (app.ts), so
  // it is link even when it is not a plain path: as session, a link name
  // with a space got 401 or a redirect to the login instead of the empty
  // 403, and a signed-in request got a 404 that repeated the path, the
  // token in it included (issue #169).
  if (isLinkPath(path)) return "link";
  if (!isPlainPath(p)) return "session";
  return patternClass(p);
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
    const pattern = request.routeOptions.url;
    const cls = pattern === undefined ? routeClass(request.url) : patternClass(pattern);
    if (cls !== "session") return;
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
