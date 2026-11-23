import type { Kysely } from "kysely";
import { inTransaction } from "../db/kysely.js";
import type { DB, Session } from "../db/types.js";
import { tokensRepo } from "./tokens.js";

// Login sessions behind the __Host-ph_session cookie. The id is the base64url
// SHA-256 of the cookie value (auth/sessions.ts's sessionRowId), made by the
// caller, never the cookie value itself; it is 43 characters, and the
// schema refuses any other shape.

/** What Sign out everywhere did: sessions deleted and tokens revoked. */
export interface SignedOut {
  sessionsEnded: number;
  tokensRevoked: number;
}

export interface NewSession {
  id: string;
  subject: string;
  /** The display name the issuer gave at sign-in (auth/oidc.ts displayNameOf), or null. */
  displayName?: string | null;
  /** When the user signed in; the database's now() when left out. */
  createdAt?: Date;
  expiresAt: Date;
  idleExpiresAt: Date;
}

export function sessionsRepo(db: Kysely<DB>) {
  return {
    async create(input: NewSession): Promise<Session> {
      return db.insertInto("sessions").values(input).returningAll().executeTakeFirstOrThrow();
    },

    /** The session, unless it is past its absolute or its idle expiry at now. */
    async get(id: string, now: Date = new Date()): Promise<Session | undefined> {
      return db
        .selectFrom("sessions")
        .selectAll()
        .where("id", "=", id)
        .where("expiresAt", ">", now)
        .where("idleExpiresAt", ">", now)
        .executeTakeFirst();
    },

    /**
     * Deletes every session past its absolute or its idle expiry at now (the
     * rows get no longer finds), and returns how many it deleted.
     */
    async deleteExpired(now: Date = new Date()): Promise<number> {
      const result = await db
        .deleteFrom("sessions")
        .where((eb) => eb.or([eb("expiresAt", "<=", now), eb("idleExpiresAt", "<=", now)]))
        .executeTakeFirst();
      return Number(result.numDeletedRows);
    },

    /** Ends a session; false when there was none. */
    async delete(id: string): Promise<boolean> {
      const result = await db.deleteFrom("sessions").where("id", "=", id).executeTakeFirst();
      return result.numDeletedRows > 0n;
    },

    /** Deletes every session of one subject; returns how many. */
    async deleteForSubject(subject: string): Promise<number> {
      const result = await db
        .deleteFrom("sessions")
        .where("subject", "=", subject)
        .executeTakeFirst();
      return Number(result.numDeletedRows);
    },

    /**
     * Sign out everywhere, in one transaction: deletes every session of the
     * subject, then, with revokeTokens, revokes every live token they made.
     * The delete waits for a token creation holding one of those rows
     * (repos/tokens.ts createForSession) to commit, so the revoke after it
     * finds that token; a creation that reaches a row after the delete waits
     * for this commit and finds no session.
     */
    async signOutEverywhere(subject: string, revokeTokens: boolean): Promise<SignedOut> {
      return inTransaction(db, async (trx) => {
        const sessionsEnded = await sessionsRepo(trx).deleteForSubject(subject);
        const tokensRevoked = revokeTokens ? await tokensRepo(trx).revokeForCreator(subject) : 0;
        return { sessionsEnded, tokensRevoked };
      });
    },
  };
}

export type SessionsRepo = ReturnType<typeof sessionsRepo>;
