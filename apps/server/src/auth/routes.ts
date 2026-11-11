// GET /auth/login, GET /auth/callback and POST /auth/logout (build plan
// Task 15; AC-080, AC-081, AC-091). They are public routes (the Route
// classes table): no session is needed to reach them.
//
// - GET /auth/login asks the issuer for a new login (oidc.ts) and sends the
//   browser there with 302. The PKCE verifier, state and nonce go in the
//   __Host-ph_login cookie: signed (HMAC-SHA256, @fastify/cookie), HttpOnly,
//   SameSite=Lax so it comes back on Pocket ID's top-level redirect, 10
//   minutes long, with its expiry inside the signed value as well, since a
//   browser's Max-Age is only advice. When the issuer cannot be reached the
//   answer is 503 "Login is unavailable right now".
// - GET /auth/callback spends the login cookie whatever happens, exchanges
//   the code against the callback URL rebuilt on PUBLIC_ORIGIN with only the
//   request's query (so redirect_uri never comes from the Host header), and
//   on success starts a session, sets __Host-ph_session and sends the
//   browser to PUBLIC_ORIGIN/. A missing, forged or expired login cookie, or
//   a response that does not check out, is 400; a user not let in is 403
//   with the reason; the issuer unreachable is 503.
// - POST /auth/logout ends the session, if any, clears its cookie and
//   answers 204. Signing out of Pocket ID itself is not part of it.
//
// Every answer is Cache-Control: no-store, and the pages are plain HTML with
// a link to try again. Nothing here logs a code, a token or a cookie.
import { hkdfSync } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { type LoginChecks, LoginError, type OidcClient } from "./oidc.js";
import {
  SESSION_ABSOLUTE_MS,
  SESSION_COOKIE,
  SESSION_COOKIE_OPTIONS,
  type Sessions,
} from "./sessions.js";

/** The cookie that carries a login's PKCE verifier, state and nonce. */
export const LOGIN_COOKIE = "__Host-ph_login";

/** How long a login may take, from /auth/login to /auth/callback. */
export const LOGIN_COOKIE_MS = 10 * 60 * 1000;

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
function readLoginCookie(request: FastifyRequest, now: Date): LoginChecks | undefined {
  const raw = request.cookies[LOGIN_COOKIE];
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
  return { codeVerifier: state.v, state: state.s, nonce: state.n };
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
    reply.setCookie(LOGIN_COOKIE, Buffer.from(JSON.stringify(state)).toString("base64url"), {
      ...LOGIN_COOKIE_OPTIONS,
      maxAge: LOGIN_COOKIE_MS / 1000,
      signed: true,
    });
    reply.header("cache-control", "no-store");
    return reply.redirect(begun.url.href, 302);
  });

  app.get("/auth/callback", async (request, reply) => {
    // The login cookie is spent whatever happens next.
    reply.clearCookie(LOGIN_COOKIE, LOGIN_COOKIE_OPTIONS);
    const checks = readLoginCookie(request, now());
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
    reply.clearCookie(SESSION_COOKIE, SESSION_COOKIE_OPTIONS);
    reply.header("cache-control", "no-store");
    try {
      await deps.sessions.end(request.cookies[SESSION_COOKIE]);
    } catch (error) {
      request.log.warn({ err: error }, "auth: could not end the session");
      return reply.code(503).send({ error: "unavailable" });
    }
    return reply.code(204).send();
  });
}
