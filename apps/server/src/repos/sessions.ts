import type { Kysely } from "kysely";
import type { DB, Session } from "../db/types.js";

export interface NewSession {
  id: string;
  subject: string;
  expiresAt: Date;
  idleExpiresAt: Date;
}

export function sessionsRepo(_db: Kysely<DB>) {
  return {
    async create(_input: NewSession): Promise<Session> {
      throw new Error("not implemented: sessions.create");
    },
    async get(_id: string, _now?: Date): Promise<Session | undefined> {
      throw new Error("not implemented: sessions.get");
    },
    async delete(_id: string): Promise<boolean> {
      throw new Error("not implemented: sessions.delete");
    },
  };
}

export type SessionsRepo = ReturnType<typeof sessionsRepo>;
