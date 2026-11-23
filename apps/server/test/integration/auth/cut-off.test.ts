// Issue #322: cutting off a user removed from the sign-in group (OIDC_GROUP).
//
// - Each API token records who made it: the OIDC subject and the display
//   name the session had then. Settings lists it; a token made before this
//   was recorded lists its creator as unknown (createdBy null).
// - A new API token needs a fresh sign-in: a session signed in more than
//   TOKEN_SIGN_IN_WINDOW_MS ago is refused with 403 sign_in_required, and the
//   page sends the user through /auth/login?next=/settings. That sign-in
//   checks the group again, so a user who has left it gets no fresh session
//   and no new API access; the refusal also ends the session the browser
//   held, so the old cookie stops working at once (issue #395). Sessions
//   keep nothing from the issuer
//   (sessions.ts), so the check is a new sign-in, not a userinfo call; while
//   the issuer cannot be reached that sign-in fails, so nothing new is made.
// - Sign out everywhere (POST /app/api/users/sign-out) ends every session of
//   one user and, when asked, revokes every live token that user made.
//   Signing yourself out needs a live session; signing someone else out, or
//   revoking a token someone else made, needs a fresh sign-in as a new token
//   does (the last describe block).
//
// No container: sessions and tokens are in memory, against the mock issuer
// (sessions-db.test.ts and settings.test.ts run the same against Postgres).
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createTokens, TOKEN_PATTERN, type Tokens } from "../../../src/api/tokens.js";
import { refusingApi } from "../../../src/api/v1.js";
import { TOKEN_SIGN_IN_WINDOW_MS } from "../../../src/app-api/tokens.js";
import { SIGN_IN_REQUIRED_MESSAGE } from "../../../src/auth/fresh.js";
import { SESSION_COOKIE, sessionRowId } from "../../../src/auth/sessions.js";
import {
  type AuthTestApp,
  authTestApp,
  type MemoryTokenStore,
  memorySessionStore,
  memoryTokenList,
  memoryTokenStore,
  memoryUserList,
  runLogin,
  setCookie,
  TEST_GROUP,
  TEST_ORIGIN,
} from "../support/oidc-issuer.js";

const MINUTE = 60_000;

let t: AuthTestApp;
let tokenStore: MemoryTokenStore;
let tokens: Tokens;
/** Every line the app logged in the current test. */
let lines: string[] = [];

beforeEach(async () => {
  // Linked both ways: a token is made for a session in the session store,
  // and Sign out everywhere revokes from the token store.
  const sessionStore = memorySessionStore();
  tokenStore = memoryTokenStore(sessionStore);
  tokens = createTokens({ store: tokenStore, log: () => {} });
  lines = [];
  t = await authTestApp({
    store: sessionStore,
    logger: { write: (line: string) => lines.push(line) },
    api: { tokens, library: refusingApi.library },
    appApi: (auth) => ({
      tokens: { tokens, list: memoryTokenList(tokenStore) },
      users: {
        list: memoryUserList(auth.store, tokenStore),
        sessions: auth.sessions,
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
    // The refusal clears the cookie (Max-Age=0) rather than setting a new one.
    expect(again.sessionCookie).toBe("");

    // Issue #395: the refused sign-in ended the session the browser held, so
    // the old cookie no longer gets in at all.
    const res = await call("POST", "/app/api/tokens", cookie, { name: "after removal" });
    expect(res.status, res.text).toBe(401);
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

    // The sign-in it asks for, from the browser that holds the old session:
    // the issuer goes down before the code exchange, so the callback is 503
    // and no fresh session is made.
    const again = await runLogin(t, {
      loginPath: "/auth/login?next=/settings",
      headers: { cookie: `${SESSION_COOKIE}=${cookie}` },
      beforeCallback: () => t.issuer.stop(),
    });
    expect(again.callback.statusCode).toBe(503);
    expect(again.sessionCookie).toBeUndefined();

    // An outage says nothing about the user, so the old session lives on
    // (issue #395); it is still refused a new token, and nothing asks the
    // issuer or lets it through.
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

// Issue #395: a sign-in the issuer refuses because the person is no longer
// let in ends the session the browser presented, and clears its cookie, the
// way a sign-in that succeeds replaces it. Only that one session ends; the
// person's other sessions are for Sign out everywhere. An issuer outage or a
// callback that does not check out says nothing about the person, so it
// ends nothing.
describe("a refused sign-in ends the session the browser holds", () => {
  const tooLong = `subject-too-long-${"z".repeat(239)}`;

  /** What the issuer says on the refused sign-in, by the reason it is refused for. */
  const refusals: [reason: string, change: Partial<typeof t.issuer.user>][] = [
    ["not_in_group", { groups: ["other"] }],
    ["email_not_verified", { email_verified: false }],
    ["subject_too_long", { sub: tooLong }],
  ];

  /** Signs in again from a browser holding this session cookie, as the issuer now describes the user. */
  async function signInAgain(cookie: string, change: Partial<typeof t.issuer.user>) {
    t.issuer.user = { ...t.issuer.user, ...change };
    return runLogin(t, { headers: { cookie: `${SESSION_COOKIE}=${cookie}` } });
  }

  test.each(refusals)(
    "refused for %s, the old cookie is cleared and no longer gets in",
    async (reason, change) => {
      const stale = await signIn("subject-stale", "Synthetic Stale");
      ageSession(stale, TOKEN_SIGN_IN_WINDOW_MS + MINUTE);
      expect((await call("GET", "/app/api/tokens", stale)).status).toBe(200);

      const again = await signInAgain(stale, change);
      expect(again.callback.statusCode, again.callback.body).toBe(403);
      const refused = lines.find((line) => line.includes("auth: login refused"));
      expect(refused).toContain(`"failure":"${reason}"`);

      // The cookie is cleared with the attributes it was set with.
      const cleared = setCookie(again.callback, SESSION_COOKIE);
      expect(cleared?.value).toBe("");
      expect(cleared?.attributes.get("max-age")).toBe("0");
      expect(cleared?.attributes.get("path")).toBe("/");
      expect(cleared?.attributes.get("secure")).toBe(true);
      expect(cleared?.attributes.get("httponly")).toBe(true);
      expect(cleared?.attributes.get("samesite")).toBe("Lax");

      // The session row is gone, so the old cookie is 401 everywhere.
      expect(t.store.rows.has(sessionRowId(stale))).toBe(false);
      expect((await call("GET", "/app/api/tokens", stale)).status).toBe(401);
    },
  );

  test("only the session the browser presented ends, not the person's other sessions", async () => {
    const here = await signIn("subject-two-browsers");
    const elsewhere = await signIn("subject-two-browsers");
    const someoneElse = await signIn("subject-bystander");

    const again = await signInAgain(here, { groups: ["other"] });
    expect(again.callback.statusCode).toBe(403);

    expect((await call("GET", "/app/api/tokens", here)).status).toBe(401);
    expect((await call("GET", "/app/api/tokens", elsewhere)).status).toBe(200);
    expect((await call("GET", "/app/api/tokens", someoneElse)).status).toBe(200);
  });

  test("an issuer outage ends nothing: the session lives on and its cookie stays", async () => {
    const stale = await signIn("subject-outage");
    t.issuer.user = { ...t.issuer.user, groups: ["other"] };
    const again = await runLogin(t, {
      headers: { cookie: `${SESSION_COOKIE}=${stale}` },
      beforeCallback: () => t.issuer.stop(),
    });
    expect(again.callback.statusCode).toBe(503);
    expect(setCookie(again.callback, SESSION_COOKIE)).toBeUndefined();
    expect((await call("GET", "/app/api/tokens", stale)).status).toBe(200);
  });

  test("a callback that does not check out ends nothing: the session lives on and its cookie stays", async () => {
    const stale = await signIn("subject-forged-callback");
    const again = await signInAgain(stale, { forge: { nonce: "not-the-login-nonce" } });
    expect(again.callback.statusCode).toBe(400);
    expect(setCookie(again.callback, SESSION_COOKIE)).toBeUndefined();
    expect((await call("GET", "/app/api/tokens", stale)).status).toBe(200);
  });

  test("with no session cookie the refusal is the same page, and nobody's session ends", async () => {
    const bystander = await signIn("subject-bystander");
    t.issuer.user = { ...t.issuer.user, sub: "subject-no-cookie", groups: ["other"] };
    const run = await runLogin(t);
    expect(run.callback.statusCode).toBe(403);
    expect(run.callback.body).toContain("Your account is not allowed to use this Platehouse.");
    expect(run.callback.body).not.toContain(TEST_GROUP);
    expect(setCookie(run.callback, SESSION_COOKIE)).toBeUndefined();
    expect(t.store.rows.size).toBe(1);
    expect((await call("GET", "/app/api/tokens", bystander)).status).toBe(200);
  });

  test.each([
    ["a well-formed cookie with no session behind it", "A".repeat(43)],
    ["a malformed cookie", "not-a-session"],
  ])("with %s the refusal clears it and nobody's session ends", async (_why, unknown) => {
    const bystander = await signIn("subject-bystander");
    const again = await signInAgain(unknown, { sub: "subject-unknown-cookie", groups: ["other"] });
    expect(again.callback.statusCode).toBe(403);
    expect(setCookie(again.callback, SESSION_COOKIE)?.attributes.get("max-age")).toBe("0");
    expect(t.store.rows.size).toBe(1);
    expect((await call("GET", "/app/api/tokens", bystander)).status).toBe(200);
  });

  test("when the session cannot be ended the refusal still shows, the cookie is still cleared, and the failure is logged", async () => {
    const stale = await signIn("subject-db-down");
    t.store.failWith = new Error("the database is down");
    const again = await signInAgain(stale, { groups: ["other"] });
    expect(again.callback.statusCode).toBe(403);
    expect(again.callback.body).toContain("Your account is not allowed to use this Platehouse.");
    expect(again.callback.body).not.toContain(TEST_GROUP);
    expect(setCookie(again.callback, SESSION_COOKIE)?.attributes.get("max-age")).toBe("0");
    expect(
      lines.some((line) => line.includes("auth: could not end the refused user's session")),
    ).toBe(true);
    expect(lines.join("\n")).not.toContain(stale);
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

  // Issue #378: a subject is at most 255 characters (MAX_SUBJECT_LENGTH, as
  // OpenID Connect Core allows). Every subject sign-in lets in fits every
  // column and index that stores one, so a user who can sign in can always
  // make a token and always be cut off.
  test("a user whose subject is 255 characters signs in, makes a token, and can be signed out everywhere", async () => {
    const long = `subject-long-${"x".repeat(242)}`;
    expect(long).toHaveLength(255);
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

  test("a subject over 255 characters is refused at sign-in, before any session row is written", async () => {
    const tooLong = `subject-too-long-${"y".repeat(239)}`;
    expect(tooLong).toHaveLength(256);
    t.issuer.user = { ...t.issuer.user, sub: tooLong, groups: [TEST_GROUP] };
    const run = await runLogin(t);
    expect(run.callback.statusCode).toBe(403);
    expect(run.callback.body).toContain("255");
    expect(run.callback.body).not.toContain(tooLong);
    expect(run.sessionCookie).toBeUndefined();
    expect(t.store.rows.size).toBe(0);
    // The log names the reason and the length, never the subject.
    const refused = lines.find((line) => line.includes("auth: login refused"));
    expect(refused).toBeDefined();
    expect(refused).toContain('"failure":"subject_too_long"');
    expect(refused).toContain('"subjectLength":256');
    expect(lines.join("\n")).not.toContain(tooLong);
  });

  test("the sign-out takes a subject of 255 characters outside ASCII, as sign-in does", async () => {
    // Its maxLength counts characters, as admit() does, not UTF-16 units.
    const me = await signIn("subject-admin");
    const res = await call("POST", "/app/api/users/sign-out", me, {
      subject: String.fromCodePoint(0x1f600).repeat(255),
      revokeTokens: true,
    });
    expect(res.status, res.text).toBe(200);
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
    // Nobody with a longer subject can sign in (MAX_SUBJECT_LENGTH).
    ["a subject over 255 characters", { subject: "x".repeat(256), revokeTokens: true }],
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

// Acts on other people need a fresh sign-in too: a session kept by someone
// since removed from the group must not be able to sign everyone else out, or
// revoke what they made. Acts on your own sessions and tokens need only a
// live session.
describe("acts on other people need a fresh sign-in", () => {
  const REFUSED = {
    error: "sign_in_required",
    message: SIGN_IN_REQUIRED_MESSAGE,
    code: "sign_in_required",
    signIn: "/auth/login?next=/settings",
  };

  test("an older session cannot sign another user out, and nothing ends", async () => {
    const me = await signIn("subject-old");
    const theirs = await signIn("subject-victim");
    const made = await makeToken(theirs, "Their script");
    ageSession(me, TOKEN_SIGN_IN_WINDOW_MS + MINUTE);

    const res = await call("POST", "/app/api/users/sign-out", me, {
      subject: "subject-victim",
      revokeTokens: true,
    });
    expect(res.status, res.text).toBe(403);
    expect(res.json()).toEqual(REFUSED);
    expect((await call("GET", "/app/api/tokens", theirs)).status).toBe(200);
    expect(await v1Status(made.token)).toBe(200);
  });

  test("an older session can still sign itself out everywhere", async () => {
    const me = await signIn("subject-old");
    ageSession(me, TOKEN_SIGN_IN_WINDOW_MS + MINUTE);
    const res = await call("POST", "/app/api/users/sign-out", me, {
      subject: "subject-old",
      revokeTokens: false,
    });
    expect(res.status, res.text).toBe(200);
    expect(res.json()).toEqual({ sessionsEnded: 1, tokensRevoked: 0 });
  });

  test("an older session cannot revoke a token another user made, and nothing is revoked", async () => {
    const me = await signIn("subject-old");
    const theirs = await signIn("subject-maker");
    const made = await makeToken(theirs, "Their script");
    ageSession(me, TOKEN_SIGN_IN_WINDOW_MS + MINUTE);

    const res = await call("DELETE", `/app/api/tokens/${made.id}`, me);
    expect(res.status, res.text).toBe(403);
    expect(res.json()).toEqual(REFUSED);
    expect(await v1Status(made.token)).toBe(200);
  });

  test("an older session cannot revoke a token with no recorded maker", async () => {
    const me = await signIn("subject-old");
    const old = await tokens.createToken("Old script");
    ageSession(me, TOKEN_SIGN_IN_WINDOW_MS + MINUTE);
    const row = [...tokenStore.rows.values()].find((r) => r.name === "Old script");
    const res = await call("DELETE", `/app/api/tokens/${row?.id}`, me);
    expect(res.status, res.text).toBe(403);
    expect(res.json()).toEqual(REFUSED);
    expect(await v1Status(old.token)).toBe(200);
  });

  test("a fresh session can revoke a token with no recorded maker", async () => {
    const me = await signIn("subject-fresh");
    const old = await tokens.createToken("Old script");
    const row = [...tokenStore.rows.values()].find((r) => r.name === "Old script");
    const res = await call("DELETE", `/app/api/tokens/${row?.id}`, me);
    expect(res.status, res.text).toBe(204);
    expect(await v1Status(old.token)).toBe(401);
  });

  test("an older session can sign itself out with revokeTokens, revoking its own tokens", async () => {
    const me = await signIn("subject-old");
    const mine = await makeToken(me, "My script");
    ageSession(me, TOKEN_SIGN_IN_WINDOW_MS + MINUTE);
    const res = await call("POST", "/app/api/users/sign-out", me, {
      subject: "subject-old",
      revokeTokens: true,
    });
    expect(res.status, res.text).toBe(200);
    expect(res.json()).toEqual({ sessionsEnded: 1, tokensRevoked: 1 });
    expect(await v1Status(mine.token)).toBe(401);
  });

  test("an older session can revoke a token it made itself", async () => {
    const me = await signIn("subject-old");
    const made = await makeToken(me, "My script");
    ageSession(me, TOKEN_SIGN_IN_WINDOW_MS + MINUTE);
    const res = await call("DELETE", `/app/api/tokens/${made.id}`, me);
    expect(res.status, res.text).toBe(204);
    expect(await v1Status(made.token)).toBe(401);
  });

  test("a fresh session can sign another user out and revoke their token", async () => {
    const me = await signIn("subject-fresh");
    const theirs = await signIn("subject-other");
    const made = await makeToken(theirs, "Their script");
    const second = await makeToken(theirs, "Their second script");

    const revoke = await call("DELETE", `/app/api/tokens/${made.id}`, me);
    expect(revoke.status, revoke.text).toBe(204);
    expect(await v1Status(made.token)).toBe(401);

    const out = await call("POST", "/app/api/users/sign-out", me, {
      subject: "subject-other",
      revokeTokens: true,
    });
    expect(out.status, out.text).toBe(200);
    expect(out.json()).toEqual({ sessionsEnded: 1, tokensRevoked: 1 });
    expect(await v1Status(second.token)).toBe(401);
  });

  test("a revoke of an unknown token by an older session is 404, as for a fresh one", async () => {
    const me = await signIn("subject-old");
    ageSession(me, TOKEN_SIGN_IN_WINDOW_MS + MINUTE);
    expect((await call("DELETE", "/app/api/tokens/no-such-token", me)).status).toBe(404);
  });
});
