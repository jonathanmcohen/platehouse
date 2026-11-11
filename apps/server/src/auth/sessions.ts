// Login sessions (build plan Task 15; AC-080). A session is a row in the
// sessions table, named by 32 random bytes in base64url (43 characters),
// which is also the value of the __Host-ph_session cookie. It lasts
// SESSION_IDLE_MS (7 days) without a request and SESSION_ABSOLUTE_MS (30
// days) at most, however busy it is.
//
// Each request a session lets in moves its idle expiry on, but the row is
// written at most once per SESSION_TOUCH_MS (an hour), so a page of
// thumbnails is not a page of database writes, and never past the absolute
// expiry. The idle expiry is therefore exact to within an hour.
//
// The cookie's attributes are fixed here: __Host- (so Secure, Path=/ and no
// Domain), HttpOnly and SameSite=Lax. Lax, not Strict: the callback from
// Pocket ID is a top-level navigation from another site, and so is a link
// to Platehouse; state-changing requests are guarded by the Origin check in
// gate.ts instead.
import { randomBytes } from "node:crypto";
import type { Kysely } from "kysely";
import type { DB, Session } from "../db/types.js";
import { type NewSession, sessionsRepo } from "../repos/sessions.js";

/** The session cookie (Database schema contract). */
export const SESSION_COOKIE = "__Host-ph_session";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A session ends after this long without a request. */
export const SESSION_IDLE_MS = 7 * DAY_MS;

/** A session ends this long after login, however busy it is. */
export const SESSION_ABSOLUTE_MS = 30 * DAY_MS;

/** How stale a session's idle expiry may get before a request moves it on. */
export const SESSION_TOUCH_MS = 60 * 60 * 1000;

/** A session id: 32 bytes in unpadded base64url, as the schema requires. */
const SESSION_ID = /^[A-Za-z0-9_-]{43}$/;

/**
 * The attributes every session cookie carries, the clearing one included:
 * a browser replaces a cookie only when name, path and domain match, and
 * drops a __Host- cookie that is not Secure with Path=/ and no Domain.
 */
export const SESSION_COOKIE_OPTIONS = Object.freeze({
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "lax",
} as const);

/** Where sessions are kept: the sessions table in production. */
export interface SessionStore {
  create(input: NewSession): Promise<unknown>;
  /** The session, unless it is past its absolute or idle expiry at now. */
  get(id: string, now: Date): Promise<Session | undefined>;
  delete(id: string): Promise<boolean>;
  /** Moves a session's idle expiry to idleExpiresAt. */
  touch(id: string, idleExpiresAt: Date): Promise<void>;
}

/** Sessions in the sessions table: the repository, plus the idle-expiry update. */
export function dbSessionStore(db: Kysely<DB>): SessionStore {
  const repo = sessionsRepo(db);
  return {
    create: (input) => repo.create(input),
    get: (id, now) => repo.get(id, now),
    delete: (id) => repo.delete(id),
    async touch(id, idleExpiresAt) {
      await db.updateTable("sessions").set({ idleExpiresAt }).where("id", "=", id).execute();
    },
  };
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

/** True when id has the shape of a session id; anything else is never looked up. */
export function isSessionId(id: string | undefined): id is string {
  return id !== undefined && SESSION_ID.test(id);
}

export function createSessions(deps: { store: SessionStore; now?: () => Date }): Sessions {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());

  return {
    async start(subject) {
      const at = now().getTime();
      const id = randomBytes(32).toString("base64url");
      const expiresAt = new Date(at + SESSION_ABSOLUTE_MS);
      await store.create({
        id,
        subject,
        expiresAt,
        idleExpiresAt: new Date(at + SESSION_IDLE_MS),
      });
      return { id, expiresAt };
    },

    async find(id) {
      if (!isSessionId(id)) return undefined;
      const at = now();
      const session = await store.get(id, at);
      if (session === undefined) return undefined;
      const next = Math.min(at.getTime() + SESSION_IDLE_MS, session.expiresAt.getTime());
      if (next - session.idleExpiresAt.getTime() >= SESSION_TOUCH_MS) {
        const idleExpiresAt = new Date(next);
        await store.touch(id, idleExpiresAt);
        return { ...session, idleExpiresAt };
      }
      return session;
    },

    async end(id) {
      if (isSessionId(id)) await store.delete(id);
    },
  };
}
