import type { Kysely } from "kysely";
import type { DB, Session } from "../db/types.js";

// Login sessions behind the __Host-ph_session cookie. The id is 32 random
// bytes in base64url, made by the caller; the schema refuses any other shape.

export interface NewSession {
  id: string;
  subject: string;
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

    /** Deletes every session past either expiry at now. Not implemented yet (stub). */
    async deleteExpired(_now: Date = new Date()): Promise<number> {
      throw new Error("deleteExpired is not implemented yet");
    },

    /** Ends a session; false when there was none. */
    async delete(id: string): Promise<boolean> {
      const result = await db.deleteFrom("sessions").where("id", "=", id).executeTakeFirst();
      return result.numDeletedRows > 0n;
    },
  };
}

export type SessionsRepo = ReturnType<typeof sessionsRepo>;
