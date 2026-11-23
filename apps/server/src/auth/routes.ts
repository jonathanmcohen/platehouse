// GET /auth/login, GET /auth/callback and POST /auth/logout: the OIDC login,
// which says when the provider is down and builds every URL from the
// configured public origin. They are public routes (the Route
// classes table): no session is needed to reach them.
//
// - GET /auth/login asks the issuer for a new login (oidc.ts) and sends the
//   browser there with 302. The PKCE verifier, state and nonce go in a
//   cookie named for the login's state, __Host-ph_login_<state>, so two
//   logins that overlap (two tabs restored at once) each keep their own:
//   signed (HMAC-SHA256, @fastify/cookie), HttpOnly, SameSite=Lax so it
//   comes back on the OIDC provider's top-level redirect, 10 minutes long, with its
//   expiry inside the signed value as well, since a browser's Max-Age is
//   only advice. So that logins abandoned at the OIDC provider cannot pile up past
//   the header size limit, it first clears every login cookie the request
//   carries that is forged or expired, and of the rest all but the newest
//   MAX_PENDING_LOGINS - 1. When the issuer cannot be reached the answer is
//   503 "Login is unavailable right now". A next= query naming a plain
//   path (returnPath: segments of letters, digits, - and _) rides in the
//   signed cookie, and the callback sends the browser there instead of the
//   start page; anything else in next= is ignored. Settings uses it to come
//   back after the fresh sign-in a new API token needs (issue #322).
// - GET /auth/callback finds the login cookie by the state in its query and
//   spends that one cookie whatever happens, leaving any other login's
//   alone. A state that is not a plain token is 400 and names no cookie. It
//   then exchanges the code against the callback URL rebuilt on
//   PUBLIC_ORIGIN with only the request's query (so redirect_uri never comes
//   from the Host header), and on success starts a session with the display
//   name the claims give, sets __Host-ph_session and sends the browser to
//   PUBLIC_ORIGIN/ (or the login's next path on PUBLIC_ORIGIN). A missing,
//   forged or expired login cookie, or a response that does not check out,
//   is 400; a user not let in is 403 with the reason (not in the group,
//   email not verified, or a user id over MAX_SUBJECT_LENGTH characters,
//   which the log records by its length, never its value); the issuer
//   unreachable is 503. A 403 refusal also ends the session the browser
//   presented, if any, and clears its cookie, as a sign-in that succeeds
//   replaces it (issue #395); a 400 or a 503 ends nothing.
// - POST /auth/logout needs Origin to equal PUBLIC_ORIGIN, as every state-
//   changing request on a session route does (gate.ts), or it is 403 and the
//   session and its cookie are left alone, so another site cannot sign the user
//   out. It is a public route, so the gate does not check it. Otherwise it
//   ends the session, if any, clears its cookie and answers 204. Signing out
//   of the OIDC provider itself is not part of it.
//
// Every answer is Cache-Control: no-store, and the pages are plain HTML with
// the Platehouse logo above the heading and a link to try again. Nothing here logs a code, a token or a cookie, and
// the request log records the path without the query (app.ts), so the
// callback's code and state stay out of it too.
import { hkdfSync } from "node:crypto";
import {
  createTranslator,
  LANG_COOKIE,
  type MessageValues,
  SOURCE_LOCALE,
  type Translator,
} from "@platehouse/i18n";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createLocales, englishMessages, type Locales } from "../locales/locales.js";
import {
  type LoginChecks,
  LoginError,
  type LoginFailure,
  MAX_SUBJECT_LENGTH,
  type OidcClient,
} from "./oidc.js";
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
 * starts a login (gate.ts), so logins abandoned at the OIDC provider would otherwise
 * pile up, about 330 bytes each on the Cookie header, until it passes Node's
 * 16 KiB limit and every request is 431. GET /auth/login keeps the newest
 * few and clears the rest.
 */
export const MAX_PENDING_LOGINS = 5;

/** What /auth/login shows, with status 503, when the issuer cannot be reached. */
export const LOGIN_UNAVAILABLE: string = englishMessages()["login.unavailable.title"] ?? "";

/**
 * The refusals that say the person signing in is no longer let in (issue
 * #395). On these the callback also ends the session the browser presented
 * and clears its cookie. "unavailable" (the issuer could not be reached) and
 * "failed" (the callback did not check out) say nothing about the person, so
 * they end nothing.
 */
const NOT_LET_IN: ReadonlySet<LoginFailure> = new Set<LoginFailure>([
  "subject_too_long",
  "not_in_group",
  "email_not_verified",
]);

/** The login cookie's attributes; the clearing one carries them too. */
const LOGIN_COOKIE_OPTIONS = SESSION_COOKIE_OPTIONS;

/**
 * The key the login cookie is signed with. It is derived from LINK_SECRET
 * with HKDF-SHA256 under its own label, so it is independent of the slicer
 * link key and needs no configuration value of its own (apps/server/src/config.ts
 * has none), and it survives a restart in the middle of a login.
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
  /** The languages, for the pages' words; the built-in languages when left out. */
  locales?: Locales;
}

/** What the login cookie holds, before signing. */
interface LoginState {
  v: string;
  s: string;
  n: string;
  /** When the login expires, in ms since the epoch. */
  e: number;
  /** Where the callback sends the browser (a returnPath), when not the start page. */
  r?: string;
}

/**
 * A path GET /auth/login?next= may send the browser back to after the login:
 * slash-separated segments of letters, digits, - and _ only, so no other
 * host, no dot segment, escape, backslash, doubled slash or query can get
 * in. The callback builds the URL on PUBLIC_ORIGIN (absoluteUrl) all the
 * same. Settings uses it to come back after the fresh sign-in a new API
 * token needs (issue #322).
 */
const RETURN_PATH = /^(?:\/[A-Za-z0-9_-]+)+$/;

/** The longest next= path the login keeps. */
const MAX_RETURN_PATH = 200;

/** next, when it is a path the login may return to; undefined otherwise. */
export function returnPath(next: string | null | undefined): string | undefined {
  if (typeof next !== "string" || next.length > MAX_RETURN_PATH) return undefined;
  return RETURN_PATH.test(next) ? next : undefined;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * The logo above each page's heading: the favicon file, public-class
 * (gate.ts), so it loads without a session, and named Platehouse, since no
 * other text on the page names the app.
 */
const LOGO = '<img src="/favicon.svg" alt="Platehouse" width="48" height="48">';

/** A message key and its values: the words a login page shows. */
type Words = [key: string, values?: MessageValues];

/**
 * A plain page: the logo, a heading, a sentence and a link to try again, in the
 * request's language (the ph_lang cookie, else Accept-Language, else
 * English; the maintainer, 2026-11-19), with the html lang to match. Every word is
 * escaped: a translation is text, never markup.
 */
function page(tr: Translator, title: Words, message: Words): string {
  const heading = tr.t(...title);
  return [
    "<!doctype html>",
    `<html lang="${escapeHtml(tr.locale)}">`,
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(tr.t("login.pageTitle", { title: heading }))}</title></head>`,
    `<body><main>${LOGO}<h1>${escapeHtml(heading)}</h1><p>${escapeHtml(tr.t(...message))}</p>`,
    `<p><a href="/auth/login">${escapeHtml(tr.t("login.tryAgain"))}</a></p></main></body>`,
    "</html>",
    "",
  ].join("\n");
}

function sendPage(
  reply: FastifyReply,
  tr: Translator,
  status: number,
  title: Words,
  message: Words,
) {
  return reply
    .code(status)
    .header("cache-control", "no-store")
    .type("text/html; charset=utf-8")
    .send(page(tr, title, message));
}

function unavailable(reply: FastifyReply, tr: Translator) {
  return sendPage(reply, tr, 503, ["login.unavailable.title"], ["login.unavailable.issuer"]);
}

/**
 * The login cookie's checks and return path, or undefined when it is
 * missing, forged, malformed or expired.
 */
function readLoginCookie(
  request: FastifyRequest,
  name: string,
  now: Date,
): { checks: LoginChecks; next: string | undefined } | undefined {
  const state = readLoginState(request, name, now);
  return state === undefined
    ? undefined
    : {
        checks: { codeVerifier: state.v, state: state.s, nonce: state.n },
        next: returnPath(state.r),
      };
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
  const locales = deps.locales ?? createLocales();

  /** The words for a request's pages: its language, else English. */
  async function words(request: FastifyRequest): Promise<Translator> {
    try {
      return await locales.translator(
        await locales.resolve(request.cookies[LANG_COOKIE], request.headers["accept-language"]),
      );
    } catch {
      return createTranslator(SOURCE_LOCALE, locales.english, locales.english);
    }
  }

  /**
   * Ends the session behind the session cookie this request carries, and
   * clears the cookie, as a sign-in that succeeds replaces it (issue #395).
   * Only that one session: the person's sessions in other browsers are for
   * Sign out everywhere. No cookie, nothing happens; a cookie with no session
   * behind it is only cleared. When the session cannot be ended (the
   * database is down) the failure is logged and the cookie is cleared all
   * the same, so this browser is signed out at once; the row then lives
   * until it expires, and Sign out everywhere can still end it.
   */
  async function endPresentedSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const cookie = request.cookies[SESSION_COOKIE];
    if (cookie === undefined) return;
    try {
      await deps.sessions.end(cookie);
    } catch (error) {
      request.log.warn({ err: error }, "auth: could not end the refused user's session");
    }
    reply.clearCookie(SESSION_COOKIE, SESSION_COOKIE_OPTIONS);
  }

  app.get("/auth/login", async (request, reply) => {
    let begun: Awaited<ReturnType<OidcClient["begin"]>>;
    try {
      begun = await deps.oidc.begin();
    } catch (error) {
      request.log.warn({ err: error }, "auth: login is unavailable: the issuer cannot be reached");
      return unavailable(reply, await words(request));
    }
    const next = returnPath(new URLSearchParams(queryOf(request.url)).get("next"));
    const state: LoginState = {
      v: begun.checks.codeVerifier,
      s: begun.checks.state,
      n: begun.checks.nonce,
      e: now().getTime() + LOGIN_COOKIE_MS,
      ...(next === undefined ? {} : { r: next }),
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
    let login: ReturnType<typeof readLoginCookie>;
    if (STATE_PATTERN.test(state)) {
      // This login's cookie is spent whatever happens next; another login's
      // cookie is left for its own callback.
      const name = loginCookieName(state);
      reply.clearCookie(name, LOGIN_COOKIE_OPTIONS);
      login = readLoginCookie(request, name, now());
    }
    if (login === undefined) {
      return sendPage(
        reply,
        await words(request),
        400,
        ["login.unfinished.title"],
        ["login.unfinished.expired"],
      );
    }
    const callbackUrl = new URL(`${deps.absoluteUrl("/auth/callback")}${queryOf(request.url)}`);
    let subject: string;
    let displayName: string | null | undefined;
    try {
      ({ subject, name: displayName } = await deps.oidc.finish(callbackUrl, login.checks));
    } catch (error) {
      const failure = error instanceof LoginError ? error.failure : "failed";
      // The subject's length, never the subject: one too long could be anything.
      const subjectLength = error instanceof LoginError ? error.subjectLength : undefined;
      request.log.warn(
        subjectLength === undefined ? { failure } : { failure, subjectLength },
        "auth: login refused",
      );
      if (NOT_LET_IN.has(failure)) await endPresentedSession(request, reply);
      switch (failure) {
        case "unavailable":
          return unavailable(reply, await words(request));
        case "subject_too_long":
          return sendPage(
            reply,
            await words(request),
            403,
            ["login.refused.title"],
            ["login.refused.subject", { max: MAX_SUBJECT_LENGTH }],
          );
        case "not_in_group":
          return sendPage(
            reply,
            await words(request),
            403,
            ["login.refused.title"],
            ["login.refused.group"],
          );
        case "email_not_verified":
          return sendPage(
            reply,
            await words(request),
            403,
            ["login.refused.title"],
            ["login.refused.email"],
          );
        default:
          return sendPage(
            reply,
            await words(request),
            400,
            ["login.unfinished.title"],
            ["login.unfinished.unchecked"],
          );
      }
    }
    let started: Awaited<ReturnType<Sessions["start"]>>;
    try {
      started = await deps.sessions.start(subject, displayName ?? null);
      // A session the browser already had is replaced, not kept beside it.
      await deps.sessions.end(request.cookies[SESSION_COOKIE]).catch(() => undefined);
    } catch (error) {
      request.log.warn({ err: error }, "auth: could not save the session");
      return sendPage(
        reply,
        await words(request),
        503,
        ["login.unavailable.title"],
        ["login.unavailable.session"],
      );
    }
    reply.setCookie(SESSION_COOKIE, started.id, {
      ...SESSION_COOKIE_OPTIONS,
      maxAge: SESSION_ABSOLUTE_MS / 1000,
    });
    reply.header("cache-control", "no-store");
    return reply.redirect(deps.absoluteUrl(login.next ?? "/"), 302);
  });

  app.post("/auth/logout", async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (request.headers.origin !== deps.publicOrigin) {
      return reply.code(403).send({ error: "forbidden" });
    }
    try {
      await deps.sessions.end(request.cookies[SESSION_COOKIE]);
    } catch (error) {
      // The cookie stays: the row it names is still live, and clearing it
      // here would leave the user looking signed out with no way to retry.
      request.log.warn({ err: error }, "auth: could not end the session");
      return reply.code(503).send({ error: "unavailable" });
    }
    reply.clearCookie(SESSION_COOKIE, SESSION_COOKIE_OPTIONS);
    return reply.code(204).send();
  });
}
