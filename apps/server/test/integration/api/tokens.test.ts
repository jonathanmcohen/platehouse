// Build plan Task 16, AC-083: each API client has its own token. A token is
// ph_ followed by 43 base64url characters (32 random bytes); only its SHA-256
// and its first 8 characters are stored, so it is shown once, by
// createToken, and never again. revokeToken ends one token and leaves the
// others working. The bearer header is read strictly: the scheme Bearer
// (any case), one space, the token, nothing else; anything else is no token.
//
// No container: tokens live in the memory store, which keeps the
// api_tokens table's rules (only live tokens are found). Every token here is
// made by the test run; none is written into this file.
import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  bearerToken,
  createTokens,
  DISPLAY_PREFIX_LENGTH,
  generateToken,
  hashToken,
  MAX_TOKEN_NAME_LENGTH,
  TOKEN_BODY_LENGTH,
  TOKEN_PATTERN,
  TOKEN_PREFIX,
  TOKEN_TOUCH_MS,
} from "../../../src/api/tokens.js";
import { memoryTokenStore, testClock } from "../support/oidc-issuer.js";

/** A well-formed token no store knows, built here rather than written out. */
function unknownToken(): string {
  return `${TOKEN_PREFIX}${"Q".repeat(TOKEN_BODY_LENGTH)}`;
}

describe("generateToken", () => {
  test("is ph_ and 43 base64url characters, different every time", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const token = generateToken();
      expect(token.startsWith("ph_")).toBe(true);
      expect(token).toHaveLength(3 + 43);
      expect(TOKEN_PATTERN.test(token)).toBe(true);
      expect(Buffer.from(token.slice(3), "base64url")).toHaveLength(32);
      seen.add(token);
    }
    expect(seen.size).toBe(200);
  });
});

describe("hashToken", () => {
  test("is the SHA-256 of the whole token", () => {
    const token = generateToken();
    const expected = createHash("sha256").update(token, "utf8").digest();
    expect(hashToken(token).equals(expected)).toBe(true);
    expect(hashToken(token)).toHaveLength(32);
  });
});

describe("bearerToken", () => {
  const token = generateToken();
  const cases: Array<[string, string | string[] | undefined, string | undefined]> = [
    ["the plain header", `Bearer ${token}`, token],
    ["a lowercase scheme", `bearer ${token}`, token],
    ["an uppercase scheme", `BEARER ${token}`, token],
    ["no header", undefined, undefined],
    ["an empty header", "", undefined],
    ["the scheme alone", "Bearer", undefined],
    ["the scheme and a space", "Bearer ", undefined],
    ["another scheme", `Basic ${token}`, undefined],
    ["no scheme", token, undefined],
    ["two spaces", `Bearer  ${token}`, undefined],
    ["a trailing space", `Bearer ${token} `, undefined],
    ["a tab", `Bearer\t${token}`, undefined],
    ["two tokens", `Bearer ${token} ${token}`, undefined],
    ["a repeated header", [`Bearer ${token}`, `Bearer ${token}`], undefined],
  ];
  test.each(cases)("%s", (_label, header, expected) => {
    expect(bearerToken(header)).toBe(expected);
  });
});

describe("createToken", () => {
  test("stores the SHA-256 and the first 8 characters, never the token", async () => {
    const store = memoryTokenStore();
    const tokens = createTokens({ store });
    const created = await tokens.createToken("Claude Code on mini01");
    expect(TOKEN_PATTERN.test(created.token)).toBe(true);
    const row = store.rows.get(created.id);
    expect(row).toBeDefined();
    expect(row?.name).toBe("Claude Code on mini01");
    expect(row?.prefix).toBe(created.token.slice(0, DISPLAY_PREFIX_LENGTH));
    expect(row?.prefix).toHaveLength(8);
    expect(row?.tokenHash.equals(createHash("sha256").update(created.token).digest())).toBe(true);
    const stored = JSON.stringify(row, (_key, value) =>
      Buffer.isBuffer(value) ? value.toString("hex") : value,
    );
    expect(stored).not.toContain(created.token);
    expect(stored).not.toContain(created.token.slice(TOKEN_PREFIX.length));
  });

  test("two tokens are different and both authenticate", async () => {
    const tokens = createTokens({ store: memoryTokenStore() });
    const a = await tokens.createToken("a");
    const b = await tokens.createToken("b");
    expect(a.token).not.toBe(b.token);
    expect((await tokens.authenticate(`Bearer ${a.token}`))?.id).toBe(a.id);
    expect((await tokens.authenticate(`Bearer ${b.token}`))?.id).toBe(b.id);
  });

  test("a name must be 1 to 100 characters after trimming", async () => {
    const tokens = createTokens({ store: memoryTokenStore() });
    for (const name of ["", "   ", "x".repeat(MAX_TOKEN_NAME_LENGTH + 1)]) {
      await expect(tokens.createToken(name), JSON.stringify(name)).rejects.toThrow(RangeError);
    }
    const ok = await tokens.createToken(`  ${"x".repeat(MAX_TOKEN_NAME_LENGTH)}  `);
    expect(ok.id).toBeDefined();
  });
});

describe("authenticate", () => {
  test("refuses anything that is not a live token's bearer header", async () => {
    const store = memoryTokenStore();
    const tokens = createTokens({ store });
    const live = await tokens.createToken("live");
    const revoked = await tokens.createToken("revoked");
    expect(await tokens.revokeToken(revoked.id)).toBe(true);
    const refused: Array<string | undefined> = [
      undefined,
      "",
      "Bearer",
      `Basic ${live.token}`,
      live.token,
      `Bearer ${unknownToken()}`,
      `Bearer ${revoked.token}`,
      `Bearer ${live.token.slice(0, -1)}`,
      `Bearer ${live.token}x`,
      `Bearer ${live.token.slice(TOKEN_PREFIX.length)}`,
      `Bearer ${live.token.replace("ph_", "PH_")}`,
      `Bearer ${live.token.slice(0, -1)}=`,
    ];
    for (const header of refused) {
      expect(await tokens.authenticate(header), String(header)).toBeUndefined();
    }
    expect((await tokens.authenticate(`Bearer ${live.token}`))?.id).toBe(live.id);
  });

  test("never looks up a header that is not token-shaped", async () => {
    const store = memoryTokenStore();
    const tokens = createTokens({ store });
    for (const header of ["Bearer nope", "Bearer ph_short", `Basic ${generateToken()}`]) {
      await tokens.authenticate(header);
    }
    expect(store.lookups).toBe(0);
  });

  test("revoking one token leaves the other working", async () => {
    const tokens = createTokens({ store: memoryTokenStore() });
    const keep = await tokens.createToken("keep");
    const drop = await tokens.createToken("drop");
    expect(await tokens.revokeToken(drop.id)).toBe(true);
    expect(await tokens.authenticate(`Bearer ${drop.token}`)).toBeUndefined();
    expect((await tokens.authenticate(`Bearer ${keep.token}`))?.id).toBe(keep.id);
    expect(await tokens.revokeToken(drop.id)).toBe(false);
    expect(await tokens.revokeToken("not-a-uuid")).toBe(false);
  });

  test("records last use, at most once per TOKEN_TOUCH_MS", async () => {
    const store = memoryTokenStore();
    const clock = testClock(new Date("2026-11-11T12:00:00Z"));
    const tokens = createTokens({ store, now: () => clock.now });
    const created = await tokens.createToken("touch");
    await tokens.authenticate(`Bearer ${created.token}`);
    expect(store.rows.get(created.id)?.lastUsedAt).toEqual(new Date("2026-11-11T12:00:00Z"));
    clock.advance(TOKEN_TOUCH_MS - 1);
    await tokens.authenticate(`Bearer ${created.token}`);
    expect(store.rows.get(created.id)?.lastUsedAt).toEqual(new Date("2026-11-11T12:00:00Z"));
    clock.advance(1);
    await tokens.authenticate(`Bearer ${created.token}`);
    expect(store.rows.get(created.id)?.lastUsedAt).toEqual(clock.now);
  });

  test("a failed last-use write does not refuse the request", async () => {
    const store = memoryTokenStore();
    const tokens = createTokens({ store });
    const created = await tokens.createToken("touch fails");
    store.touchLastUsed = async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.9:5432");
    };
    expect((await tokens.authenticate(`Bearer ${created.token}`))?.id).toBe(created.id);
  });
});
