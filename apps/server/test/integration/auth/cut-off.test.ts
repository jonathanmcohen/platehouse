// Issue #322: cutting off a user removed from the sign-in group (OIDC_GROUP).
//
// - Each API token records who made it: the OIDC subject and the display
//   name the session had then. Settings lists it; a token made before this
//   was recorded lists its creator as unknown (createdBy null).
// - A new API token needs a fresh sign-in: a session signed in more than
//   TOKEN_SIGN_IN_WINDOW_MS ago is refused with 403 sign_in_required, and the
//   page sends the user through /auth/login?next=/settings. That sign-in
//   checks the group again, so a user who has left it gets no fresh session
//   and no new API access. Sessions keep nothing from the issuer
//   (sessions.ts), so the check is a new sign-in, not a userinfo call; while
//   the issuer cannot be reached that sign-in fails, so nothing new is made.
// - Sign out everywhere (POST /app/api/users/sign-out) ends every session of
//   one user and, when asked, revokes every live token that user made.
//   Every signed-in user may use it: the app has no roles, and every member
//   of the group can already revoke any token and change any setting.
//
// No container: sessions and tokens are in memory, against the mock issuer
// (sessions-db.test.ts and settings.test.ts run the same against Postgres).
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createTokens, TOKEN_PATTERN, type Tokens } from "../../../src/api/tokens.js";
import { refusingApi } from "../../../src/api/v1.js";
import { TOKEN_SIGN_IN_WINDOW_MS } from "../../../src/app-api/tokens.js";
import { SESSION_COOKIE, sessionRowId } from "../../../src/auth/sessions.js";
import {
  type AuthTestApp,
  authTestApp,
  type MemoryTokenStore,
  memoryTokenList,
  memoryTokenStore,
  memoryUserList,
  runLogin,
  TEST_GROUP,
  TEST_ORIGIN,
} from "../support/oidc-issuer.js";

const MINUTE = 60_000;

let t: AuthTestApp;
let tokenStore: MemoryTokenStore;
let tokens: Tokens;

beforeEach(async () => {
  tokenStore = memoryTokenStore();
  tokens = createTokens({ store: tokenStore, log: () => {} });
  t = await authTestApp({
    api: { tokens, library: refusingApi.library },
    appApi: (auth) => ({
      tokens: { tokens, list: memoryTokenList(tokenStore) },
      users: {
        list: memoryUserList(auth.store, tokenStore),
        sessions: auth.sessions,
        tokens,
      },
    }),
  });
});

afterEach(async () => {
  await t?.close();
});

interface Answer {
  status: number;
  text: string;
  json(): unknown;
}

/** One app API request with this session cookie and a same-origin Origin. */
async function call(
  method: "GET" | "POST" | "DELETE",
  url: string,
  cookie: string,
  json?: unknown,
): Promise<Answer> {
  const res = await t.app.inject({
    method,
    url,
    headers: {
      accept: "application/json",
      origin: TEST_ORIGIN,
      ...(json === undefined ? {} : { "content-type": "application/json" }),
    },
    cookies: { [SESSION_COOKIE]: cookie },
    ...(json === undefined ? {} : { payload: JSON.stringify(json) }),
  });
  return { status: res.statusCode, text: res.body, json: () => JSON.parse(res.body) };
}

/** Signs in through the mock issuer as this subject and name; returns the session cookie. */
async function signIn(sub: string, name?: string): Promise<string> {
  const { name: _previous, ...rest } = t.issuer.user;
  t.issuer.user = { ...rest, sub, ...(name === undefined ? {} : { name }), groups: [TEST_GROUP] };
  const run = await runLogin(t);
  expect(run.callback.statusCode, run.callback.body).toBe(302);
  const cookie = run.sessionCookie;
  if (cookie === undefined) throw new Error("the login set no session cookie");
  return cookie;
}

/** Moves the session behind this cookie's sign-in back by ms, as if it were made that long ago. */
function ageSession(cookie: string, ms: number): void {
  const id = sessionRowId(cookie);
  const row = t.store.rows.get(id);
  if (row === undefined) throw new Error("no such session");
  t.store.rows.set(id, { ...row, createdAt: new Date(row.createdAt.getTime() - ms) });
}

/** GET /api/v1/models with this bearer credential: 200 while it is a live token. */
async function v1Status(auth: string): Promise<number> {
  const res = await t.app.inject({
    method: "GET",
    url: "/api/v1/models",
    headers: { authorization: `Bearer ${auth}` },
  });
  return res.statusCode;
}

async function makeToken(cookie: string, name: string) {
  const res = await call("POST", "/app/api/tokens", cookie, { name });
  expect(res.status, res.text).toBe(201);
  return res.json() as { id: string; token: string; createdBy: unknown };
}

describe("who made a token", () => {
  test("a new token records the subject and display name of the session that made it", async () => {
    const cookie = await signIn("subject-maker-1", "Synthetic Maker");
    const created = await makeToken(cookie, "Laptop script");
    expect(TOKEN_PATTERN.test(created.token)).toBe(true);
    expect(created.createdBy).toEqual({ subject: "subject-maker-1", name: "Synthetic Maker" });

    const row = tokenStore.rows.get(created.id);
    expect(row?.createdBySubject).toBe("subject-maker-1");
    expect(row?.createdByName).toBe("Synthetic Maker");

    const list = await call("GET", "/app/api/tokens", cookie);
    expect(list.status, list.text).toBe(200);
    const listed = (list.json() as { tokens: Array<{ id: string; createdBy: unknown }> }).tokens;
    expect(listed.find((r) => r.id === created.id)?.createdBy).toEqual({
      subject: "subject-maker-1",
      name: "Synthetic Maker",
    });
  });

  test("a session with no display name records the subject and a null name", async () => {
    // No name claim and no email (the name falls back to the email address).
    const { email: _email, ...noEmail } = t.issuer.user;
    t.issuer.user = noEmail;
    const cookie = await signIn("subject-no-name");
    const created = await makeToken(cookie, "Desk script");
    expect(created.createdBy).toEqual({ subject: "subject-no-name", name: null });
  });

  test("a token made before creators were recorded lists its creator as unknown", async () => {
    const cookie = await signIn("subject-viewer");
    // A row as 0.1.0 left it: no creator recorded.
    const old = await tokenStore.create({
      name: "Old script",
      prefix: "ph_abcde",
      tokenHash: Buffer.alloc(32, 7),
    });
    const list = await call("GET", "/app/api/tokens", cookie);
    const listed = (list.json() as { tokens: Array<{ id: string; createdBy: unknown }> }).tokens;
    expect(listed.find((r) => r.id === old.id)?.createdBy).toBeNull();
  });
});

describe("a new token needs a fresh sign-in", () => {
  test("a session signed in within the window can make a token", async () => {
    const cookie = await signIn("subject-fresh");
    ageSession(cookie, TOKEN_SIGN_IN_WINDOW_MS - MINUTE);
    expect((await call("POST", "/app/api/tokens", cookie, { name: "ok" })).status).toBe(201);
  });

  test("an older session is refused with sign_in_required, and no token is made", async () => {
    const cookie = await signIn("subject-stale");
    ageSession(cookie, TOKEN_SIGN_IN_WINDOW_MS + MINUTE);
    const res = await call("POST", "/app/api/tokens", cookie, { name: "too late" });
    expect(res.status, res.text).toBe(403);
    expect(res.json()).toMatchObject({
      error: "sign_in_required",
      code: "sign_in_required",
      signIn: "/auth/login?next=/settings",
    });
    expect(res.text).not.toMatch(/ph_/);
    expect(tokenStore.rows.size).toBe(0);
    // Listing still works on an older session.
    expect((await call("GET", "/app/api/tokens", cookie)).status).toBe(200);
  });

  test("a user removed from the group is refused a new token, and cannot get a fresh sign-in", async () => {
    const cookie = await signIn("subject-removed", "Synthetic Leaver");
    ageSession(cookie, TOKEN_SIGN_IN_WINDOW_MS + MINUTE);

    // Removed at the provider: the next sign-in carries no platehouse group.
    t.issuer.user = { ...t.issuer.user, groups: ["other"] };
    const again = await runLogin(t, { headers: { cookie: `${SESSION_COOKIE}=${cookie}` } });
    expect(again.callback.statusCode).toBe(403);
    expect(again.sessionCookie).toBeUndefined();

    const res = await call("POST", "/app/api/tokens", cookie, { name: "after removal" });
    expect(res.status, res.text).toBe(403);
    expect((res.json() as { error: string }).error).toBe("sign_in_required");
    expect(tokenStore.rows.size).toBe(0);
  });

  test("a member who signs in again gets a fresh session and can make a token", async () => {
    const stale = await signIn("subject-member");
    ageSession(stale, TOKEN_SIGN_IN_WINDOW_MS + MINUTE);
    expect((await call("POST", "/app/api/tokens", stale, { name: "x" })).status).toBe(403);
    const fresh = await signIn("subject-member");
    expect((await call("POST", "/app/api/tokens", fresh, { name: "x" })).status).toBe(201);
  });

  test("while the issuer cannot be reached no new token can be made, and the sign-in it asks for fails", async () => {
    const cookie = await signIn("subject-issuer-down");
    ageSession(cookie, TOKEN_SIGN_IN_WINDOW_MS + MINUTE);

    // The sign-in it asks for: the issuer goes down before the code exchange,
    // so the callback is 503 and no fresh session is made.
    const again = await runLogin(t, {
      loginPath: "/auth/login?next=/settings",
      beforeCallback: () => t.issuer.stop(),
    });
    expect(again.callback.statusCode).toBe(503);
    expect(again.sessionCookie).toBeUndefined();

    // The old session is still refused; nothing asks the issuer or lets it through.
    const res = await call("POST", "/app/api/tokens", cookie, { name: "while down" });
    expect(res.status, res.text).toBe(403);
    expect((res.json() as { error: string }).error).toBe("sign_in_required");
    expect(tokenStore.rows.size).toBe(0);
  });

  test("the sign-in it asks for comes back to Settings", async () => {
    t.issuer.user = { ...t.issuer.user, sub: "subject-return", groups: [TEST_GROUP] };
    const run = await runLogin(t, { loginPath: "/auth/login?next=/settings" });
    expect(run.callback.statusCode).toBe(302);
    expect(run.callback.headers.location).toBe(`${TEST_ORIGIN}/settings`);
  });

  test.each([
    ["another site", "https://evil.example/x"],
    ["a protocol-relative URL", "//evil.example/x"],
    ["a backslash", "/\\evil.example"],
    ["a dot segment", "/settings/../auth/logout"],
    ["an encoded character", "/settings%2F..%2F"],
    ["a query", "/settings?x=1"],
    ["no leading slash", "settings"],
  ])("a next of %s is ignored and the sign-in goes to the start page", async (_why, next) => {
    t.issuer.user = { ...t.issuer.user, sub: "subject-next", groups: [TEST_GROUP] };
    const run = await runLogin(t, { loginPath: `/auth/login?next=${encodeURIComponent(next)}` });
    expect(run.callback.statusCode).toBe(302);
    expect(run.callback.headers.location).toBe(`${TEST_ORIGIN}/`);
  });
});

describe("Sign out everywhere", () => {
  test("lists everyone with a live session or a token they made, by their latest name", async () => {
    const me = await signIn("subject-admin", "Synthetic Admin");
    const other = await signIn("subject-other", "Synthetic Other");
    await makeToken(other, "Other's script");
    const res = await call("GET", "/app/api/users", me);
    expect(res.status, res.text).toBe(200);
    const users = (res.json() as { users: unknown[] }).users;
    expect(users).toEqual(
      expect.arrayContaining([
        { subject: "subject-admin", name: "Synthetic Admin", sessions: 1, tokens: 0, you: true },
        { subject: "subject-other", name: "Synthetic Other", sessions: 1, tokens: 1, you: false },
      ]),
    );
    expect(users).toHaveLength(2);
  });

  test("ends every session of the chosen user and leaves everyone else's", async () => {
    const me = await signIn("subject-admin", "Synthetic Admin");
    const theirs1 = await signIn("subject-gone", "Synthetic Gone");
    const theirs2 = await signIn("subject-gone", "Synthetic Gone");
    const theirsMade = await makeToken(theirs1, "Their script");

    const res = await call("POST", "/app/api/users/sign-out", me, {
      subject: "subject-gone",
      revokeTokens: false,
    });
    expect(res.status, res.text).toBe(200);
    expect(res.json()).toEqual({ sessionsEnded: 2, tokensRevoked: 0 });

    for (const cookie of [theirs1, theirs2]) {
      expect((await call("GET", "/app/api/tokens", cookie)).status).toBe(401);
    }
    expect((await call("GET", "/app/api/tokens", me)).status).toBe(200);
    // Asked not to, it leaves their tokens working.
    expect(await v1Status(theirsMade.token)).toBe(200);
  });

  test("when asked, also revokes every token the user made, and only theirs", async () => {
    const me = await signIn("subject-admin", "Synthetic Admin");
    const mine = await makeToken(me, "My script");
    const theirs = await signIn("subject-gone", "Synthetic Gone");
    const laptop = await makeToken(theirs, "Their laptop");
    const desktop = await makeToken(theirs, "Their desktop");
    // A token from before creators were recorded is never revoked by this.
    const old = await tokens.createToken("Old script");

    const res = await call("POST", "/app/api/users/sign-out", me, {
      subject: "subject-gone",
      revokeTokens: true,
    });
    expect(res.status, res.text).toBe(200);
    expect(res.json()).toEqual({ sessionsEnded: 1, tokensRevoked: 2 });
    expect(await v1Status(laptop.token)).toBe(401);
    expect(await v1Status(desktop.token)).toBe(401);
    expect(await v1Status(mine.token)).toBe(200);
    expect(await v1Status(old.token)).toBe(200);
    expect((await call("GET", "/app/api/tokens", theirs)).status).toBe(401);
  });

  test("signing yourself out everywhere ends your own sessions too", async () => {
    const me = await signIn("subject-self", "Synthetic Self");
    const res = await call("POST", "/app/api/users/sign-out", me, {
      subject: "subject-self",
      revokeTokens: false,
    });
    expect(res.status, res.text).toBe(200);
    expect((await call("GET", "/app/api/users", me)).status).toBe(401);
  });

  test("a user whose subject is over 255 characters can be listed and signed out everywhere", async () => {
    // Sign-in takes a subject of any length, as 0.1.0 did, so the token and
    // the sign-out take one too: a user who can sign in can always be cut off.
    const long = `subject-long-${"x".repeat(300)}`;
    const me = await signIn("subject-admin", "Synthetic Admin");
    const theirs = await signIn(long, "Synthetic Long");
    const made = await makeToken(theirs, "Long script");
    expect(made.createdBy).toEqual({ subject: long, name: "Synthetic Long" });

    const list = await call("GET", "/app/api/users", me);
    expect((list.json() as { users: Array<{ subject: string }> }).users).toEqual(
      expect.arrayContaining([expect.objectContaining({ subject: long, sessions: 1, tokens: 1 })]),
    );

    const res = await call("POST", "/app/api/users/sign-out", me, {
      subject: long,
      revokeTokens: true,
    });
    expect(res.status, res.text).toBe(200);
    expect(res.json()).toEqual({ sessionsEnded: 1, tokensRevoked: 1 });
    expect((await call("GET", "/app/api/tokens", theirs)).status).toBe(401);
    expect(await v1Status(made.token)).toBe(401);
  });

  test("a user with nothing live is 200 with nothing ended", async () => {
    const me = await signIn("subject-admin");
    const res = await call("POST", "/app/api/users/sign-out", me, {
      subject: "nobody",
      revokeTokens: true,
    });
    expect(res.status, res.text).toBe(200);
    expect(res.json()).toEqual({ sessionsEnded: 0, tokensRevoked: 0 });
  });

  test.each([
    ["no subject", { revokeTokens: true }],
    ["an empty subject", { subject: "", revokeTokens: true }],
    ["no revokeTokens", { subject: "someone" }],
    ["a revokeTokens that is not a boolean", { subject: "someone", revokeTokens: "yes" }],
  ])("refuses a body with %s", async (_why, body) => {
    const me = await signIn("subject-admin");
    expect((await call("POST", "/app/api/users/sign-out", me, body)).status).toBe(400);
  });

  test("needs a session, and Origin to be the app's own", async () => {
    const me = await signIn("subject-admin");
    const noSession = await t.app.inject({
      method: "POST",
      url: "/app/api/users/sign-out",
      headers: { origin: TEST_ORIGIN, "content-type": "application/json" },
      payload: JSON.stringify({ subject: "subject-admin", revokeTokens: true }),
    });
    expect(noSession.statusCode).toBe(401);
    const crossSite = await t.app.inject({
      method: "POST",
      url: "/app/api/users/sign-out",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      cookies: { [SESSION_COOKIE]: me },
      payload: JSON.stringify({ subject: "subject-admin", revokeTokens: true }),
    });
    expect(crossSite.statusCode).toBe(403);
    expect((await call("GET", "/app/api/users", me)).status).toBe(200);
  });
});
