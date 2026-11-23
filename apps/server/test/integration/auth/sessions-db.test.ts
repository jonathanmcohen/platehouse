// Sessions in the sessions table (Postgres 17). The store
// honours both expiries, a request moves the idle expiry on at most once per
// SESSION_TOUCH_MS, never past the absolute expiry, and a whole login through
// the app and the mock issuer leaves one row that logout deletes. A row's id
// is the base64url SHA-256 of the cookie value, never the cookie value, and
// the maintenance delete removes rows past either expiry and keeps live ones.
// Token creation and Sign out everywhere wait for each other on the session
// row (issue #414): two connections race them, held at a known point by a
// third transaction, and no live token of the signed-out user is left.
import { createHash, randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { type Kysely, sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { type CreatedToken, createTokens, dbTokenStore } from "../../../src/api/tokens.js";
import { dbUserList } from "../../../src/app-api/users.js";
import { TOKEN_SIGN_IN_WINDOW_MS } from "../../../src/auth/fresh.js";
import {
  createSessions,
  dbSessionStore,
  SESSION_ABSOLUTE_MS,
  SESSION_COOKIE,
  SESSION_IDLE_MS,
  SESSION_TOUCH_MS,
  sessionRowId,
} from "../../../src/auth/sessions.js";
import { migrate } from "../../../src/db/migrate.js";
import type { DB } from "../../../src/db/types.js";
import { sessionsRepo } from "../../../src/repos/sessions.js";
import { startTestPostgres, type TestPostgres } from "../support/db.js";
import {
  type AuthTestApp,
  authTestApp,
  runLogin,
  TEST_ORIGIN,
  testClock,
} from "../support/oidc-issuer.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

let pgc: TestPostgres;
let db: Kysely<DB>;

beforeAll(async () => {
  pgc = await startTestPostgres();
  db = (await pgc.freshDatabase()).db;
  await migrate(db);
});

afterAll(async () => {
  await pgc?.stop();
});

beforeEach(async () => {
  await db.deleteFrom("sessions").execute();
});

async function row(id: string) {
  return db.selectFrom("sessions").selectAll().where("id", "=", id).executeTakeFirst();
}

/** The row of the session behind this cookie value. */
async function rowOf(cookie: string) {
  return row(sessionRowId(cookie));
}

/** base64url(SHA-256(cookie value)), worked out here rather than by the code under test. */
function sha256(cookie: string): string {
  return createHash("sha256").update(cookie).digest("base64url");
}

describe("dbSessionStore", () => {
  test("get honours the absolute and the idle expiry", async () => {
    const store = dbSessionStore(db);
    const now = new Date();
    const id = "A".repeat(43);
    await store.create({
      id,
      subject: "someone",
      expiresAt: new Date(now.getTime() + 10 * DAY),
      idleExpiresAt: new Date(now.getTime() + DAY),
    });
    expect((await store.get(id, now))?.subject).toBe("someone");
    expect(await store.get(id, new Date(now.getTime() + DAY))).toBeUndefined();
    await store.touch(id, new Date(now.getTime() + 20 * DAY));
    expect(await store.get(id, new Date(now.getTime() + 5 * DAY))).toBeDefined();
    expect(await store.get(id, new Date(now.getTime() + 10 * DAY))).toBeUndefined();
    expect(await store.delete(id)).toBe(true);
    expect(await store.delete(id)).toBe(false);
  });
});

describe("createSessions over the sessions table", () => {
  test("start writes one row: a 43-character id, the subject and both expiries", async () => {
    const clock = testClock();
    const sessions = createSessions({ store: dbSessionStore(db), now: () => clock.now });
    const started = await sessions.start("subject-1");
    expect(started.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = await rowOf(started.id);
    expect(stored?.subject).toBe("subject-1");
    expect(stored?.expiresAt.getTime()).toBe(clock.now.getTime() + SESSION_ABSOLUTE_MS);
    expect(stored?.idleExpiresAt.getTime()).toBe(clock.now.getTime() + SESSION_IDLE_MS);
    expect(started.expiresAt.getTime()).toBe(clock.now.getTime() + SESSION_ABSOLUTE_MS);
  });

  test("find moves the idle expiry on at most once per SESSION_TOUCH_MS", async () => {
    const clock = testClock();
    const sessions = createSessions({ store: dbSessionStore(db), now: () => clock.now });
    const { id } = await sessions.start("subject-2");
    const first = (await rowOf(id))?.idleExpiresAt.getTime();
    expect(first).toBeDefined();

    clock.advance(MINUTE);
    expect(await sessions.find(id)).toBeDefined();
    expect((await rowOf(id))?.idleExpiresAt.getTime()).toBe(first);

    clock.advance(SESSION_TOUCH_MS);
    expect(await sessions.find(id)).toBeDefined();
    expect((await rowOf(id))?.idleExpiresAt.getTime()).toBe(clock.now.getTime() + SESSION_IDLE_MS);
  });

  test("the idle expiry never moves past the absolute expiry", async () => {
    const clock = testClock();
    const sessions = createSessions({ store: dbSessionStore(db), now: () => clock.now });
    const { id, expiresAt } = await sessions.start("subject-3");
    // A request every 5 days keeps it alive to day 25, then one on day 28.
    for (let day = 5; day <= 25; day += 5) {
      clock.advance(5 * DAY);
      expect(await sessions.find(id), `day ${day}`).toBeDefined();
    }
    clock.advance(3 * DAY);
    expect(await sessions.find(id)).toBeDefined();
    expect((await rowOf(id))?.idleExpiresAt.getTime()).toBe(expiresAt.getTime());
  });

  test("end deletes the row; an ended or unknown id finds nothing", async () => {
    const sessions = createSessions({ store: dbSessionStore(db) });
    const { id } = await sessions.start("subject-4");
    expect(await rowOf(id)).toBeDefined();
    await sessions.end(id);
    expect(await rowOf(id)).toBeUndefined();
    expect(await sessions.find(id)).toBeUndefined();
    expect(await sessions.find(undefined)).toBeUndefined();
    await sessions.end(undefined);
  });

  // Issue #322: the sign-in time (created_at, from the sessions clock) decides
  // whether a session may make a new API token, and the display name is what
  // that token records as its creator's name.
  test("start records the sign-in time from its clock and the display name, or null", async () => {
    const clock = testClock(new Date(Date.now() - 3 * DAY));
    const sessions = createSessions({ store: dbSessionStore(db), now: () => clock.now });
    const named = await sessions.start("subject-5", "Synthetic Five");
    const stored = await rowOf(named.id);
    expect(stored?.displayName).toBe("Synthetic Five");
    expect(stored?.createdAt.getTime()).toBe(clock.now.getTime());
    expect((await sessions.find(named.id))?.displayName).toBe("Synthetic Five");
    const unnamed = await sessions.start("subject-5");
    expect((await rowOf(unnamed.id))?.displayName).toBeNull();
  });

  test("signOutEverywhere deletes every session of one subject and no other", async () => {
    const sessions = createSessions({ store: dbSessionStore(db) });
    const a1 = await sessions.start("subject-a");
    const a2 = await sessions.start("subject-a");
    const b = await sessions.start("subject-b");
    expect(await sessions.signOutEverywhere("subject-a", false)).toEqual({
      sessionsEnded: 2,
      tokensRevoked: 0,
    });
    expect(await rowOf(a1.id)).toBeUndefined();
    expect(await rowOf(a2.id)).toBeUndefined();
    expect(await rowOf(b.id)).toBeDefined();
    expect(await sessions.find(b.id)).toBeDefined();
    expect(await sessions.signOutEverywhere("subject-a", false)).toEqual({
      sessionsEnded: 0,
      tokensRevoked: 0,
    });
  });

  test("the schema refuses a display name over 200 characters", async () => {
    await expect(
      dbSessionStore(db).create({
        id: "B".repeat(43),
        subject: "subject-long",
        displayName: "x".repeat(201),
        expiresAt: new Date(Date.now() + DAY),
        idleExpiresAt: new Date(Date.now() + DAY),
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("dbUserList over the sessions and api_tokens tables (issue #322)", () => {
  beforeEach(async () => {
    await db.deleteFrom("apiTokens").execute();
  });

  test("lists everyone with a live session or a live token they made, named by their newest session", async () => {
    const now = new Date();
    const store = dbSessionStore(db);
    const live = (id: string, subject: string, displayName: string | null, ageMs: number) =>
      store.create({
        id,
        subject,
        displayName,
        createdAt: new Date(now.getTime() - ageMs),
        expiresAt: new Date(now.getTime() + DAY),
        idleExpiresAt: new Date(now.getTime() + DAY),
      });
    await live("C".repeat(43), "subject-x", "Old Name", 2 * DAY);
    await live("D".repeat(43), "subject-x", "New Name", DAY);
    await live("E".repeat(43), "subject-x", null, MINUTE);
    // Past its idle expiry: not counted, and its name is not used.
    await store.create({
      id: "F".repeat(43),
      subject: "subject-expired",
      displayName: "Expired",
      expiresAt: new Date(now.getTime() + DAY),
      idleExpiresAt: new Date(now.getTime() - MINUTE),
    });
    const tokens = createTokens({ store: dbTokenStore(db), log: () => {} });
    await tokens.createToken("x laptop", { subject: "subject-x", name: "Token Name" });
    await tokens.createToken("y laptop", { subject: "subject-y", name: "Only Token" });
    const revoked = await tokens.createToken("y old", { subject: "subject-y", name: "Older" });
    await tokens.revokeToken(revoked.id);
    // Made before creators were recorded: no user to list.
    await tokens.createToken("anonymous");

    const users = await dbUserList(db)(now);
    expect(users).toEqual(
      expect.arrayContaining([
        { subject: "subject-x", name: "New Name", sessions: 3, tokens: 1 },
        { subject: "subject-y", name: "Only Token", sessions: 0, tokens: 1 },
      ]),
    );
    expect(users).toHaveLength(2);
  });

  test("signOutEverywhere with revokeTokens revokes every live token of one creator and no other", async () => {
    const tokens = createTokens({ store: dbTokenStore(db), log: () => {} });
    const sessions = createSessions({ store: dbSessionStore(db) });
    const a = await tokens.createToken("a1", { subject: "subject-a", name: null });
    const a2 = await tokens.createToken("a2", { subject: "subject-a", name: "A" });
    const b = await tokens.createToken("b", { subject: "subject-b", name: "B" });
    const none = await tokens.createToken("old");
    expect(await sessions.signOutEverywhere("subject-a", true)).toEqual({
      sessionsEnded: 0,
      tokensRevoked: 2,
    });
    expect(await tokens.authenticate(`Bearer ${a.token}`)).toBeUndefined();
    expect(await tokens.authenticate(`Bearer ${a2.token}`)).toBeUndefined();
    expect((await tokens.authenticate(`Bearer ${b.token}`))?.id).toBe(b.id);
    expect((await tokens.authenticate(`Bearer ${none.token}`))?.id).toBe(none.id);
    expect(await sessions.signOutEverywhere("subject-a", true)).toEqual({
      sessionsEnded: 0,
      tokensRevoked: 0,
    });
  });
});

describe("token creation and Sign out everywhere wait for each other (issue #414)", () => {
  beforeEach(async () => {
    await db.deleteFrom("apiTokens").execute();
  });

  /** A session row for subject, signed in agoMs ago; returns its row id. */
  async function signedIn(subject: string, agoMs = 0): Promise<string> {
    const id = sha256(randomBytes(32).toString("base64url"));
    const now = Date.now();
    await dbSessionStore(db).create({
      id,
      subject,
      displayName: "Synthetic Racer",
      createdAt: new Date(now - agoMs),
      expiresAt: new Date(now + DAY),
      idleExpiresAt: new Date(now + DAY),
    });
    return id;
  }

  /** Live tokens this subject made. */
  async function liveTokens(subject: string): Promise<number> {
    const { rows } = await sql<{ n: number }>`
      select count(*)::int as n from api_tokens
       where created_by_subject = ${subject} and revoked_at is null
    `.execute(db);
    return rows[0]?.n ?? 0;
  }

  /**
   * Waits until a statement whose text matches pattern is waiting on a lock:
   * the point a racing transaction is known to have reached. Fails after 10 s.
   */
  async function waitingOnLock(pattern: string, what: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const { rows } = await sql<{ waiting: number }>`
        select count(*)::int as waiting from pg_stat_activity
         where datname = current_database() and wait_event_type = 'Lock'
           and query ilike ${pattern} and query not ilike '%pg_stat_activity%'
      `.execute(db);
      if ((rows[0]?.waiting ?? 0) > 0) return;
      if (Date.now() > deadline) throw new Error(`${what} never waited on a lock`);
      await sleep(20);
    }
  }

  /**
   * A transaction on a connection of its own that holds api_tokens in SHARE
   * mode until released: an insert into api_tokens, or an update of it, waits
   * for it. That stops a racing transaction at a known statement, after the
   * statements before it have taken their locks.
   */
  async function holdTokenTable() {
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held: () => void = () => {};
    const isHeld = new Promise<void>((resolve) => {
      held = resolve;
    });
    const done = db.transaction().execute(async (trx) => {
      await sql`lock table api_tokens in share mode`.execute(trx);
      held();
      await released;
    });
    await Promise.race([isHeld, done]);
    return { release, done };
  }

  test("a fresh session gets a token made by its subject, with its display name", async () => {
    const tokens = createTokens({ store: dbTokenStore(db), log: () => {} });
    const id = await signedIn("subject-made");
    const created = await tokens.createTokenForSession(id, "Script", new Date());
    if (created === "stale") throw new Error("refused a fresh session");
    const row = await tokens.authenticate(`Bearer ${created.token}`);
    expect(row?.createdBySubject).toBe("subject-made");
    expect(row?.createdByName).toBe("Synthetic Racer");
  });

  test("a session signed in longer ago than the window answers stale and makes nothing", async () => {
    const tokens = createTokens({ store: dbTokenStore(db), log: () => {} });
    const id = await signedIn("subject-old", TOKEN_SIGN_IN_WINDOW_MS + 1000);
    expect(await tokens.createTokenForSession(id, "Script", new Date())).toBe("stale");
    expect(await db.selectFrom("apiTokens").select("id").execute()).toEqual([]);
  });

  test("creation with a session deleted before it starts answers stale", async () => {
    const tokens = createTokens({ store: dbTokenStore(db), log: () => {} });
    const id = await signedIn("subject-gone");
    expect(await dbSessionStore(db).delete(id)).toBe(true);
    expect(await tokens.createTokenForSession(id, "Script", new Date())).toBe("stale");
    expect(await db.selectFrom("apiTokens").select("id").execute()).toEqual([]);
  });

  test("a token made while its maker is signed out everywhere is revoked or refused", async () => {
    // The creation reads the session row first and holds it; Sign out
    // everywhere then waits for it, and its revoke catches the new token.
    const subject = "subject-race-create-first";
    const tokens = createTokens({ store: dbTokenStore(db), log: () => {} });
    const sessions = createSessions({ store: dbSessionStore(db) });
    const id = await signedIn(subject);
    const hold = await holdTokenTable();
    let creating: Promise<CreatedToken | "stale"> | undefined;
    let signingOut: Promise<{ sessionsEnded: number; tokensRevoked: number }> | undefined;
    try {
      creating = tokens.createTokenForSession(id, "Raced script", new Date());
      // The creation has read and locked the session row; its insert waits.
      await waitingOnLock('insert into "api_tokens"%', "the token insert");
      signingOut = sessions.signOutEverywhere(subject, true);
      // Ending the sessions waits for the creation that holds the row.
      await waitingOnLock('delete from "sessions"%', "Sign out everywhere's delete");
      hold.release();
      await hold.done;
      const created = await creating;
      const out = await signingOut;
      expect(await liveTokens(subject)).toBe(0);
      if (created !== "stale") {
        expect(await tokens.authenticate(`Bearer ${created.token}`)).toBeUndefined();
      }
      // In this order the creation went first, so it made the token and the
      // sign-out revoked it.
      expect(created).not.toBe("stale");
      expect(out).toEqual({ sessionsEnded: 1, tokensRevoked: 1 });
    } finally {
      hold.release();
      await hold.done.catch(() => {});
      await creating?.catch(() => undefined);
      await signingOut?.catch(() => undefined);
    }
  });

  test("a token asked for while its maker is being signed out everywhere is refused", async () => {
    // Sign out everywhere has deleted the session rows and not committed; the
    // creation's locked read waits for it, then finds no session.
    const subject = "subject-race-sign-out-first";
    const tokens = createTokens({ store: dbTokenStore(db), log: () => {} });
    const sessions = createSessions({ store: dbSessionStore(db) });
    const id = await signedIn(subject);
    const hold = await holdTokenTable();
    let creating: Promise<CreatedToken | "stale"> | undefined;
    let signingOut: Promise<{ sessionsEnded: number; tokensRevoked: number }> | undefined;
    try {
      signingOut = sessions.signOutEverywhere(subject, true);
      // The sessions are deleted in its transaction; its revoke waits.
      await waitingOnLock('update "api_tokens"%', "Sign out everywhere's revoke");
      creating = tokens.createTokenForSession(id, "Raced script", new Date());
      // The creation's read of the session row waits for the sign-out.
      await waitingOnLock('select%from "sessions"%for share%', "the creation's session read");
      hold.release();
      await hold.done;
      const out = await signingOut;
      const created = await creating;
      expect(await liveTokens(subject)).toBe(0);
      expect(created).toBe("stale");
      expect(out).toEqual({ sessionsEnded: 1, tokensRevoked: 0 });
      expect(await db.selectFrom("apiTokens").select("id").execute()).toEqual([]);
    } finally {
      hold.release();
      await hold.done.catch(() => {});
      await signingOut?.catch(() => undefined);
      await creating?.catch(() => undefined);
    }
  });
});

describe("the stored session id", () => {
  test("is not the cookie value and equals its base64url SHA-256", async () => {
    const sessions = createSessions({ store: dbSessionStore(db) });
    const { id: cookie } = await sessions.start("subject-5");
    const ids = (await db.selectFrom("sessions").select("id").execute()).map((r) => r.id);
    expect(ids).toEqual([sha256(cookie)]);
    expect(ids[0]).not.toBe(cookie);
    expect(await row(cookie)).toBeUndefined();
  });

  test("a stored id used as a cookie finds nothing, and ending it deletes nothing", async () => {
    const sessions = createSessions({ store: dbSessionStore(db) });
    const { id: cookie } = await sessions.start("subject-6");
    const stored = sha256(cookie);
    expect(await sessions.find(cookie)).toBeDefined();
    expect(await sessions.find(stored)).toBeUndefined();
    await sessions.end(stored);
    expect(await row(stored)).toBeDefined();
  });
});

describe("the expired-session delete", () => {
  test("deletes a row past its idle expiry and one past its absolute expiry, and keeps a live one", async () => {
    const now = new Date();
    const at = (ms: number) => new Date(now.getTime() + ms);
    const rows = {
      idleExpired: { id: "I".repeat(43), expiresAt: at(20 * DAY), idleExpiresAt: at(-MINUTE) },
      absoluteExpired: { id: "X".repeat(43), expiresAt: at(-MINUTE), idleExpiresAt: at(DAY) },
      idleAtNow: { id: "N".repeat(43), expiresAt: at(20 * DAY), idleExpiresAt: now },
      live: { id: "L".repeat(43), expiresAt: at(20 * DAY), idleExpiresAt: at(DAY) },
    };
    for (const r of Object.values(rows)) {
      await db
        .insertInto("sessions")
        .values({ ...r, subject: "someone" })
        .execute();
    }
    expect(await sessionsRepo(db).deleteExpired(now)).toBe(3);
    const left = (await db.selectFrom("sessions").select("id").execute()).map((r) => r.id);
    expect(left).toEqual([rows.live.id]);
  });
});

describe("a login through the app with sessions in Postgres", () => {
  let t: AuthTestApp;

  beforeAll(async () => {
    t = await authTestApp({ store: dbSessionStore(db) });
  });

  afterAll(async () => {
    await t?.close();
  });

  test("leaves one session row for the issuer's subject, and logout deletes it", async () => {
    const run = await runLogin(t);
    expect(run.callback.statusCode).toBe(302);
    const id = run.sessionCookie ?? "";
    expect((await rowOf(id))?.subject).toBe(t.issuer.user.sub);

    const signedIn = await t.app.inject({
      method: "GET",
      url: "/app/uploads/0198f0c4-6a1b-7c2d-8e3f-4a5b6c7d8e9f/result",
      cookies: { [SESSION_COOKIE]: id },
    });
    expect(signedIn.statusCode).toBe(404);

    const out = await t.app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { origin: TEST_ORIGIN },
      cookies: { [SESSION_COOKIE]: id },
    });
    expect(out.statusCode).toBe(204);
    expect(await rowOf(id)).toBeUndefined();
    expect(await db.selectFrom("sessions").select("id").execute()).toEqual([]);
  });

  test("records the name the issuer gives as the session's display name (issue #322)", async () => {
    t.issuer.user = { ...t.issuer.user, name: "Synthetic Signer" };
    const run = await runLogin(t);
    expect(run.callback.statusCode).toBe(302);
    expect((await rowOf(run.sessionCookie ?? ""))?.displayName).toBe("Synthetic Signer");
  });

  // Issue #378: a subject is at most 255 characters (admit, MAX_SUBJECT_LENGTH),
  // so every subject sign-in lets in fits the subject columns, their checks and
  // their btree indexes. Four-byte characters make it about 1 KB, the largest
  // a subject can be.
  test("a 255-character subject signs in and makes a token, with Postgres", async () => {
    const sub = String.fromCodePoint(0x1f600).repeat(255);
    t.issuer.user = { ...t.issuer.user, sub, name: "Synthetic Long" };
    const run = await runLogin(t);
    expect(run.callback.statusCode).toBe(302);
    expect((await rowOf(run.sessionCookie ?? ""))?.subject).toBe(sub);
    const tokens = createTokens({ store: dbTokenStore(db), log: () => {} });
    const made = await tokens.createToken("Long script", { subject: sub, name: "Synthetic Long" });
    expect((await tokens.authenticate(`Bearer ${made.token}`))?.createdBySubject).toBe(sub);
    expect(
      await createSessions({ store: dbSessionStore(db) }).signOutEverywhere(sub, true),
    ).toEqual({ sessionsEnded: 1, tokensRevoked: 1 });
  });

  test("a 256-character subject is refused at sign-in, and no session row is written", async () => {
    t.issuer.user = { ...t.issuer.user, sub: "w".repeat(256) };
    const run = await runLogin(t);
    expect(run.callback.statusCode).toBe(403);
    expect(run.sessionCookie).toBeUndefined();
    expect(await db.selectFrom("sessions").select("id").execute()).toEqual([]);
  });
});
