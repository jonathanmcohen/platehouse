// Token creation and Sign out everywhere are limited per session (issue #424):
// each route allows one session 10 calls in any 10 minutes, then answers 429
// rate_limited with Retry-After in seconds, before any work. The routes, with
// fake stores, on a clock the test moves. The limiter itself is in
// test/auth/limit.test.ts.
//
// Order: a request is counted only once it has passed the route's own checks
// for a session and, where the act needs one, a fresh sign-in. A refused
// stale request answers 403 sign_in_required, never 429, and uses up nothing.
import fastifyCookie from "@fastify/cookie";
import Fastify from "fastify";
import { describe, expect, test } from "vitest";
import { registerTokensApi } from "../../src/app-api/tokens.js";
import { registerUsersApi } from "../../src/app-api/users.js";
import { TOKEN_SIGN_IN_WINDOW_MS } from "../../src/auth/fresh.js";
import { installGate } from "../../src/auth/gate.js";
import { SESSION_COOKIE, type Sessions } from "../../src/auth/sessions.js";
import type { Session } from "../../src/db/types.js";

const ORIGIN = "https://platehouse.test";
const START = new Date("2026-11-23T12:00:00.000Z");
const TOKEN = `ph_${"t".repeat(43)}`;
const TOKEN_ID = "0198f0c4-6a1b-7c2d-8e3f-4a5b6c7d8e9f";

/** Two signed-in browsers: cookie, session row id and subject. */
const A = { cookie: "a".repeat(43), id: "A".repeat(43), subject: "subject-a" };
const B = { cookie: "b".repeat(43), id: "B".repeat(43), subject: "subject-b" };

function row(who: typeof A): Session {
  return {
    id: who.id,
    subject: who.subject,
    displayName: null,
    createdAt: START,
    expiresAt: new Date(START.getTime() + 24 * 60 * 60_000),
    idleExpiresAt: new Date(START.getTime() + 24 * 60 * 60_000),
  };
}

async function app() {
  let now = START;
  const created: string[] = [];
  const signedOut: string[] = [];
  const server = Fastify({ logger: false });
  const sessions: Sessions = {
    start: async () => {
      throw new Error("not used");
    },
    find: async (cookie) =>
      cookie === A.cookie ? row(A) : cookie === B.cookie ? row(B) : undefined,
    end: async () => {},
    signOutEverywhere: async (subject) => {
      signedOut.push(subject);
      return { sessionsEnded: 1, tokensRevoked: 0 };
    },
  };
  await server.register(fastifyCookie);
  installGate(server, {
    sessions,
    publicOrigin: ORIGIN,
    absoluteUrl: (path) => `${ORIGIN}${path}`,
  });
  await registerTokensApi(server, {
    tokens: {
      createTokenForSession: async (sessionId) => {
        created.push(sessionId);
        return { id: TOKEN_ID, token: TOKEN };
      },
      revokeToken: async () => true,
    },
    list: async () => [
      {
        id: TOKEN_ID,
        name: "Laptop",
        prefix: TOKEN.slice(0, 8),
        createdAt: START,
        lastUsedAt: null,
        createdBySubject: A.subject,
        createdByName: null,
      },
    ],
    now: () => now,
  });
  await registerUsersApi(server, { list: async () => [], sessions, now: () => now });
  await server.ready();
  return {
    server,
    created,
    signedOut,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
    post(who: typeof A, url: string, body: unknown) {
      return server.inject({
        method: "POST",
        url,
        headers: { origin: ORIGIN, "content-type": "application/json" },
        cookies: { [SESSION_COOKIE]: who.cookie },
        payload: JSON.stringify(body),
      });
    },
  };
}

const RATE_LIMITED = { error: "rate_limited" };

describe("POST /app/api/tokens is limited per session (issue #424)", () => {
  test("the 11th creation from one session in 10 minutes answers 429 with Retry-After, and makes nothing", async () => {
    const t = await app();
    for (let i = 0; i < 10; i++) {
      const res = await t.post(A, "/app/api/tokens", { name: `Laptop ${i}` });
      expect(res.statusCode, `create ${i + 1}: ${res.body}`).toBe(201);
      t.advance(1000);
    }
    const res = await t.post(A, "/app/api/tokens", { name: "One too many" });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual(RATE_LIMITED);
    // The first creation was 10 s ago: it leaves the window in 590 s.
    expect(res.headers["retry-after"]).toBe("590");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(t.created).toHaveLength(10);
    await t.server.close();
  });

  test("another session is unaffected", async () => {
    const t = await app();
    for (let i = 0; i < 10; i++) await t.post(A, "/app/api/tokens", { name: `A ${i}` });
    expect((await t.post(A, "/app/api/tokens", { name: "A again" })).statusCode).toBe(429);
    for (let i = 0; i < 10; i++) {
      const res = await t.post(B, "/app/api/tokens", { name: `B ${i}` });
      expect(res.statusCode, `B create ${i + 1}: ${res.body}`).toBe(201);
    }
    expect(t.created.filter((id) => id === B.id)).toHaveLength(10);
    await t.server.close();
  });

  test("after 10 minutes the answer is the sign-in window's, not 429", async () => {
    const t = await app();
    for (let i = 0; i < 10; i++) await t.post(A, "/app/api/tokens", { name: `A ${i}` });
    expect((await t.post(A, "/app/api/tokens", { name: "A again" })).statusCode).toBe(429);
    t.advance(10 * 60 * 1000);
    // The session is past the 5-minute sign-in window by now, so a token
    // needs a fresh sign-in (a new session, with a count of its own).
    const res = await t.post(A, "/app/api/tokens", { name: "later" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "sign_in_required" });
    await t.server.close();
  });

  test("a stale session is refused 403 sign_in_required and never counted", async () => {
    const t = await app();
    t.advance(TOKEN_SIGN_IN_WINDOW_MS + 1);
    for (let i = 0; i < 15; i++) {
      const res = await t.post(A, "/app/api/tokens", { name: `stale ${i}` });
      expect(res.statusCode, `stale create ${i + 1}`).toBe(403);
      expect(res.json()).toMatchObject({ error: "sign_in_required" });
    }
    expect(t.created).toEqual([]);
    await t.server.close();
  });

  test("a body the schema refuses (400) is not counted", async () => {
    const t = await app();
    for (let i = 0; i < 15; i++) {
      expect((await t.post(A, "/app/api/tokens", { name: "" })).statusCode).toBe(400);
    }
    for (let i = 0; i < 10; i++) {
      expect((await t.post(A, "/app/api/tokens", { name: `ok ${i}` })).statusCode).toBe(201);
    }
    await t.server.close();
  });
});

describe("POST /app/api/users/sign-out is limited per session (issue #424)", () => {
  test("the 11th call from one session in 10 minutes answers 429 with Retry-After, and ends nothing", async () => {
    const t = await app();
    for (let i = 0; i < 10; i++) {
      const res = await t.post(A, "/app/api/users/sign-out", {
        subject: "subject-other",
        revokeTokens: false,
      });
      expect(res.statusCode, `sign-out ${i + 1}: ${res.body}`).toBe(200);
    }
    const res = await t.post(A, "/app/api/users/sign-out", {
      subject: "subject-other",
      revokeTokens: true,
    });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual(RATE_LIMITED);
    expect(res.headers["retry-after"]).toBe("600");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(t.signedOut).toHaveLength(10);
    await t.server.close();
  });

  test("another session is unaffected", async () => {
    const t = await app();
    const body = { subject: "subject-other", revokeTokens: false };
    for (let i = 0; i < 10; i++) await t.post(A, "/app/api/users/sign-out", body);
    expect((await t.post(A, "/app/api/users/sign-out", body)).statusCode).toBe(429);
    for (let i = 0; i < 10; i++) {
      const res = await t.post(B, "/app/api/users/sign-out", body);
      expect(res.statusCode, `B sign-out ${i + 1}: ${res.body}`).toBe(200);
    }
    await t.server.close();
  });

  test("signing yourself out counts too, and is let through again after 10 minutes", async () => {
    const t = await app();
    const self = { subject: A.subject, revokeTokens: false };
    for (let i = 0; i < 10; i++) {
      expect((await t.post(A, "/app/api/users/sign-out", self)).statusCode).toBe(200);
    }
    expect((await t.post(A, "/app/api/users/sign-out", self)).statusCode).toBe(429);
    t.advance(10 * 60 * 1000);
    // Signing yourself out needs no fresh sign-in, so this reaches the store.
    expect((await t.post(A, "/app/api/users/sign-out", self)).statusCode).toBe(200);
    expect(t.signedOut).toHaveLength(11);
    await t.server.close();
  });

  test("a stale session signing someone else out is refused 403 and never counted", async () => {
    const t = await app();
    t.advance(TOKEN_SIGN_IN_WINDOW_MS + 1);
    const other = { subject: "subject-other", revokeTokens: true };
    for (let i = 0; i < 15; i++) {
      expect((await t.post(A, "/app/api/users/sign-out", other)).statusCode).toBe(403);
    }
    // Its 10 calls for itself are all still there.
    const self = { subject: A.subject, revokeTokens: false };
    for (let i = 0; i < 10; i++) {
      expect((await t.post(A, "/app/api/users/sign-out", self)).statusCode).toBe(200);
    }
    expect(t.signedOut).toEqual(Array(10).fill(A.subject));
    await t.server.close();
  });

  test("the two routes count separately", async () => {
    const t = await app();
    for (let i = 0; i < 10; i++) await t.post(A, "/app/api/tokens", { name: `A ${i}` });
    expect((await t.post(A, "/app/api/tokens", { name: "A again" })).statusCode).toBe(429);
    const res = await t.post(A, "/app/api/users/sign-out", {
      subject: "subject-other",
      revokeTokens: false,
    });
    expect(res.statusCode).toBe(200);
    await t.server.close();
  });
});
