import { type Kysely, sql } from "kysely";
import { isUuid, uuidv7 } from "../db/ids.js";
import type { ApiToken, DB } from "../db/types.js";

// API tokens (AC-083). Only the SHA-256 of a token and its first 8
// characters are ever stored; the token itself is shown once by the caller.

export interface NewToken {
  name: string;
  /** The token's first 8 characters, to tell tokens apart in the UI. */
  prefix: string;
  /** SHA-256 of the 32-byte random token. */
  tokenHash: Buffer;
}

export function tokensRepo(db: Kysely<DB>) {
  return {
    async create(input: NewToken): Promise<ApiToken> {
      return db
        .insertInto("apiTokens")
        .values({
          id: uuidv7(),
          name: input.name,
          prefix: input.prefix,
          tokenHash: input.tokenHash,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    },

    /** The live token with this hash; a revoked token is never found. */
    async findByHash(tokenHash: Buffer): Promise<ApiToken | undefined> {
      return db
        .selectFrom("apiTokens")
        .selectAll()
        .where("tokenHash", "=", tokenHash)
        .where("revokedAt", "is", null)
        .executeTakeFirst();
    },

    /** Revokes one token; false when it is unknown or already revoked. */
    async revoke(id: string): Promise<boolean> {
      if (!isUuid(id)) return false;
      const result = await db
        .updateTable("apiTokens")
        .set({ revokedAt: sql`now()` })
        .where("id", "=", id)
        .where("revokedAt", "is", null)
        .executeTakeFirst();
      return result.numUpdatedRows > 0n;
    },
  };
}

export type TokensRepo = ReturnType<typeof tokensRepo>;
