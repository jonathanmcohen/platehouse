// Build plan Task 15 (AC-080, AC-091): GET /auth/login, GET /auth/callback
// and POST /auth/logout against a local mock issuer. The login is the OIDC
// code flow with PKCE S256; state and nonce ride in a 10-minute signed,
// HttpOnly cookie; redirect_uri is absoluteUrl('/auth/callback') whatever
// Host or X-Forwarded-Host says; the scopes are openid email profile groups;
// a user must be in OIDC_GROUP with email_verified true or "true". Sessions
// last 7 days idle and 30 days at most, behind a __Host- cookie that is
// Secure, HttpOnly and SameSite=Lax.
//
// No container: sessions are in memory with a test clock (sessions-db.test.ts
// runs the same flow against Postgres).
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { admit, emailVerified, LoginError, OIDC_SCOPE } from "../../../src/auth/oidc.js";
import { LOGIN_COOKIE, LOGIN_COOKIE_MS } from "../../../src/auth/routes.js";
import {
  SESSION_ABSOLUTE_MS,
  SESSION_COOKIE,
  SESSION_IDLE_MS,
} from "../../../src/auth/sessions.js";
import {
  type AuthTestApp,
  authTestApp,
  runLogin,
  type SetCookie,
  setCookie,
  startMockIssuer,
  TEST_GROUP,
  TEST_ORIGIN,
  type TestUser,
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

  test("keeps the login in a 10-minute signed, HttpOnly __Host- cookie", async () => {
    const res = await t.app.inject({ method: "GET", url: "/auth/login" });
    const cookie = setCookie(res, LOGIN_COOKIE);
    expectHostCookie(cookie, LOGIN_COOKIE);
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
    const row = t.store.rows.get(run.sessionCookie ?? "");
    expect(row?.subject).toBe(t.issuer.user.sub);
    expect(row?.expiresAt.getTime()).toBe(t.clock.now.getTime() + SESSION_ABSOLUTE_MS);
    expect(row?.idleExpiresAt.getTime()).toBe(t.clock.now.getTime() + SESSION_IDLE_MS);
    // The login cookie is spent.
    expect(setCookie(run.callback, LOGIN_COOKIE)?.attributes.get("max-age")).toBe("0");
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
    const cookie = setCookie(start, LOGIN_COOKIE)?.value ?? "";
    const back = await t.issuer.authorize(String(start.headers.location));
    const dot = cookie.lastIndexOf(".");
    const flip = (s: string, i: number) =>
      `${s.slice(0, i)}${s[i] === "A" ? "B" : "A"}${s.slice(i + 1)}`;
    for (const forged of [flip(cookie, cookie.length - 1), flip(cookie, 0), cookie.slice(0, dot)]) {
      const res = await t.app.inject({
        method: "GET",
        url: `${back.pathname}${back.search}`,
        cookies: { [LOGIN_COOKIE]: forged },
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
    const cookie = setCookie(start, LOGIN_COOKIE)?.value ?? "";
    const back = await t.issuer.authorize(String(start.headers.location));
    back.searchParams.set("state", "not-the-state-this-login-sent");
    const res = await t.app.inject({
      method: "GET",
      url: `${back.pathname}${back.search}`,
      cookies: { [LOGIN_COOKIE]: cookie },
    });
    expect(res.statusCode).toBe(400);
    expect(t.store.rows.size).toBe(0);
  });

  test("an error sent back by Pocket ID is 400 with no session", async () => {
    const start = await t.app.inject({ method: "GET", url: "/auth/login" });
    const cookie = setCookie(start, LOGIN_COOKIE)?.value ?? "";
    const state = new URL(String(start.headers.location)).searchParams.get("state") ?? "";
    const res = await t.app.inject({
      method: "GET",
      url: `/auth/callback?error=access_denied&state=${encodeURIComponent(state)}`,
      cookies: { [LOGIN_COOKIE]: cookie },
    });
    expect(res.statusCode).toBe(400);
    expect(t.store.rows.size).toBe(0);
  });

  test("a code cannot be used twice", async () => {
    const run = await runLogin(t);
    expect(run.callback.statusCode).toBe(302);
    const again = await t.app.inject({
      method: "GET",
      url: `${run.callbackUrl.pathname}${run.callbackUrl.search}`,
      cookies: { [LOGIN_COOKIE]: run.loginCookie ?? "" },
    });
    expect(again.statusCode).toBe(400);
    expect(t.store.rows.size).toBe(1);
  });
});

describe("POST /auth/logout", () => {
  test("ends the session and clears its cookie", async () => {
    const run = await runLogin(t);
    const res = await t.app.inject({
      method: "POST",
      url: "/auth/logout",
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
    const res = await t.app.inject({ method: "POST", url: "/auth/logout" });
    expect(res.statusCode).toBe(204);
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
