import { type Kysely, sql } from "kysely";
import { isUuid, uuidv7 } from "../db/ids.js";
import type { ApiToken, DB } from "../db/types.js";

// API tokens (AC-083). Only the SHA-256 of a token and its first 8
// characters are ever stored; the token itself is shown once by the caller.
// Since migration 0010 each new token also records who made it (issue #322).

export interface NewToken {
  name: string;
  /** The token's first 8 characters, to tell tokens apart in the UI. */
  prefix: string;
  /** SHA-256 of the 32-byte random token. */
  tokenHash: Buffer;
  /** Who made it (migration 0010); left out, the maker is recorded as unknown. */
  createdBy?: TokenCreator | null;
}

/** Who made a token: the OIDC subject and the display name the session had then. */
export interface TokenCreator {
  subject: string;
  name: string | null;
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
          createdBySubject: input.createdBy?.subject ?? null,
          createdByName: input.createdBy?.name ?? null,
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

    /** Records that a live token was used at this time (Task 16; shown by Task 21). */
    async touchLastUsed(id: string, at: Date): Promise<void> {
      if (!isUuid(id)) return;
      await db
        .updateTable("apiTokens")
        .set({ lastUsedAt: at })
        .where("id", "=", id)
        .where("revokedAt", "is", null)
        .execute();
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

    /**
     * Revokes every live token this subject made (Sign out everywhere);
     * returns how many. A token whose maker is unknown is never touched.
     */
    async revokeForCreator(subject: string): Promise<number> {
      const result = await db
        .updateTable("apiTokens")
        .set({ revokedAt: sql`now()` })
        .where("createdBySubject", "=", subject)
        .where("revokedAt", "is", null)
        .executeTakeFirst();
      return Number(result.numUpdatedRows);
    },
  };
}

export type TokensRepo = ReturnType<typeof tokensRepo>;
