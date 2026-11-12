// API tokens and the bearer check (build plan Task 16; AC-081, AC-083,
// AC-085). Each API client, such as Claude Code on one Mac, has its own
// token, made by createToken and ended by revokeToken (Task 21's settings
// page calls both; nothing in this task makes a token from the UI).
//
// - A token is ph_ followed by 43 base64url characters: 32 random bytes from
//   the system's CSPRNG. createToken hands it back once and stores only its
//   SHA-256 (of the whole token, prefix included) and its first 8
//   characters, so the list can tell tokens apart; the token itself is never
//   stored, logged or shown again.
// - authenticate reads the Authorization header strictly: the scheme Bearer
//   (any case), one space, then the token, with nothing before or after it.
//   A header that is not token-shaped is refused without a lookup. A
//   token-shaped one is looked up by its SHA-256, so the database compares
//   hashes and never the token: the time the index lookup takes depends on
//   the hash of what was presented, which the presenter cannot steer towards
//   a stored hash, so it leaks nothing about any stored token. The hash of
//   the row found is then compared again with timingSafeEqual, so even a
//   store whose own comparison is not exact cannot let a different token
//   through. Only live tokens are found: a revoked one never is.
// - Each request a token lets in records its last use (api_tokens.
//   last_used_at), written at most once per TOKEN_TOUCH_MS so a chunked
//   upload is not a write per chunk. A failed write is logged and never
//   refuses the request.
// - createBearerHook is the onRequest hook of every /api/v1 route, the tus
//   upload routes included. It never reads a cookie, so a session cookie or
//   a token sent as a cookie never authenticates, and it never redirects to
//   login: a request without a live token gets 401 JSON with
//   WWW-Authenticate: Bearer. The gate (auth/gate.ts) lets bearer-class
//   requests through without the session or Origin checks, and its onSend
//   hook releases any body a refusal leaves unread. A store that fails
//   (the database down) answers 503 with no detail.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import type { ApiToken, DB } from "../db/types.js";
import { type NewToken, tokensRepo } from "../repos/tokens.js";
import type { AuthHook } from "../uploads/tus.js";

/** Every token starts with these letters. */
export const TOKEN_PREFIX = "ph_";

/** The characters after the prefix: 32 random bytes in unpadded base64url. */
export const TOKEN_BODY_LENGTH = 43;

/** How many leading characters of a token are kept for display. */
export const DISPLAY_PREFIX_LENGTH = 8;

/** A token's shape: ph_ and 43 base64url characters. */
export const TOKEN_PATTERN = /^ph_[A-Za-z0-9_-]{43}$/;

/** How stale a token's last_used_at may get before a request writes it again. */
export const TOKEN_TOUCH_MS = 60_000;

/** The longest token name, in characters. */
export const MAX_TOKEN_NAME_LENGTH = 100;

/** The random bytes behind a token's 43 characters. */
const TOKEN_BYTES = 32;

/** The bearer header: the scheme, one space, then a run with no white space. */
const BEARER_HEADER = /^Bearer ([^\s]+)$/i;

/**
 * Where tokens are kept: the api_tokens table in production (dbTokenStore).
 * Every lookup is by hash; the store never sees a token.
 */
export interface TokenStore {
  create(input: NewToken): Promise<{ id: string }>;
  /** The live token with this hash; a revoked one is never found. */
  findByHash(hash: Buffer): Promise<ApiToken | undefined>;
  /** False when the token is unknown or already revoked. */
  revoke(id: string): Promise<boolean>;
  touchLastUsed(id: string, at: Date): Promise<void>;
}

/** What createToken hands back once: the row id and the token itself. */
export interface CreatedToken {
  id: string;
  token: string;
}

export interface Tokens {
  /** A new token for one client; RangeError for a name outside 1 to 100 characters. */
  createToken(name: string): Promise<CreatedToken>;
  /** Ends one token; false when it is unknown or already revoked. */
  revokeToken(id: string): Promise<boolean>;
  /** The live token an Authorization header carries, or undefined. */
  authenticate(authorization: string | string[] | undefined): Promise<ApiToken | undefined>;
}

/** A new token: ph_ and 32 random bytes in unpadded base64url. */
export function generateToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString("base64url")}`;
}

/** What api_tokens.token_hash holds for a token: the SHA-256 of the whole token. */
export function hashToken(presented: string): Buffer {
  return createHash("sha256").update(presented, "utf8").digest();
}

/**
 * The credential in an Authorization header of the form "Bearer <token>",
 * the scheme in any case; undefined for anything else, a repeated header
 * included. The credential is not checked here; authenticate does that.
 */
export function bearerToken(header: string | string[] | undefined): string | undefined {
  if (typeof header !== "string") return undefined;
  return BEARER_HEADER.exec(header)?.[1];
}

/** Tokens in the api_tokens table. */
export function dbTokenStore(db: Kysely<DB>): TokenStore {
  const repo = tokensRepo(db);
  return {
    create: (input) => repo.create(input),
    findByHash: (hash) => repo.findByHash(hash),
    revoke: (id) => repo.revoke(id),
    touchLastUsed: (id, at) => repo.touchLastUsed(id, at),
  };
}

function describe(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

export function createTokens(deps: {
  store: TokenStore;
  now?: () => Date;
  /** Where a failed last-use write is reported; console.warn when left out. */
  log?: (line: string) => void;
}): Tokens {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.warn(line));

  return {
    async createToken(name) {
      const trimmed = name.trim();
      if (trimmed === "" || trimmed.length > MAX_TOKEN_NAME_LENGTH) {
        throw new RangeError(`A token's name is 1 to ${MAX_TOKEN_NAME_LENGTH} characters`);
      }
      const token = generateToken();
      const row = await store.create({
        name: trimmed,
        prefix: token.slice(0, DISPLAY_PREFIX_LENGTH),
        tokenHash: hashToken(token),
      });
      return { id: row.id, token };
    },

    revokeToken: (id) => store.revoke(id),

    async authenticate(authorization) {
      const presented = bearerToken(authorization);
      if (presented === undefined || !TOKEN_PATTERN.test(presented)) return undefined;
      const hash = hashToken(presented);
      const row = await store.findByHash(hash);
      if (row === undefined) return undefined;
      if (row.tokenHash.length !== hash.length || !timingSafeEqual(row.tokenHash, hash)) {
        return undefined;
      }
      const at = now();
      if (row.lastUsedAt === null || at.getTime() - row.lastUsedAt.getTime() >= TOKEN_TOUCH_MS) {
        try {
          await store.touchLastUsed(row.id, at);
          return { ...row, lastUsedAt: at };
        } catch (error) {
          // The request is let in all the same; only "last used" lags.
          log(`api: could not record a token's last use: ${describe(error)}`);
        }
      }
      return row;
    },
  };
}

const requestTokens = new WeakMap<FastifyRequest, ApiToken>();

/** The token the bearer hook let this request in with, if any. */
export function tokenOf(request: FastifyRequest): ApiToken | undefined {
  return requestTokens.get(request);
}

/** The 401 every bearer route gives a request without a live token. */
function refuse(reply: Parameters<AuthHook>[1]) {
  return reply
    .code(401)
    .header("www-authenticate", "Bearer")
    .header("cache-control", "no-store")
    .send({ error: "unauthorized" });
}

/**
 * The onRequest hook for bearer-class routes: lets a request with a live
 * token through, answers anything else 401 JSON (503 when the store fails).
 * Cookies are never read.
 */
export function createBearerHook(tokens: Pick<Tokens, "authenticate">): AuthHook {
  return async (request, reply) => {
    if (requestTokens.has(request)) return;
    let token: ApiToken | undefined;
    try {
      token = await tokens.authenticate(request.headers.authorization);
    } catch (error) {
      // The store's error (a database host, a port) goes to the log only.
      request.log.warn({ err: error }, "api: could not check the token");
      return reply.code(503).header("cache-control", "no-store").send({ error: "unavailable" });
    }
    if (token === undefined) return refuse(reply);
    requestTokens.set(request, token);
  };
}
