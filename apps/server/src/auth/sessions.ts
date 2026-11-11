// Login sessions (build plan Task 15; AC-080). Not implemented yet: the
// failing tests come first.
import type { Kysely } from "kysely";
import type { DB, Session } from "../db/types.js";
import type { NewSession } from "../repos/sessions.js";

/** The session cookie (Database schema contract). */
export const SESSION_COOKIE = "__Host-ph_session";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A session ends after this long without a request. */
export const SESSION_IDLE_MS = 7 * DAY_MS;

/** A session ends this long after login, however busy it is. */
export const SESSION_ABSOLUTE_MS = 30 * DAY_MS;

/** How stale a session's idle expiry may get before a request moves it on. */
export const SESSION_TOUCH_MS = 60 * 60 * 1000;

/** Where sessions are kept: the sessions table in production. */
export interface SessionStore {
  create(input: NewSession): Promise<unknown>;
  /** The session, unless it is past its absolute or idle expiry at now. */
  get(id: string, now: Date): Promise<Session | undefined>;
  delete(id: string): Promise<boolean>;
  /** Moves a session's idle expiry to idleExpiresAt. */
  touch(id: string, idleExpiresAt: Date): Promise<void>;
}

export function dbSessionStore(_db: Kysely<DB>): SessionStore {
  const missing = async (): Promise<never> => {
    throw new Error("dbSessionStore is not implemented yet");
  };
  return { create: missing, get: missing, delete: missing, touch: missing };
}

export interface StartedSession {
  id: string;
  expiresAt: Date;
}

export interface Sessions {
  /** A new session for subject, 32 random bytes in base64url. */
  start(subject: string): Promise<StartedSession>;
  /** The live session with this id, its idle expiry moved on; undefined when there is none. */
  find(id: string | undefined): Promise<Session | undefined>;
  /** Ends a session; nothing happens when there is none. */
  end(id: string | undefined): Promise<void>;
}

export function createSessions(_deps: { store: SessionStore; now?: () => Date }): Sessions {
  const missing = async (): Promise<never> => {
    throw new Error("sessions are not implemented yet");
  };
  return { start: missing, find: missing, end: missing };
}
