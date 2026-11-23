// A per-session limit on acts that do real work for one request (issue #424):
// making an API token and Sign out everywhere. The routes key it by the
// session's row id and make one limiter each, so a session can make at most
// max tokens, and call Sign out everywhere at most max times, in any windowMs.
//
// - The window slides: each key keeps the times of its passed takes in the
//   window, at most max of them, and a take passes while fewer than max are
//   newer than windowMs. A refused take is not recorded, so waiting the
//   retryAfterSeconds it answers is always enough.
// - Memory is bounded: at most maxKeys keys (default 10,000), each at most max
//   numbers. A take, passed or refused, makes its key the newest; past
//   maxKeys the key used longest ago is forgotten, so a key that keeps being
//   refused stays remembered.
// - The counts live in this process. Platehouse runs one server process, so
//   that is the whole count; a restart forgets them. Limits per client address
//   on the sign-in pages belong at the reverse proxy (docs/security.md).
import type { FastifyReply } from "fastify";

/** What a take answers: go ahead, or wait this many whole seconds (at least 1). */
export type LimitAnswer = { ok: true } | { ok: false; retryAfterSeconds: number };

export interface SessionLimiter {
  /** Counts one act for key when it is allowed now. */
  take(key: string): LimitAnswer;
}

/** The most keys a limiter remembers when maxKeys is left out. */
export const DEFAULT_MAX_KEYS = 10_000;

/** How many token creations, and Sign out everywhere calls, one session may make in SESSION_LIMIT_WINDOW_MS. */
export const SESSION_LIMIT_MAX = 10;

/** The window SESSION_LIMIT_MAX is counted in: 10 minutes. */
export const SESSION_LIMIT_WINDOW_MS = 10 * 60 * 1000;

/** The refusal of a call over the limit: 429 rate_limited, with Retry-After in seconds. */
export function refuseLimited(reply: FastifyReply, retryAfterSeconds: number): FastifyReply {
  return reply
    .code(429)
    .header("retry-after", String(retryAfterSeconds))
    .send({ error: "rate_limited" });
}

/** A sliding-window limiter of max takes per key in windowMs. */
export function createSessionLimiter(opts: {
  max: number;
  windowMs: number;
  now?: () => number;
  maxKeys?: number;
}): SessionLimiter {
  const { max, windowMs } = opts;
  const now = opts.now ?? Date.now;
  const maxKeys = opts.maxKeys ?? DEFAULT_MAX_KEYS;
  // Map keeps insertion order: re-inserting a key on each take makes the
  // first key the one used longest ago.
  const takes = new Map<string, number[]>();

  return {
    take(key) {
      const at = now();
      const inWindow = (takes.get(key) ?? []).filter((t) => at - t < windowMs);
      takes.delete(key);
      let answer: LimitAnswer;
      if (inWindow.length < max) {
        inWindow.push(at);
        answer = { ok: true };
      } else {
        // The oldest take in the window is the next to leave it.
        const oldest = inWindow[0] as number;
        answer = {
          ok: false,
          retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - at) / 1000)),
        };
      }
      takes.set(key, inWindow);
      while (takes.size > maxKeys) {
        const first = takes.keys().next();
        if (first.done) break;
        takes.delete(first.value);
      }
      return answer;
    },
  };
}
