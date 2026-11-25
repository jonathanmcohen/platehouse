import { type Kysely, sql } from "kysely";
import { isUuid, uuidv7 } from "../db/ids.js";
import type { ApiToken, DB, Session } from "../db/types.js";

// API tokens, one per client, each revocable on its own. Only the SHA-256 of a token and its first 8
// characters are ever stored; the token itself is shown once by the caller.
// Since migration 0013 each new token also records who made it (issue #322).
// A token made from the settings page is made by createForSession, which reads
// the maker's session row under a lock in the same transaction as the insert,
// so it and Sign out everywhere (repos/sessions.ts) wait for each other
// (issue #414).

export interface NewToken {
  name: string;
  /** The token's first 8 characters, to tell tokens apart in the UI. */
  prefix: string;
  /** SHA-256 of the 32-byte random token. */
  tokenHash: Buffer;
  /** Who made it (migration 0013); left out, the maker is recorded as unknown. */
  createdBy?: TokenCreator | null;
}

/** A token made for a session: its maker is that session's subject and display name. */
export type SessionToken = Omit<NewToken, "createdBy">;

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

    /**
     * Makes a token for the session with this row id, in one transaction:
     * reads the session row with a FOR SHARE lock, and inserts the token,
     * made by that session's subject and display name, only when the row is
     * there and admit says yes to it as read under the lock; undefined
     * otherwise, and nothing is made. The lock is held until the commit, so
     * Sign out everywhere's delete of that row waits for the token to be
     * committed, and its revoke, which follows the delete in the same
     * transaction, then finds it; a creation that reaches the row after the delete waits for
     * the sign-out to commit and finds no row.
     *
     * The transaction asks for READ COMMITTED itself rather than taking the
     * database default: the sign-out's revoke finds this token only because
     * each of its statements takes a fresh snapshot, which a stricter level
     * would not. It starts its own transaction, so db cannot be one (Kysely
     * refuses to nest them).
     */
    async createForSession(
      sessionId: string,
      input: SessionToken,
      admit: (session: Session) => boolean,
    ): Promise<ApiToken | undefined> {
      return db
        .transaction()
        .setIsolationLevel("read committed")
        .execute(async (trx) => {
          const session = await trx
            .selectFrom("sessions")
            .selectAll()
            .where("id", "=", sessionId)
            .forShare()
            .executeTakeFirst();
          if (session === undefined || !admit(session)) return undefined;
          return tokensRepo(trx).create({
            ...input,
            createdBy: { subject: session.subject, name: session.displayName },
          });
        });
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

    /** Records that a live token was used at this time (by the bearer check; shown on the settings page). */
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
     * Revokes every live token this subject made; returns how many. A token
     * whose maker is unknown is never touched. Sign out everywhere calls it
     * in the same transaction as its session delete (repos/sessions.ts).
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
