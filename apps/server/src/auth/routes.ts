// GET /auth/login, GET /auth/callback and POST /auth/logout (build plan
// Task 15; AC-080, AC-081, AC-091). They are public routes (the Route
// classes table): no session is needed to reach them.
//
// - GET /auth/login asks the issuer for a new login (oidc.ts) and sends the
//   browser there with 302. The PKCE verifier, state and nonce go in a
//   cookie named for the login's state, __Host-ph_login_<state>, so two
//   logins that overlap (two tabs restored at once) each keep their own:
//   signed (HMAC-SHA256, @fastify/cookie), HttpOnly, SameSite=Lax so it
//   comes back on Pocket ID's top-level redirect, 10 minutes long, with its
//   expiry inside the signed value as well, since a browser's Max-Age is
//   only advice. So that logins abandoned at Pocket ID cannot pile up past
//   the header size limit, it first clears every login cookie the request
//   carries that is forged or expired, and of the rest all but the newest
//   MAX_PENDING_LOGINS - 1. When the issuer cannot be reached the answer is
//   503 "Login is unavailable right now".
// - GET /auth/callback finds the login cookie by the state in its query and
//   spends that one cookie whatever happens, leaving any other login's
//   alone. A state that is not a plain token is 400 and names no cookie. It
//   then exchanges the code against the callback URL rebuilt on
//   PUBLIC_ORIGIN with only the request's query (so redirect_uri never comes
//   from the Host header), and on success starts a session, sets
//   __Host-ph_session and sends the browser to PUBLIC_ORIGIN/. A missing,
//   forged or expired login cookie, or a response that does not check out,
//   is 400; a user not let in is 403 with the reason; the issuer unreachable
//   is 503.
// - POST /auth/logout needs Origin to equal PUBLIC_ORIGIN, as a state-
//   changing /app/api request does, or it is 403 and the session and its
//   cookie are left alone, so another site cannot sign Jon out. Otherwise it
//   ends the session, if any, clears its cookie and answers 204. Signing out
//   of Pocket ID itself is not part of it.
//
// Every answer is Cache-Control: no-store, and the pages are plain HTML with
// a link to try again. Nothing here logs a code, a token or a cookie, and
// the request log records the path without the query (app.ts), so the
// callback's code and state stay out of it too.
import { hkdfSync } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { type LoginChecks, LoginError, type OidcClient } from "./oidc.js";
import {
  SESSION_ABSOLUTE_MS,
  SESSION_COOKIE,
  SESSION_COOKIE_OPTIONS,
  type Sessions,
} from "./sessions.js";

/** The login cookie's name up to the state: __Host-ph_login_<state>. */
export const LOGIN_COOKIE_PREFIX = "__Host-ph_login_";

/**
 * A state that can name a login cookie: base64url, as openid-client makes it
 * (43 characters), with room either side. Anything else names no cookie.
 */
const STATE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/** The cookie that carries the PKCE verifier, state and nonce of the login with this state. */
export function loginCookieName(state: string): string {
  return `${LOGIN_COOKIE_PREFIX}${state}`;
}

/** How long a login may take, from /auth/login to /auth/callback. */
export const LOGIN_COOKIE_MS = 10 * 60 * 1000;

/**
 * The most login cookies a browser keeps at once. Every signed-out page load
 * starts a login (gate.ts), so logins abandoned at Pocket ID would otherwise
 * pile up, about 330 bytes each on the Cookie header, until it passes Node's
 * 16 KiB limit and every request is 431. GET /auth/login keeps the newest
 * few and clears the rest.
 */
export const MAX_PENDING_LOGINS = 5;

/** What /auth/login shows, with status 503, when the issuer cannot be reached. */
export const LOGIN_UNAVAILABLE = "Login is unavailable right now";

/** The login cookie's attributes; the clearing one carries them too. */
const LOGIN_COOKIE_OPTIONS = SESSION_COOKIE_OPTIONS;

/**
 * The key the login cookie is signed with. It is derived from LINK_SECRET
 * with HKDF-SHA256 under its own label, so it is independent of the slicer
 * link key and needs no configuration value of its own (the Configuration
 * contract has none), and it survives a restart in the middle of a login.
 */
export function loginCookieKey(linkSecret: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(linkSecret, "utf8"),
      Buffer.alloc(0),
      "platehouse login cookie v1",
      32,
    ),
  );
}

export interface AuthRouteDeps {
  oidc: OidcClient;
  sessions: Sessions;
  /** PUBLIC_ORIGIN, scheme and host only: the Origin POST /auth/logout must carry. */
  publicOrigin: string;
  absoluteUrl(path: string): string;
  group: string;
  now?: () => Date;
}

/** What the login cookie holds, before signing. */
interface LoginState {
  v: string;
  s: string;
  n: string;
  /** When the login expires, in ms since the epoch. */
  e: number;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** A plain page: a heading, a sentence and a link to try again. */
function page(title: string, message: string): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)} - Platehouse</title></head>`,
    `<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`,
    '<p><a href="/auth/login">Try again</a></p></main></body>',
    "</html>",
    "",
  ].join("\n");
}

function sendPage(reply: FastifyReply, status: number, title: string, message: string) {
  return reply
    .code(status)
    .header("cache-control", "no-store")
    .type("text/html; charset=utf-8")
    .send(page(title, message));
}

function unavailable(reply: FastifyReply) {
  return sendPage(
    reply,
    503,
    LOGIN_UNAVAILABLE,
    "Platehouse cannot reach Pocket ID. Try again in a few minutes.",
  );
}

/** The login cookie's checks, or undefined when it is missing, forged, malformed or expired. */
function readLoginCookie(
  request: FastifyRequest,
  name: string,
  now: Date,
): LoginChecks | undefined {
  const state = readLoginState(request, name, now);
  return state === undefined
    ? undefined
    : { codeVerifier: state.v, state: state.s, nonce: state.n };
}

/** The login cookie's signed value, or undefined when it is missing, forged, malformed or expired. */
function readLoginState(request: FastifyRequest, name: string, now: Date): LoginState | undefined {
  const raw = request.cookies[name];
  if (raw === undefined || raw === "") return undefined;
  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || unsigned.value === null) return undefined;
  let state: Partial<LoginState>;
  try {
    state = JSON.parse(Buffer.from(unsigned.value, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (
    state === null ||
    typeof state !== "object" ||
    typeof state.v !== "string" ||
    typeof state.s !== "string" ||
    typeof state.n !== "string" ||
    typeof state.e !== "number" ||
    state.e <= now.getTime()
  ) {
    return undefined;
  }
  return state as LoginState;
}

/**
 * Clears the login cookies this request carries that a new login should not
 * keep beside its own: every one that is forged, malformed or expired, and
 * of the rest all but the newest MAX_PENDING_LOGINS - 1, so with the new
 * login's cookie there are never more than MAX_PENDING_LOGINS. Only names
 * this app could have set (the prefix and a plain state) are touched.
 */
function clearOldLogins(request: FastifyRequest, reply: FastifyReply, now: Date): void {
  const live: { name: string; e: number }[] = [];
  for (const name of Object.keys(request.cookies)) {
    if (!name.startsWith(LOGIN_COOKIE_PREFIX)) continue;
    if (!STATE_PATTERN.test(name.slice(LOGIN_COOKIE_PREFIX.length))) continue;
    const state = readLoginState(request, name, now);
    if (state === undefined) reply.clearCookie(name, LOGIN_COOKIE_OPTIONS);
    else live.push({ name, e: state.e });
  }
  live.sort((a, b) => b.e - a.e);
  for (const { name } of live.slice(MAX_PENDING_LOGINS - 1)) {
    reply.clearCookie(name, LOGIN_COOKIE_OPTIONS);
  }
}

/** The request's query string, "?" included, or "" when it has none. */
function queryOf(url: string): string {
  const at = url.indexOf("?");
  return at === -1 ? "" : url.slice(at);
}

export async function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): Promise<void> {
  const now = deps.now ?? (() => new Date());

  app.get("/auth/login", async (request, reply) => {
    let begun: Awaited<ReturnType<OidcClient["begin"]>>;
    try {
      begun = await deps.oidc.begin();
    } catch (error) {
      request.log.warn({ err: error }, "auth: login is unavailable: the issuer cannot be reached");
      return unavailable(reply);
    }
    const state: LoginState = {
      v: begun.checks.codeVerifier,
      s: begun.checks.state,
      n: begun.checks.nonce,
      e: now().getTime() + LOGIN_COOKIE_MS,
    };
    clearOldLogins(request, reply, now());
    reply.setCookie(
      loginCookieName(state.s),
      Buffer.from(JSON.stringify(state)).toString("base64url"),
      {
        ...LOGIN_COOKIE_OPTIONS,
        maxAge: LOGIN_COOKIE_MS / 1000,
        signed: true,
      },
    );
    reply.header("cache-control", "no-store");
    return reply.redirect(begun.url.href, 302);
  });

  app.get("/auth/callback", async (request, reply) => {
    const state = new URLSearchParams(queryOf(request.url)).get("state") ?? "";
    let checks: LoginChecks | undefined;
    if (STATE_PATTERN.test(state)) {
      // This login's cookie is spent whatever happens next; another login's
      // cookie is left for its own callback.
      const name = loginCookieName(state);
      reply.clearCookie(name, LOGIN_COOKIE_OPTIONS);
      checks = readLoginCookie(request, name, now());
    }
    if (checks === undefined) {
      return sendPage(
        reply,
        400,
        "Login did not finish",
        "This login took longer than 10 minutes, or was started in another browser. Try again.",
      );
    }
    const callbackUrl = new URL(`${deps.absoluteUrl("/auth/callback")}${queryOf(request.url)}`);
    let subject: string;
    try {
      ({ subject } = await deps.oidc.finish(callbackUrl, checks));
    } catch (error) {
      const failure = error instanceof LoginError ? error.failure : "failed";
      request.log.warn({ failure }, "auth: login refused");
      switch (failure) {
        case "unavailable":
          return unavailable(reply);
        case "not_in_group":
          return sendPage(
            reply,
            403,
            "Login refused",
            `Your Pocket ID account is not in the ${deps.group} group. Ask for it to be added, then try again.`,
          );
        case "email_not_verified":
          return sendPage(
            reply,
            403,
            "Login refused",
            "Your Pocket ID account's email address is not verified. Verify it in Pocket ID, then try again.",
          );
        default:
          return sendPage(
            reply,
            400,
            "Login did not finish",
            "Pocket ID's answer could not be checked. Try again.",
          );
      }
    }
    let started: Awaited<ReturnType<Sessions["start"]>>;
    try {
      started = await deps.sessions.start(subject);
      // A session the browser already had is replaced, not kept beside it.
      await deps.sessions.end(request.cookies[SESSION_COOKIE]).catch(() => undefined);
    } catch (error) {
      request.log.warn({ err: error }, "auth: could not save the session");
      return sendPage(
        reply,
        503,
        LOGIN_UNAVAILABLE,
        "Platehouse cannot save your login right now. Try again in a few minutes.",
      );
    }
    reply.setCookie(SESSION_COOKIE, started.id, {
      ...SESSION_COOKIE_OPTIONS,
      maxAge: SESSION_ABSOLUTE_MS / 1000,
    });
    reply.header("cache-control", "no-store");
    return reply.redirect(deps.absoluteUrl("/"), 302);
  });

  app.post("/auth/logout", async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (request.headers.origin !== deps.publicOrigin) {
      return reply.code(403).send({ error: "forbidden" });
    }
    reply.clearCookie(SESSION_COOKIE, SESSION_COOKIE_OPTIONS);
    try {
      await deps.sessions.end(request.cookies[SESSION_COOKIE]);
    } catch (error) {
      request.log.warn({ err: error }, "auth: could not end the session");
      return reply.code(503).send({ error: "unavailable" });
    }
    return reply.code(204).send();
  });
}
