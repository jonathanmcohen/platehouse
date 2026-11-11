// Build plan Task 15: sessions in the sessions table (Postgres 17). The store
// honours both expiries, a request moves the idle expiry on at most once per
// SESSION_TOUCH_MS, never past the absolute expiry, and a whole login through
// the app and the mock issuer leaves one row that logout deletes. A row's id
// is the base64url SHA-256 of the cookie value, never the cookie value, and
// the maintenance delete removes rows past either expiry and keeps live ones.
import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
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
});
