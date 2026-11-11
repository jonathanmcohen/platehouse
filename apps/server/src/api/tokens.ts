// API tokens and the bearer check (build plan Task 16; AC-081, AC-083,
// AC-085). Interface only: the implementation lands with the tests' fix.
import type { FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import type { ApiToken, DB } from "../db/types.js";
import type { NewToken } from "../repos/tokens.js";
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

export interface TokenStore {
  create(input: NewToken): Promise<{ id: string }>;
  findByHash(hash: Buffer): Promise<ApiToken | undefined>;
  revoke(id: string): Promise<boolean>;
  touchLastUsed(id: string, at: Date): Promise<void>;
}

/** What createToken hands back once: the row id and the token itself. */
export interface CreatedToken {
  id: string;
  token: string;
}

export interface Tokens {
  createToken(name: string): Promise<CreatedToken>;
  revokeToken(id: string): Promise<boolean>;
  authenticate(authorization: string | string[] | undefined): Promise<ApiToken | undefined>;
}

export function generateToken(): string {
  return "";
}

export function hashToken(presented: string): Buffer {
  return Buffer.alloc(presented.length === 0 ? 0 : 0);
}

export function bearerToken(header: string | string[] | undefined): string | undefined {
  return header === undefined ? undefined : undefined;
}

export function dbTokenStore(_db: Kysely<DB>): TokenStore {
  return {
    create: async () => ({ id: "" }),
    findByHash: async () => undefined,
    revoke: async () => false,
    touchLastUsed: async () => {},
  };
}

export function createTokens(_deps: {
  store: TokenStore;
  now?: () => Date;
  log?: (line: string) => void;
}): Tokens {
  return {
    createToken: async () => ({ id: "", token: "" }),
    revokeToken: async () => false,
    authenticate: async () => undefined,
  };
}

export function tokenOf(_request: FastifyRequest): ApiToken | undefined {
  return undefined;
}

export function createBearerHook(_tokens: Pick<Tokens, "authenticate">): AuthHook {
  return async (_request, reply) => reply.code(401).send({ error: "unauthorized" });
}
