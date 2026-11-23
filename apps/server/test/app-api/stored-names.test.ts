// Names recorded before sign-in cleaned them (0.1.1 release candidates) are
// cleaned again when the users list and the tokens list answer, so every
// client gets a name without direction controls.
import fastifyCookie from "@fastify/cookie";
import Fastify from "fastify";
import { describe, expect, test } from "vitest";
import { registerTokensApi } from "../../src/app-api/tokens.js";
import { registerUsersApi } from "../../src/app-api/users.js";
import { installGate } from "../../src/auth/gate.js";
import { SESSION_COOKIE, type Sessions } from "../../src/auth/sessions.js";

const ORIGIN = "https://platehouse.test";
const START = new Date("2026-11-23T12:00:00.000Z");
const COOKIE = "a".repeat(43);
const OVERRIDDEN = "Synthetic \u202eOverride\u2066 Person";
const CLEANED = "Synthetic Override Person";

async function server() {
  const app = Fastify({ logger: false });
  const sessions: Sessions = {
    start: async () => {
      throw new Error("not used");
    },
    find: async (cookie) =>
      cookie === COOKIE
        ? {
            id: "A".repeat(43),
            subject: "subject-a",
            displayName: null,
            createdAt: START,
            expiresAt: new Date(START.getTime() + 86_400_000),
            idleExpiresAt: new Date(START.getTime() + 86_400_000),
          }
        : undefined,
    end: async () => {},
    signOutEverywhere: async () => ({ sessionsEnded: 0, tokensRevoked: 0 }),
  };
  await app.register(fastifyCookie);
  installGate(app, {
    sessions,
    publicOrigin: ORIGIN,
    absoluteUrl: (path) => `${ORIGIN}${path}`,
  });
  await registerTokensApi(app, {
    tokens: {
      createTokenForSession: async () => {
        throw new Error("not used");
      },
      revokeToken: async () => true,
    },
    list: async () => [
      {
        id: "0198f0c4-6a1b-7c2d-8e3f-4a5b6c7d8e9f",
        name: "Laptop",
        prefix: "ph_abcde",
        createdAt: START,
        lastUsedAt: null,
        createdBySubject: "subject-b",
        createdByName: OVERRIDDEN,
      },
      {
        id: "0198f0c4-6a1b-7c2d-8e3f-4a5b6c7d8e90",
        name: "Other",
        prefix: "ph_fghij",
        createdAt: START,
        lastUsedAt: null,
        createdBySubject: "subject-c",
        createdByName: "\u202e\u200f",
      },
    ],
    now: () => START,
  });
  await registerUsersApi(app, {
    list: async () => [
      { subject: "subject-b", name: OVERRIDDEN, sessions: 1, tokens: 1 },
      { subject: "subject-c", name: "\u202e\u200f", sessions: 1, tokens: 0 },
    ],
    sessions,
    now: () => START,
  });
  await app.ready();
  return app;
}

describe("names stored before they were cleaned", () => {
  test("the users list returns a name without direction controls", async () => {
    const app = await server();
    const res = await app.inject({
      method: "GET",
      url: "/app/api/users",
      cookies: { [SESSION_COOKIE]: COOKIE },
    });
    const users = res.json().users as Array<{ subject: string; name: string | null }>;
    expect(users.find((u) => u.subject === "subject-b")?.name).toBe(CLEANED);
    expect(users.find((u) => u.subject === "subject-c")?.name).toBeNull();
    await app.close();
  });

  test("the tokens list returns the maker's name without direction controls", async () => {
    const app = await server();
    const res = await app.inject({
      method: "GET",
      url: "/app/api/tokens",
      cookies: { [SESSION_COOKIE]: COOKIE },
    });
    const tokens = res.json().tokens as Array<{
      createdBy: { subject: string; name: string | null };
    }>;
    expect(tokens[0]?.createdBy).toEqual({ subject: "subject-b", name: CLEANED });
    expect(tokens[1]?.createdBy).toEqual({ subject: "subject-c", name: null });
    await app.close();
  });
});
