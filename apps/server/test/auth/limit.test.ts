// A per-key limit on how often an act may run in a window (issue #424): the
// routes key it by session id, so one session can make at most max token
// creations, or max Sign out everywhere calls, in windowMs. Its memory is
// bounded: past maxKeys keys, the least recently used is forgotten.
import type { FastifyReply } from "fastify";
import { describe, expect, test } from "vitest";
import {
  createSessionLimiter,
  refuseLimited,
  SESSION_LIMIT_MAX,
  SESSION_LIMIT_WINDOW_MS,
} from "../../src/auth/limit.js";

const WINDOW_MS = 10 * 60 * 1000;

/** A clock the test moves by hand, in milliseconds. */
function clock(start = 1_700_000_000_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("createSessionLimiter", () => {
  test("10 takes in a window pass and the 11th is refused with a Retry-After of at most the window", () => {
    const c = clock();
    const limiter = createSessionLimiter({ max: 10, windowMs: WINDOW_MS, now: c.now });
    for (let i = 0; i < 10; i++) {
      expect(limiter.take("session-a"), `take ${i + 1}`).toEqual({ ok: true });
      c.advance(1000);
    }
    const refused = limiter.take("session-a");
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("the 11th take passed");
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(600);
    // The first take was 10 s ago, so it leaves the window in 590 s.
    expect(refused.retryAfterSeconds).toBe(590);
  });

  test("a refused take is not counted, so waiting Retry-After is enough", () => {
    const c = clock();
    const limiter = createSessionLimiter({ max: 10, windowMs: WINDOW_MS, now: c.now });
    for (let i = 0; i < 10; i++) limiter.take("session-a");
    for (let i = 0; i < 5; i++) {
      c.advance(60_000);
      expect(limiter.take("session-a").ok).toBe(false);
    }
    const refused = limiter.take("session-a");
    if (refused.ok) throw new Error("passed inside the window");
    c.advance(refused.retryAfterSeconds * 1000);
    expect(limiter.take("session-a")).toEqual({ ok: true });
  });

  test("Retry-After is whole seconds, rounded up, and never 0", () => {
    const c = clock();
    const limiter = createSessionLimiter({ max: 1, windowMs: WINDOW_MS, now: c.now });
    limiter.take("session-a");
    c.advance(WINDOW_MS - 1);
    expect(limiter.take("session-a")).toEqual({ ok: false, retryAfterSeconds: 1 });
  });

  test("after the window it passes again", () => {
    const c = clock();
    const limiter = createSessionLimiter({ max: 10, windowMs: WINDOW_MS, now: c.now });
    for (let i = 0; i < 10; i++) limiter.take("session-a");
    expect(limiter.take("session-a").ok).toBe(false);
    c.advance(WINDOW_MS);
    expect(limiter.take("session-a")).toEqual({ ok: true });
  });

  test("the window slides: a take leaves the count windowMs after it was made", () => {
    const c = clock();
    const limiter = createSessionLimiter({ max: 2, windowMs: WINDOW_MS, now: c.now });
    limiter.take("session-a");
    c.advance(WINDOW_MS / 2);
    limiter.take("session-a");
    expect(limiter.take("session-a").ok).toBe(false);
    // The first take has left the window; the second has not.
    c.advance(WINDOW_MS / 2);
    expect(limiter.take("session-a")).toEqual({ ok: true });
    expect(limiter.take("session-a").ok).toBe(false);
  });

  test("two keys are independent", () => {
    const c = clock();
    const limiter = createSessionLimiter({ max: 10, windowMs: WINDOW_MS, now: c.now });
    for (let i = 0; i < 10; i++) limiter.take("session-a");
    expect(limiter.take("session-a").ok).toBe(false);
    for (let i = 0; i < 10; i++) {
      expect(limiter.take("session-b"), `take ${i + 1}`).toEqual({ ok: true });
    }
    expect(limiter.take("session-b").ok).toBe(false);
  });

  test("past maxKeys the oldest key is forgotten", () => {
    const c = clock();
    const limiter = createSessionLimiter({ max: 1, windowMs: WINDOW_MS, now: c.now, maxKeys: 2 });
    limiter.take("session-a");
    limiter.take("session-b");
    expect(limiter.take("session-a").ok).toBe(false);
    expect(limiter.take("session-b").ok).toBe(false);
    // A third key: the one used longest ago (a) is dropped, b is kept.
    limiter.take("session-c");
    expect(limiter.take("session-b").ok).toBe(false);
    expect(limiter.take("session-a")).toEqual({ ok: true });
  });

  test("maxKeys is 10,000 when left out", () => {
    const c = clock();
    const limiter = createSessionLimiter({ max: 1, windowMs: WINDOW_MS, now: c.now });
    limiter.take("first");
    for (let i = 0; i < 9_999; i++) limiter.take(`key-${i}`);
    // 10,000 keys: the first is still remembered.
    expect(limiter.take("first").ok).toBe(false);
    // One more pushes out the oldest, which is now key-0.
    limiter.take("one-more");
    expect(limiter.take("key-0")).toEqual({ ok: true });
    expect(limiter.take("first").ok).toBe(false);
  });

  test("uses the real clock when now is left out", () => {
    const limiter = createSessionLimiter({ max: 1, windowMs: WINDOW_MS });
    expect(limiter.take("session-a")).toEqual({ ok: true });
    const refused = limiter.take("session-a");
    expect(refused).toEqual({ ok: false, retryAfterSeconds: 600 });
  });
});

describe("the routes' limit", () => {
  test("is 10 calls per session in 10 minutes", () => {
    expect(SESSION_LIMIT_MAX).toBe(10);
    expect(SESSION_LIMIT_WINDOW_MS).toBe(10 * 60 * 1000);
  });

  test("refuseLimited answers 429 rate_limited with Retry-After in seconds", () => {
    const sent: { status?: number; headers: Record<string, string>; body?: unknown } = {
      headers: {},
    };
    const reply = {
      code(status: number) {
        sent.status = status;
        return this;
      },
      header(name: string, value: string) {
        sent.headers[name] = value;
        return this;
      },
      send(body: unknown) {
        sent.body = body;
        return this;
      },
    } as unknown as FastifyReply;
    refuseLimited(reply, 42);
    expect(sent).toEqual({
      status: 429,
      headers: { "retry-after": "42" },
      body: { error: "rate_limited" },
    });
  });
});
