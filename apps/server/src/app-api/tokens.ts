// API tokens for the settings page (build plan Task 21). Skeleton: the
// implementation follows the failing tests.
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import type { Tokens } from "../api/tokens.js";
import type { ApiToken, DB } from "../db/types.js";

/** A live token as the list shows it: never the token itself. */
export type ListedToken = Pick<ApiToken, "id" | "name" | "prefix" | "createdAt" | "lastUsedAt">;

export interface TokensApiDeps {
  tokens: Pick<Tokens, "createToken" | "revokeToken">;
  /** Every live token, newest first. */
  list(): Promise<ListedToken[]>;
}

export function dbTokenList(_db: Kysely<DB>): () => Promise<ListedToken[]> {
  return async () => [];
}

export async function registerTokensApi(
  _app: FastifyInstance,
  _deps: TokensApiDeps | undefined,
): Promise<void> {}
