// Build plan Task 15: sessions in the sessions table (Postgres 17). The store
// honours both expiries, a request moves the idle expiry on at most once per
// SESSION_TOUCH_MS, never past the absolute expiry, and a whole login through
// the app and the mock issuer leaves one row that logout deletes. A row's id
// is the base64url SHA-256 of the cookie value, never the cookie value, and
// the maintenance delete removes rows past either expiry and keeps live ones.
import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createTokens, dbTokenStore } from "../../../src/api/tokens.js";
import { dbUserList } from "../../../src/app-api/users.js";
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

  test("endAllFor deletes every session of one subject and no other", async () => {
    const sessions = createSessions({ store: dbSessionStore(db) });
    const a1 = await sessions.start("subject-a");
    const a2 = await sessions.start("subject-a");
    const b = await sessions.start("subject-b");
    expect(await sessions.endAllFor("subject-a")).toBe(2);
    expect(await rowOf(a1.id)).toBeUndefined();
    expect(await rowOf(a2.id)).toBeUndefined();
    expect(await rowOf(b.id)).toBeDefined();
    expect(await sessions.find(b.id)).toBeDefined();
    expect(await sessions.endAllFor("subject-a")).toBe(0);
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

  test("revokeAllFrom revokes every live token of one creator and no other", async () => {
    const tokens = createTokens({ store: dbTokenStore(db), log: () => {} });
    const a = await tokens.createToken("a1", { subject: "subject-a", name: null });
    const a2 = await tokens.createToken("a2", { subject: "subject-a", name: "A" });
    const b = await tokens.createToken("b", { subject: "subject-b", name: "B" });
    const none = await tokens.createToken("old");
    expect(await tokens.revokeAllFrom("subject-a")).toBe(2);
    expect(await tokens.authenticate(`Bearer ${a.token}`)).toBeUndefined();
    expect(await tokens.authenticate(`Bearer ${a2.token}`)).toBeUndefined();
    expect((await tokens.authenticate(`Bearer ${b.token}`))?.id).toBe(b.id);
    expect((await tokens.authenticate(`Bearer ${none.token}`))?.id).toBe(none.id);
    expect(await tokens.revokeAllFrom("subject-a")).toBe(0);
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
    expect(await tokens.revokeAllFrom(sub)).toBe(1);
  });

  test("a 256-character subject is refused at sign-in, and no session row is written", async () => {
    t.issuer.user = { ...t.issuer.user, sub: "w".repeat(256) };
    const run = await runLogin(t);
    expect(run.callback.statusCode).toBe(403);
    expect(run.sessionCookie).toBeUndefined();
    expect(await db.selectFrom("sessions").select("id").execute()).toEqual([]);
  });
});
