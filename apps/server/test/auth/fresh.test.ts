// A session is fresh when its sign-in is at most TOKEN_SIGN_IN_WINDOW_MS old
// (5 minutes): the rule for acts on other people, which a session kept by
// someone since removed from the group must not be able to do.
import type { FastifyReply } from "fastify";
import { describe, expect, test } from "vitest";
import {
  isFresh,
  refuseStale,
  TOKEN_SIGN_IN_URL,
  TOKEN_SIGN_IN_WINDOW_MS,
} from "../../src/auth/fresh.js";
import type { Session } from "../../src/db/types.js";

const NOW = new Date("2026-11-23T12:00:00.000Z");

/** A session whose sign-in was this many milliseconds before NOW. */
function signedIn(agoMs: number): Session {
  return {
    createdAt: new Date(NOW.getTime() - agoMs),
    subject: "subject-fresh",
    displayName: null,
  } as unknown as Session;
}

describe("isFresh", () => {
  test("the window is 5 minutes", () => {
    expect(TOKEN_SIGN_IN_WINDOW_MS).toBe(5 * 60 * 1000);
  });

  test("a session signed in just now is fresh", () => {
    expect(isFresh(signedIn(0), NOW)).toBe(true);
  });

  test("a session signed in exactly 5 minutes ago is fresh", () => {
    expect(isFresh(signedIn(5 * 60 * 1000), NOW)).toBe(true);
  });

  test("a session signed in 5 minutes and 1 ms ago is not fresh", () => {
    expect(isFresh(signedIn(5 * 60 * 1000 + 1), NOW)).toBe(false);
  });

  test("no session is not fresh", () => {
    expect(isFresh(undefined, NOW)).toBe(false);
  });
});

describe("refuseStale", () => {
  test("sends 403 sign_in_required with the login URL that comes back to Settings", () => {
    const sent: { status?: number; body?: unknown } = {};
    const reply = {
      code(status: number) {
        sent.status = status;
        return this;
      },
      send(body: unknown) {
        sent.body = body;
        return this;
      },
    } as unknown as FastifyReply;
    refuseStale(reply);
    expect(sent.status).toBe(403);
    expect(sent.body).toEqual({
      error: "sign_in_required",
      code: "sign_in_required",
      signIn: "/auth/login?next=/settings",
    });
    expect(TOKEN_SIGN_IN_URL).toBe("/auth/login?next=/settings");
  });
});
