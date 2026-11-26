// Token creation and Sign out everywhere wait for each other on the session
// row (issue #414). The routes, with fake stores: a create hands the session's
// row id, the name and the route's clock to createTokenForSession, which
// reads the session again under a lock in the same transaction as the insert
// and answers "stale" when the session is gone or no longer fresh; that
// answer is the same 403 sign_in_required as a stale session at the door.
// Sign out everywhere is one signOutEverywhere call, which ends the sessions
// and revokes the tokens in one transaction. What the two transactions do in
// Postgres, two connections racing, is in
// test/integration/auth/sessions-db.test.ts.
import fastifyCookie from "@fastify/cookie";
import Fastify from "fastify";
import { describe, expect, test } from "vitest";
import {
  type CreatedToken,
  createTokens,
  hashToken,
  TOKEN_PATTERN,
  type TokenStore,
} from "../../src/api/tokens.js";
import { type ListedToken, registerTokensApi } from "../../src/app-api/tokens.js";
import { registerUsersApi } from "../../src/app-api/users.js";
import {
  refuseStale,
  SIGN_IN_REQUIRED_MESSAGE,
  TOKEN_SIGN_IN_WINDOW_MS,
} from "../../src/auth/fresh.js";
import { installGate } from "../../src/auth/gate.js";
import {
  createSessions,
  SESSION_COOKIE,
  type SessionStore,
  type Sessions,
} from "../../src/auth/sessions.js";
import type { Session } from "../../src/db/types.js";

const ORIGIN = "https://platehouse.test";
const NOW = new Date("2026-11-23T12:00:00.000Z");
const COOKIE = "c".repeat(43);
const SESSION_ID = "R".repeat(43);
const TOKEN = `ph_${"t".repeat(43)}`;

const STALE_BODY = {
  error: "sign_in_required",
  message: SIGN_IN_REQUIRED_MESSAGE,
  code: "sign_in_required",
  signIn: "/auth/login?next=/settings",
};

/** The session behind COOKIE, signed in this many milliseconds before NOW. */
function session(agoMs: number): Session {
  return {
    id: SESSION_ID,
    subject: "subject-maker",
    displayName: "Synthetic Maker",
    createdAt: new Date(NOW.getTime() - agoMs),
    expiresAt: new Date(NOW.getTime() + 60 * 60_000),
    idleExpiresAt: new Date(NOW.getTime() + 60 * 60_000),
  };
}

interface Fakes {
  created: Array<[string, string, Date]>;
  signedOut: Array<[string, boolean, boolean]>;
  createAnswer: CreatedToken | "stale";
}

async function app(signedInAgoMs: number, fakes: Fakes) {
  const server = Fastify({ logger: false });
  const sessions: Sessions = {
    start: async () => {
      throw new Error("not used");
    },
    find: async (cookie) => (cookie === COOKIE ? session(signedInAgoMs) : undefined),
    end: async () => {},
    signOutEverywhere: async (subject, revokeTokens, revokeUnknown = false) => {
      fakes.signedOut.push([subject, revokeTokens, revokeUnknown]);
      return {
        sessionsEnded: 2,
        tokensRevoked: revokeTokens ? 3 : 0,
        unknownTokensRevoked: revokeUnknown ? 5 : 0,
      };
    },
  };
  await server.register(fastifyCookie);
  installGate(server, {
    sessions,
    publicOrigin: ORIGIN,
    absoluteUrl: (path) => `${ORIGIN}${path}`,
  });
  const listed: ListedToken = {
    id: "0198f0c4-6a1b-7c2d-8e3f-4a5b6c7d8e9f",
    name: "Laptop",
    prefix: TOKEN.slice(0, 8),
    createdAt: NOW,
    lastUsedAt: null,
    createdBySubject: "subject-maker",
    createdByName: "Synthetic Maker",
  };
  await registerTokensApi(server, {
    tokens: {
      createTokenForSession: async (sessionId, name, now) => {
        fakes.created.push([sessionId, name, now]);
        return fakes.createAnswer;
      },
      revokeToken: async () => true,
    },
    list: async () => [listed],
    now: () => NOW,
  });
  await registerUsersApi(server, {
    list: async () => [],
    unknownTokens: async () => 0,
    sessions,
    now: () => NOW,
  });
  await server.ready();
  return server;
}

function fakes(createAnswer: Fakes["createAnswer"] = "stale"): Fakes {
  return { created: [], signedOut: [], createAnswer };
}

async function post(server: Awaited<ReturnType<typeof app>>, url: string, body: unknown) {
  return server.inject({
    method: "POST",
    url,
    headers: { origin: ORIGIN, "content-type": "application/json" },
    cookies: { [SESSION_COOKIE]: COOKIE },
    payload: JSON.stringify(body),
  });
}

describe("POST /app/api/tokens makes the token through createTokenForSession (issue #414)", () => {
  test("hands it the session's row id, the name and the route's clock, and answers the token", async () => {
    const f = fakes({ id: "0198f0c4-6a1b-7c2d-8e3f-4a5b6c7d8e9f", token: TOKEN });
    const server = await app(0, f);
    const res = await post(server, "/app/api/tokens", { name: "Laptop" });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ name: "Laptop", token: TOKEN });
    expect(f.created).toEqual([[SESSION_ID, "Laptop", NOW]]);
    await server.close();
  });

  test("a session gone or no longer fresh under the lock answers 403 sign_in_required, no token", async () => {
    const f = fakes("stale");
    const server = await app(0, f);
    const res = await post(server, "/app/api/tokens", { name: "Laptop" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual(STALE_BODY);
    expect(res.body).not.toContain("ph_");
    expect(f.created).toHaveLength(1);
    await server.close();
  });

  test("a session already stale at the door is refused before the store is asked", async () => {
    const f = fakes({ id: "0198f0c4-6a1b-7c2d-8e3f-4a5b6c7d8e9f", token: TOKEN });
    const server = await app(TOKEN_SIGN_IN_WINDOW_MS + 1, f);
    const res = await post(server, "/app/api/tokens", { name: "Laptop" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual(STALE_BODY);
    expect(f.created).toEqual([]);
    await server.close();
  });

  test("the stale answer is refuseStale's", () => {
    // The route answers "stale" with refuseStale; this pins that body here too.
    const sent: { body?: unknown } = {};
    const reply = {
      code() {
        return this;
      },
      send(body: unknown) {
        sent.body = body;
        return this;
      },
    } as unknown as Parameters<typeof refuseStale>[0];
    refuseStale(reply);
    expect(sent.body).toEqual(STALE_BODY);
  });
});

describe("POST /app/api/users/sign-out is one signOutEverywhere call (issue #414)", () => {
  test("ends the sessions and revokes the tokens together, and answers both counts", async () => {
    const f = fakes();
    const server = await app(0, f);
    const res = await post(server, "/app/api/users/sign-out", {
      subject: "subject-other",
      revokeTokens: true,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ sessionsEnded: 2, tokensRevoked: 3, unknownTokensRevoked: 0 });
    expect(f.signedOut).toEqual([["subject-other", true, false]]);
    await server.close();
  });

  test("without revokeTokens it says so to signOutEverywhere, and revokes nothing", async () => {
    const f = fakes();
    const server = await app(0, f);
    const res = await post(server, "/app/api/users/sign-out", {
      subject: "subject-maker",
      revokeTokens: false,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ sessionsEnded: 2, tokensRevoked: 0, unknownTokensRevoked: 0 });
    expect(f.signedOut).toEqual([["subject-maker", false, false]]);
    await server.close();
  });

  test("revokeUnknownTokens: true is passed on, and its count answered", async () => {
    const f = fakes();
    const server = await app(0, f);
    const res = await post(server, "/app/api/users/sign-out", {
      subject: "subject-other",
      revokeTokens: false,
      revokeUnknownTokens: true,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ sessionsEnded: 2, tokensRevoked: 0, unknownTokensRevoked: 5 });
    expect(f.signedOut).toEqual([["subject-other", false, true]]);
    await server.close();
  });

  test("a revokeUnknownTokens that is not a boolean is 400", async () => {
    const f = fakes();
    const server = await app(0, f);
    const url = "/app/api/users/sign-out";
    const base = { subject: "subject-other", revokeTokens: false };
    expect((await post(server, url, { ...base, revokeUnknownTokens: "yes" })).statusCode).toBe(400);
    expect((await post(server, url, { ...base, revokeUnknownTokens: {} })).statusCode).toBe(400);
    expect(f.signedOut).toEqual([]);
    await server.close();
  });

  // Fastify's validator coerces types by default ("true" and 1 to true, [true]
  // to true); the two flags take a real boolean only.
  test.each([
    ['the string "true"', "true"],
    ["the number 1", 1],
    ["an array of true", [true]],
  ])("a revokeUnknownTokens of %s is 400, and nothing ends", async (_what, value) => {
    const f = fakes();
    const server = await app(0, f);
    const res = await post(server, "/app/api/users/sign-out", {
      subject: "subject-other",
      revokeTokens: false,
      revokeUnknownTokens: value,
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(f.signedOut).toEqual([]);
    await server.close();
  });

  test.each([
    ['the string "true"', "true"],
    ["the number 1", 1],
    ["an array of true", [true]],
  ])("a revokeTokens of %s is 400, and nothing ends", async (_what, value) => {
    const f = fakes();
    const server = await app(0, f);
    const res = await post(server, "/app/api/users/sign-out", {
      subject: "subject-other",
      revokeTokens: value,
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(f.signedOut).toEqual([]);
    await server.close();
  });

  test("a misspelt field does not turn the revoke on (Fastify strips fields the schema does not name)", async () => {
    const f = fakes();
    const server = await app(0, f);
    const res = await post(server, "/app/api/users/sign-out", {
      subject: "subject-other",
      revokeTokens: false,
      revokeUnknown: true,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(f.signedOut).toEqual([["subject-other", false, false]]);
    await server.close();
  });

  test("signing someone else out from a stale session ends nothing", async () => {
    const f = fakes();
    const server = await app(TOKEN_SIGN_IN_WINDOW_MS + 1, f);
    const res = await post(server, "/app/api/users/sign-out", {
      subject: "subject-other",
      revokeTokens: true,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual(STALE_BODY);
    expect(f.signedOut).toEqual([]);
    await server.close();
  });
});

describe("createTokenForSession (issue #414)", () => {
  /** A token store whose createForSession admits against this session row, as read under the lock. */
  function store(row: Session | undefined) {
    const made: Array<{ sessionId: string; name: string; prefix: string; tokenHash: Buffer }> = [];
    const fake: Pick<TokenStore, "createForSession"> = {
      async createForSession(sessionId, input, admit) {
        if (row === undefined || !admit(row)) return undefined;
        made.push({ sessionId, ...input });
        return { id: "0198f0c4-6a1b-7c2d-8e3f-4a5b6c7d8e9f" };
      },
    };
    return { made, store: fake as TokenStore };
  }

  test("a fresh session row gets a token, stored by hash under the session's id", async () => {
    const s = store(session(0));
    const created = await createTokens({ store: s.store }).createTokenForSession(
      SESSION_ID,
      "  Laptop ",
      NOW,
    );
    if (created === "stale") throw new Error("refused a fresh session");
    expect(TOKEN_PATTERN.test(created.token)).toBe(true);
    expect(s.made).toEqual([
      {
        sessionId: SESSION_ID,
        name: "Laptop",
        prefix: created.token.slice(0, 8),
        tokenHash: hashToken(created.token),
      },
    ]);
  });

  test("a row signed in exactly the window before now still gets one", async () => {
    const s = store(session(TOKEN_SIGN_IN_WINDOW_MS));
    expect(
      await createTokens({ store: s.store }).createTokenForSession(SESSION_ID, "Laptop", NOW),
    ).not.toBe("stale");
  });

  test("a row signed in longer ago than the window is stale, and nothing is made", async () => {
    const s = store(session(TOKEN_SIGN_IN_WINDOW_MS + 1));
    expect(
      await createTokens({ store: s.store }).createTokenForSession(SESSION_ID, "Laptop", NOW),
    ).toBe("stale");
    expect(s.made).toEqual([]);
  });

  test("a session row that is gone is stale", async () => {
    const s = store(undefined);
    expect(
      await createTokens({ store: s.store }).createTokenForSession(SESSION_ID, "Laptop", NOW),
    ).toBe("stale");
  });

  test("a name outside 1 to 100 characters is a RangeError before the store is asked", async () => {
    const s = store(session(0));
    const tokens = createTokens({ store: s.store });
    await expect(tokens.createTokenForSession(SESSION_ID, "   ", NOW)).rejects.toThrow(RangeError);
    await expect(tokens.createTokenForSession(SESSION_ID, "x".repeat(101), NOW)).rejects.toThrow(
      RangeError,
    );
    expect(s.made).toEqual([]);
  });
});

describe("Sessions.signOutEverywhere (issue #414)", () => {
  test("is the store's one call, with revokeTokens passed through", async () => {
    const calls: Array<[string, boolean, boolean]> = [];
    const fake: Pick<SessionStore, "signOutEverywhere"> = {
      async signOutEverywhere(subject, revokeTokens, revokeUnknown = false) {
        calls.push([subject, revokeTokens, revokeUnknown]);
        return {
          sessionsEnded: 1,
          tokensRevoked: revokeTokens ? 4 : 0,
          unknownTokensRevoked: revokeUnknown ? 6 : 0,
        };
      },
    };
    const sessions = createSessions({ store: fake as SessionStore });
    expect(await sessions.signOutEverywhere("subject-a", true)).toEqual({
      sessionsEnded: 1,
      tokensRevoked: 4,
      unknownTokensRevoked: 0,
    });
    expect(await sessions.signOutEverywhere("subject-a", false)).toEqual({
      sessionsEnded: 1,
      tokensRevoked: 0,
      unknownTokensRevoked: 0,
    });
    expect(await sessions.signOutEverywhere("subject-a", false, true)).toEqual({
      sessionsEnded: 1,
      tokensRevoked: 0,
      unknownTokensRevoked: 6,
    });
    expect(calls).toEqual([
      ["subject-a", true, false],
      ["subject-a", false, false],
      ["subject-a", false, true],
    ]);
  });
});
