// Build plan Task 15 (AC-080, AC-091): GET /auth/login, GET /auth/callback
// and POST /auth/logout against a local mock issuer. The login is the OIDC
// code flow with PKCE S256; state and nonce ride in a 10-minute signed,
// HttpOnly cookie; redirect_uri is absoluteUrl('/auth/callback') whatever
// Host or X-Forwarded-Host says; the scopes are openid email profile groups;
// a user must be in OIDC_GROUP with email_verified true or "true". Sessions
// last 7 days idle and 30 days at most, behind a __Host- cookie that is
// Secure, HttpOnly and SameSite=Lax. The cookie carries 32 random bytes in
// base64url; the session is stored under the base64url SHA-256 of that value,
// so a stored id is not a working cookie. An ID token or userinfo answer that
// does not check out (another nonce, audience or issuer, expired, or userinfo
// about another subject) is 400 and makes no session.
//
// No container: sessions are in memory with a test clock (sessions-db.test.ts
// runs the same flow against Postgres).

import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildApp } from "../../../src/app.js";
import { admit, emailVerified, LoginError, OIDC_SCOPE } from "../../../src/auth/oidc.js";
import {
  LOGIN_COOKIE_MS,
  LOGIN_COOKIE_PREFIX,
  loginCookieName,
  MAX_PENDING_LOGINS,
} from "../../../src/auth/routes.js";
import {
  SESSION_ABSOLUTE_MS,
  SESSION_COOKIE,
  SESSION_IDLE_MS,
  sessionRowId,
} from "../../../src/auth/sessions.js";
import { createUploads } from "../../../src/uploads/tus.js";
import {
  type AuthTestApp,
  authTestApp,
  type Forgery,
  loginCookieOf,
  runLogin,
  type SetCookie,
  setCookie,
  setCookies,
  startMockIssuer,
  TEST_GROUP,
  TEST_ORIGIN,
  type TestUser,
  testAuth,
} from "../support/oidc-issuer.js";

const RESULT_PATH = "/app/uploads/0198f0c4-6a1b-7c2d-8e3f-4a5b6c7d8e9f/result";
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

let t: AuthTestApp;

async function appFor(user?: Partial<TestUser>): Promise<AuthTestApp> {
  await t?.close();
  t = await authTestApp({ issuer: await startMockIssuer(user === undefined ? {} : { user }) });
  return t;
}

beforeEach(async () => {
  t = await authTestApp();
});

afterEach(async () => {
  await t?.close();
});

/** A session-class request with this session cookie: 404 when it is let in, 401 when not. */
async function withSession(cookie: string | undefined): Promise<number> {
  const res = await t.app.inject({
    method: "GET",
    url: RESULT_PATH,
    cookies: cookie === undefined ? {} : { [SESSION_COOKIE]: cookie },
  });
  return res.statusCode;
}

function expectHostCookie(cookie: SetCookie | undefined, name: string) {
  expect(cookie, name).toBeDefined();
  if (cookie === undefined) return;
  expect(cookie.name).toBe(name);
  expect(cookie.name.startsWith("__Host-")).toBe(true);
  expect(cookie.attributes.get("secure")).toBe(true);
  expect(cookie.attributes.get("httponly")).toBe(true);
  expect(String(cookie.attributes.get("samesite")).toLowerCase()).toBe("lax");
  expect(cookie.attributes.get("path")).toBe("/");
  expect(cookie.attributes.has("domain")).toBe(false);
}

describe("GET /auth/login", () => {
  test("sends the browser to Pocket ID: code flow, PKCE S256, state, nonce and the scopes", async () => {
    const res = await t.app.inject({ method: "GET", url: "/auth/login" });
    expect(res.statusCode).toBe(302);
    const location = new URL(String(res.headers.location));
    expect(`${location.origin}${location.pathname}`).toBe(`${t.issuer.url}/authorize`);
    const q = location.searchParams;
    expect(q.get("response_type")).toBe("code");
    expect(q.get("client_id")).toBe(t.issuer.clientId);
    expect(q.get("scope")).toBe("openid email profile groups");
    expect(OIDC_SCOPE).toBe("openid email profile groups");
    expect(q.get("redirect_uri")).toBe(`${TEST_ORIGIN}/auth/callback`);
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get("state")?.length ?? 0).toBeGreaterThanOrEqual(22);
    expect(q.get("nonce")?.length ?? 0).toBeGreaterThanOrEqual(22);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  test("keeps the login in a 10-minute signed, HttpOnly __Host- cookie named for its state", async () => {
    const res = await t.app.inject({ method: "GET", url: "/auth/login" });
    const state = new URL(String(res.headers.location)).searchParams.get("state") ?? "";
    expect(loginCookieName(state)).toBe(`${LOGIN_COOKIE_PREFIX}${state}`);
    expect(LOGIN_COOKIE_PREFIX).toBe("__Host-ph_login_");
    const cookie = setCookie(res, loginCookieName(state));
    expectHostCookie(cookie, loginCookieName(state));
    expect(cookie?.attributes.get("max-age")).toBe(String(LOGIN_COOKIE_MS / 1000));
    expect(LOGIN_COOKIE_MS).toBe(10 * MINUTE);
    // Signed: a value, a dot, then the HMAC.
    expect(cookie?.value).toMatch(/^[^.]+\.[A-Za-z0-9+/%_-]+$/);
  });

  test("each login gets its own state, nonce and verifier", async () => {
    const a = await t.app.inject({ method: "GET", url: "/auth/login" });
    const b = await t.app.inject({ method: "GET", url: "/auth/login" });
    const qa = new URL(String(a.headers.location)).searchParams;
    const qb = new URL(String(b.headers.location)).searchParams;
    for (const name of ["state", "nonce", "code_challenge"]) {
      expect(qa.get(name), name).not.toBe(qb.get(name));
    }
  });

  test("two logins that overlap both finish, in either order", async () => {
    for (const order of [
      [0, 1],
      [1, 0],
    ]) {
      t.store.rows.clear();
      // The browser's cookie jar: a Set-Cookie replaces a cookie of the same
      // name, and Max-Age=0 removes it.
      const jar = new Map<string, string>();
      const keep = (res: { headers: Record<string, unknown> }) => {
        for (const c of setCookies(res)) {
          if (c.attributes.get("max-age") === "0") jar.delete(c.name);
          else jar.set(c.name, c.value);
        }
      };
      const backs: URL[] = [];
      for (let i = 0; i < 2; i++) {
        const start = await t.app.inject({ method: "GET", url: "/auth/login" });
        keep(start);
        backs.push(await t.issuer.authorize(String(start.headers.location)));
      }
      for (const i of order) {
        const back = backs[i] as URL;
        const res = await t.app.inject({
          method: "GET",
          url: `${back.pathname}${back.search}`,
          cookies: Object.fromEntries(jar),
        });
        keep(res);
        expect(res.statusCode, `login ${i} of order ${order}`).toBe(302);
        expect(setCookie(res, SESSION_COOKIE), `login ${i}`).toBeDefined();
      }
      expect(t.store.rows.size).toBe(1);
      expect([...jar.keys()].filter((name) => name.startsWith(LOGIN_COOKIE_PREFIX))).toEqual([]);
    }
  });

  test("50 logins that never finish leave at most 5 login cookies, the newest, and they still finish", async () => {
    // Each signed-out page load the gate sends to /auth/login starts a login;
    // ones abandoned at Pocket ID must not pile up until the Cookie header
    // passes Node's 16 KiB limit and every request is 431.
    const jar = new Map<string, string>();
    const keep = (res: { headers: Record<string, unknown> }) => {
      for (const c of setCookies(res)) {
        if (c.attributes.get("max-age") === "0") jar.delete(c.name);
        else jar.set(c.name, c.value);
      }
    };
    const pending = () => [...jar.keys()].filter((name) => name.startsWith(LOGIN_COOKIE_PREFIX));
    const starts: string[] = [];
    for (let i = 0; i < 50; i++) {
      const start = await t.app.inject({
        method: "GET",
        url: "/auth/login",
        cookies: Object.fromEntries(jar),
      });
      expect(start.statusCode, `login ${i}`).toBe(302);
      keep(start);
      expect(pending().length, `login ${i}`).toBeLessThanOrEqual(MAX_PENDING_LOGINS);
      starts.push(String(start.headers.location));
      t.clock.advance(1_000);
    }
    expect(MAX_PENDING_LOGINS).toBe(5);
    // The newest five are the ones kept.
    const newest = starts.slice(-MAX_PENDING_LOGINS);
    expect(pending().sort()).toEqual(
      newest.map((url) => loginCookieName(new URL(url).searchParams.get("state") ?? "")).sort(),
    );
    // The first login's cookie is gone, so its callback is refused.
    const first = await t.issuer.authorize(starts[0] as string);
    const old = await t.app.inject({
      method: "GET",
      url: `${first.pathname}${first.search}`,
      cookies: Object.fromEntries(jar),
    });
    expect(old.statusCode).toBe(400);
    // Each of the newest five still finishes.
    for (const url of newest.reverse()) {
      const back = await t.issuer.authorize(url);
      const res = await t.app.inject({
        method: "GET",
        url: `${back.pathname}${back.search}`,
        cookies: Object.fromEntries(jar),
      });
      keep(res);
      expect(res.statusCode, url).toBe(302);
      expect(setCookie(res, SESSION_COOKIE)).toBeDefined();
    }
    expect(pending()).toEqual([]);
  });

  test("a new login clears login cookies that are expired or forged", async () => {
    const stale = await t.app.inject({ method: "GET", url: "/auth/login" });
    const staleCookie = loginCookieOf(stale);
    t.clock.advance(LOGIN_COOKIE_MS + 1_000);
    const forgedName = loginCookieName("f".repeat(43));
    const res = await t.app.inject({
      method: "GET",
      url: "/auth/login",
      cookies: {
        [staleCookie?.name ?? ""]: staleCookie?.value ?? "",
        [forgedName]: "not-signed",
      },
    });
    expect(res.statusCode).toBe(302);
    for (const name of [staleCookie?.name ?? "", forgedName]) {
      expect(setCookie(res, name)?.attributes.get("max-age"), name).toBe("0");
    }
  });

  test("redirect_uri uses PUBLIC_ORIGIN under a spoofed Host and X-Forwarded-Host (AC-091)", async () => {
    const spoofed = {
      host: "evil.example",
      "x-forwarded-host": "evil.example",
      "x-forwarded-proto": "http",
      "x-forwarded-port": "8080",
      forwarded: "host=evil.example;proto=http",
    };
    const run = await runLogin(t, { headers: spoofed });
    const authorize = t.issuer.authorizeRequests[0];
    expect(authorize?.get("redirect_uri")).toBe(`${TEST_ORIGIN}/auth/callback`);
    // The token request repeats the redirect_uri; it too comes from PUBLIC_ORIGIN.
    expect(t.issuer.tokenRequests).toHaveLength(1);
    expect(t.issuer.tokenRequests[0]?.form.get("redirect_uri")).toBe(
      `${TEST_ORIGIN}/auth/callback`,
    );
    expect(run.callback.statusCode).toBe(302);
    expect(run.callback.headers.location).toBe(`${TEST_ORIGIN}/`);
    expect(JSON.stringify(run.start.headers)).not.toContain("evil.example");
    expect(JSON.stringify(run.callback.headers)).not.toContain("evil.example");
  });
});

describe("GET /auth/callback", () => {
  test("a group member with a verified email gets a session and is sent home", async () => {
    const run = await runLogin(t);
    expect(run.callback.statusCode).toBe(302);
    expect(run.callback.headers.location).toBe(`${TEST_ORIGIN}/`);
    expect(run.sessionCookie).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = t.store.rows.get(sessionRowId(run.sessionCookie ?? ""));
    expect(row?.subject).toBe(t.issuer.user.sub);
    expect(row?.expiresAt.getTime()).toBe(t.clock.now.getTime() + SESSION_ABSOLUTE_MS);
    expect(row?.idleExpiresAt.getTime()).toBe(t.clock.now.getTime() + SESSION_IDLE_MS);
    // The login cookie is spent.
    expect(loginCookieOf(run.callback)?.attributes.get("max-age")).toBe("0");
    expect(await withSession(run.sessionCookie)).toBe(404);
    expect(await withSession(undefined)).toBe(401);
  });

  test("the session cookie is __Host-, Secure, HttpOnly, SameSite=Lax", async () => {
    const run = await runLogin(t);
    const cookie = setCookie(run.callback, SESSION_COOKIE);
    expectHostCookie(cookie, SESSION_COOKIE);
    expect(SESSION_COOKIE).toBe("__Host-ph_session");
    expect(cookie?.attributes.get("max-age")).toBe(String(SESSION_ABSOLUTE_MS / 1000));
  });

  test("the code is exchanged with the PKCE verifier and the client's credentials", async () => {
    await runLogin(t);
    const token = t.issuer.tokenRequests[0];
    expect(token?.form.get("grant_type")).toBe("authorization_code");
    expect(token?.form.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
  });

  test('email_verified sent as the string "true" is accepted', async () => {
    await appFor({ email_verified: "true" });
    const run = await runLogin(t);
    expect(run.callback.statusCode).toBe(302);
    expect(await withSession(run.sessionCookie)).toBe(404);
  });

  for (const value of [false, "false", "TRUE", 1, "yes", null, undefined]) {
    test(`email_verified ${JSON.stringify(value) ?? "left out"} is refused`, async () => {
      await appFor({ email_verified: value });
      const run = await runLogin(t);
      expect(run.callback.statusCode).toBe(403);
      expect(run.callback.headers["content-type"]).toMatch(/^text\/html/);
      expect(run.callback.body).toMatch(/email address is not verified/i);
      expect(run.sessionCookie).toBeUndefined();
      expect(t.store.rows.size).toBe(0);
    });
  }

  for (const groups of [["other"], [], ["platehouse-admins"], "platehouse-admins", undefined]) {
    test(`a user outside the platehouse group is refused (groups ${JSON.stringify(groups) ?? "left out"})`, async () => {
      await appFor({ groups });
      const run = await runLogin(t);
      expect(run.callback.statusCode).toBe(403);
      expect(run.callback.body).toContain(`not in the ${TEST_GROUP} group`);
      expect(run.sessionCookie).toBeUndefined();
      expect(t.store.rows.size).toBe(0);
    });
  }

  test("groups and email_verified are read from userinfo when the ID token leaves them out", async () => {
    await appFor({ claimsInIdToken: false, email_verified: "true" });
    const run = await runLogin(t);
    expect(run.callback.statusCode).toBe(302);
    expect(await withSession(run.sessionCookie)).toBe(404);
  });

  test("with no login cookie it is 400, makes no session and asks the issuer nothing", async () => {
    const start = await t.app.inject({ method: "GET", url: "/auth/login" });
    const back = await t.issuer.authorize(String(start.headers.location));
    const res = await t.app.inject({ method: "GET", url: `${back.pathname}${back.search}` });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/try again/i);
    expect(setCookie(res, SESSION_COOKIE)).toBeUndefined();
    expect(t.issuer.tokenRequests).toHaveLength(0);
  });

  test("a login cookie with an altered signature or value is 400", async () => {
    const start = await t.app.inject({ method: "GET", url: "/auth/login" });
    const login = loginCookieOf(start);
    const name = login?.name ?? "";
    const cookie = login?.value ?? "";
    const back = await t.issuer.authorize(String(start.headers.location));
    const dot = cookie.lastIndexOf(".");
    const flip = (s: string, i: number) =>
      `${s.slice(0, i)}${s[i] === "A" ? "B" : "A"}${s.slice(i + 1)}`;
    for (const forged of [flip(cookie, cookie.length - 1), flip(cookie, 0), cookie.slice(0, dot)]) {
      const res = await t.app.inject({
        method: "GET",
        url: `${back.pathname}${back.search}`,
        cookies: { [name]: forged },
      });
      expect(res.statusCode, forged).toBe(400);
    }
    expect(t.issuer.tokenRequests).toHaveLength(0);
    expect(t.store.rows.size).toBe(0);
  });

  test("a login older than 10 minutes is 400", async () => {
    const run = await runLogin(t, {
      beforeCallback: () => t.clock.advance(LOGIN_COOKIE_MS + 1_000),
    });
    expect(run.callback.statusCode).toBe(400);
    expect(run.sessionCookie).toBeUndefined();
  });

  test("a login 9:59 old still works", async () => {
    const run = await runLogin(t, {
      beforeCallback: () => t.clock.advance(LOGIN_COOKIE_MS - 1_000),
    });
    expect(run.callback.statusCode).toBe(302);
    expect(run.sessionCookie).toBeDefined();
  });

  test("a state that does not match the login cookie is 400", async () => {
    const start = await t.app.inject({ method: "GET", url: "/auth/login" });
    const login = loginCookieOf(start);
    const back = await t.issuer.authorize(String(start.headers.location));
    const state = back.searchParams.get("state") ?? "";
    back.searchParams.set("state", "not-the-state-this-login-sent");
    for (const name of [login?.name ?? "", loginCookieName("not-the-state-this-login-sent")]) {
      const res = await t.app.inject({
        method: "GET",
        url: `${back.pathname}${back.search}`,
        cookies: { [name]: login?.value ?? "" },
      });
      expect(res.statusCode, name).toBe(400);
    }
    expect(state).not.toBe("");
    expect(t.issuer.tokenRequests).toHaveLength(0);
    expect(t.store.rows.size).toBe(0);
  });

  test("a state that is not a plain token is 400 and sets no cookie by that name", async () => {
    for (const state of ["", "a b", "a;b", "a=b", "x".repeat(200)]) {
      const res = await t.app.inject({
        method: "GET",
        url: `/auth/callback?code=c&state=${encodeURIComponent(state)}`,
      });
      expect(res.statusCode, state).toBe(400);
      expect(
        setCookies(res).filter((c) => c.name.startsWith(LOGIN_COOKIE_PREFIX)),
        state,
      ).toEqual([]);
    }
  });

  test("an error sent back by Pocket ID is 400 with no session", async () => {
    const start = await t.app.inject({ method: "GET", url: "/auth/login" });
    const login = loginCookieOf(start);
    const state = new URL(String(start.headers.location)).searchParams.get("state") ?? "";
    const res = await t.app.inject({
      method: "GET",
      url: `/auth/callback?error=access_denied&state=${encodeURIComponent(state)}`,
      cookies: { [login?.name ?? ""]: login?.value ?? "" },
    });
    expect(res.statusCode).toBe(400);
    expect(t.store.rows.size).toBe(0);
  });

  const forgeries: [string, Partial<TestUser> & { forge: Forgery }][] = [
    ["an ID token with another nonce", { forge: { nonce: "not-the-login-nonce" } }],
    ["an ID token for another audience", { forge: { aud: "some-other-client" } }],
    ["an ID token from another issuer", { forge: { iss: "https://id.evil.example" } }],
    ["an ID token that has expired", { forge: { expiredSecondsAgo: 600 } }],
    [
      "a userinfo answer about another subject than the ID token",
      { claimsInIdToken: false, forge: { userinfoSub: "someone-else" } },
    ],
  ];
  for (const [label, user] of forgeries) {
    test(`${label} is refused with 400 and makes no session`, async () => {
      const app = await appFor(user);
      const run = await runLogin(app);
      expect(run.callback.statusCode).toBe(400);
      expect(run.sessionCookie).toBeUndefined();
      expect(app.store.rows.size).toBe(0);
      // The token was exchanged, so the refusal is the app's check, not the issuer's.
      expect(app.issuer.tokenRequests).toHaveLength(1);
    });
  }

  test("a code cannot be used twice", async () => {
    const run = await runLogin(t);
    expect(run.callback.statusCode).toBe(302);
    const again = await t.app.inject({
      method: "GET",
      url: `${run.callbackUrl.pathname}${run.callbackUrl.search}`,
      cookies: { [run.loginCookieName ?? ""]: run.loginCookie ?? "" },
    });
    expect(again.statusCode).toBe(400);
    expect(t.store.rows.size).toBe(1);
  });
});

describe("the stored session id", () => {
  test("is the base64url SHA-256 of the cookie value, never the cookie value", async () => {
    const run = await runLogin(t);
    const cookie = run.sessionCookie ?? "";
    expect(cookie).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const ids = [...t.store.rows.keys()];
    expect(ids).toHaveLength(1);
    expect(ids[0]).not.toBe(cookie);
    expect(ids[0]).toBe(createHash("sha256").update(cookie).digest("base64url"));
    expect(ids[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("a request carrying a stored id as its cookie is refused", async () => {
    const run = await runLogin(t);
    expect(await withSession(run.sessionCookie)).toBe(404);
    const [stored] = [...t.store.rows.keys()];
    expect(await withSession(stored)).toBe(401);
  });
});

describe("POST /auth/logout", () => {
  test("ends the session and clears its cookie", async () => {
    const run = await runLogin(t);
    const res = await t.app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { origin: TEST_ORIGIN },
      cookies: { [SESSION_COOKIE]: run.sessionCookie ?? "" },
    });
    expect(res.statusCode).toBe(204);
    const cleared = setCookie(res, SESSION_COOKIE);
    expectHostCookie(cleared, SESSION_COOKIE);
    expect(cleared?.attributes.get("max-age")).toBe("0");
    expect(t.store.rows.size).toBe(0);
    expect(await withSession(run.sessionCookie)).toBe(401);
  });

  test("with no session it is 204 too", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { origin: TEST_ORIGIN },
    });
    expect(res.statusCode).toBe(204);
  });

  test("when the session cannot be ended it is 503 and keeps the cookie, so a retry can end it", async () => {
    const run = await runLogin(t);
    t.store.failWith = new Error("the database is down");
    const failed = await t.app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { origin: TEST_ORIGIN },
      cookies: { [SESSION_COOKIE]: run.sessionCookie ?? "" },
    });
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toEqual({ error: "unavailable" });
    expect(failed.headers["cache-control"]).toBe("no-store");
    expect(setCookie(failed, SESSION_COOKIE)).toBeUndefined();
    expect(t.store.rows.size).toBe(1);

    delete t.store.failWith;
    const retried = await t.app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { origin: TEST_ORIGIN },
      cookies: { [SESSION_COOKIE]: run.sessionCookie ?? "" },
    });
    expect(retried.statusCode).toBe(204);
    expect(setCookie(retried, SESSION_COOKIE)?.attributes.get("max-age")).toBe("0");
    expect(t.store.rows.size).toBe(0);
    expect(await withSession(run.sessionCookie)).toBe(401);
  });

  for (const origin of ["https://evil.example", "https://sub.platehouse.test", "null", undefined]) {
    test(`from Origin ${origin ?? "left out"} it is 403 and the session lives on`, async () => {
      const run = await runLogin(t);
      const res = await t.app.inject({
        method: "POST",
        url: "/auth/logout",
        headers: origin === undefined ? {} : { origin },
        cookies: { [SESSION_COOKIE]: run.sessionCookie ?? "" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(setCookie(res, SESSION_COOKIE)).toBeUndefined();
      expect(t.store.rows.size).toBe(1);
      expect(await withSession(run.sessionCookie)).toBe(404);
    });
  }
});

describe("the request log", () => {
  test("never holds the callback's code or state", async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const a = await testAuth();
    const dir = await mkdtemp(join(tmpdir(), "platehouse-log-"));
    const app = await buildApp({
      health: { database: async () => 1, queuesRunning: () => true },
      uploads: createUploads({
        tmpDir: dir,
        queue: { enqueue: async () => {}, result: async () => undefined },
        log: () => {},
      }),
      auth: a.auth,
      logger: stream,
    });
    try {
      await app.ready();
      const run = await runLogin({ app, issuer: a.issuer });
      expect(run.callback.statusCode).toBe(302);
      const code = run.callbackUrl.searchParams.get("code") ?? "";
      const state = run.callbackUrl.searchParams.get("state") ?? "";
      expect(code).not.toBe("");
      const log = lines.join("");
      // The callback's request is logged, by its path alone.
      expect(log).toContain('"url":"/auth/callback"');
      expect(log).not.toContain(code);
      expect(log).not.toContain(state);
      expect(log).not.toContain(run.loginCookie ?? "no login cookie");
      expect(log).not.toContain(run.sessionCookie ?? "no session cookie");
    } finally {
      await app.close();
      await a.issuer.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("session lifetime", () => {
  test("a session ends after 7 days without a request", async () => {
    const run = await runLogin(t);
    t.clock.advance(SESSION_IDLE_MS - MINUTE);
    expect(await withSession(run.sessionCookie)).toBe(404);
    t.clock.advance(SESSION_IDLE_MS + MINUTE);
    expect(await withSession(run.sessionCookie)).toBe(401);
    expect(SESSION_IDLE_MS).toBe(7 * DAY);
  });

  test("each request moves the idle expiry on", async () => {
    const run = await runLogin(t);
    for (let day = 6; day <= 24; day += 6) {
      t.clock.advance(6 * DAY);
      expect(await withSession(run.sessionCookie), `day ${day}`).toBe(404);
    }
  });

  test("a session ends 30 days after login, however busy", async () => {
    const run = await runLogin(t);
    for (let day = 5; day < 30; day += 5) {
      t.clock.advance(5 * DAY);
      expect(await withSession(run.sessionCookie), `day ${day}`).toBe(404);
    }
    t.clock.advance(5 * DAY);
    expect(await withSession(run.sessionCookie)).toBe(401);
    expect(SESSION_ABSOLUTE_MS).toBe(30 * DAY);
  });
});

describe("the claim checks", () => {
  test('emailVerified takes true and "true" only', () => {
    expect(emailVerified(true)).toBe(true);
    expect(emailVerified("true")).toBe(true);
    for (const value of [false, "false", "TRUE", "True", 1, "1", "yes", null, undefined, {}]) {
      expect(emailVerified(value), JSON.stringify(value)).toBe(false);
    }
  });

  test("admit lets in a verified member of the group and names the subject", () => {
    expect(
      admit({ sub: "abc", email_verified: "true", groups: ["x", TEST_GROUP] }, TEST_GROUP),
    ).toEqual({ subject: "abc" });
  });

  test("admit refuses with the reason", () => {
    const failure = (claims: Record<string, unknown>) => {
      try {
        admit(claims, TEST_GROUP);
      } catch (error) {
        if (error instanceof LoginError) return error.failure;
        throw error;
      }
      return "admitted";
    };
    expect(failure({ sub: "abc", email_verified: true, groups: ["other"] })).toBe("not_in_group");
    expect(failure({ sub: "abc", email_verified: false, groups: [TEST_GROUP] })).toBe(
      "email_not_verified",
    );
    expect(failure({ email_verified: true, groups: [TEST_GROUP] })).toBe("failed");
    expect(failure({ sub: "", email_verified: true, groups: [TEST_GROUP] })).toBe("failed");
  });
});
