// Build plan Task 10: the inbox watcher (AC-021), over a real Postgres 17 and
// the S3 test server. A supported file placed in the inbox appears in the
// library with no manual step; once ingest has stored it and the stored size
// and SHA-256 match the inbox copy, the inbox copy is deleted. A file that
// fails moves to inbox/failed with a reason file beside it. A file still being
// copied in is never imported.
//
// The poll is driven by calling pollOnce() with an injected clock, so the
// 5-second polls and the 15-second settle window take no real time. Every
// file is built by the test suite; no designer file is read or committed.
import { createHash, randomBytes } from "node:crypto";
import { access, appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Kysely, sql, type Transaction } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createDb } from "../../../src/db/kysely.js";
import type { DB } from "../../../src/db/types.js";
import {
  BACKOFF_MAX_MS,
  createInboxWatcher,
  FAILED_DIR,
  type InboxProbes,
  inboxProbes,
  POLL_MS,
  REASON_SUFFIX,
  repeatedErrorReason,
  STRIKES,
} from "../../../src/inbox/watch.js";
import { createIngest, type IngestStore } from "../../../src/ingest/ingest.js";
import { createRepos } from "../../../src/repos/index.js";
import { createBlobStore, StoreError, StoreUnavailable } from "../../../src/storage/s3.js";
import { build3mf, footprint, type IngestEnv, startIngestEnv } from "../support/ingest.js";

let env: IngestEnv;
let inbox: string;
let clock: number;
const now = () => clock;
const lines: string[] = [];

const SETTLE_SECONDS = 15;

beforeAll(async () => {
  env = await startIngestEnv();
});

afterAll(async () => {
  await env?.stop();
});

beforeEach(async () => {
  inbox = join(env.dir, `inbox-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(inbox, { recursive: true });
  clock = 1_000_000;
  lines.length = 0;
});

function watcherFor(
  ingest: Pick<ReturnType<typeof createIngest>, "ingestFile">,
  extra: Partial<Parameters<typeof createInboxWatcher>[0]> = {},
) {
  return createInboxWatcher({
    dir: inbox,
    settleSeconds: SETTLE_SECONDS,
    ingest,
    // As the server wires it: the files repository answers both questions,
    // and the checks run against the same database and bucket.
    storedFile: (id) => env.repos.files.get(id),
    findImported: (q) => env.repos.files.findImported(q),
    probes: inboxProbes({ db: env.db, store: env.store }),
    now,
    log: (line) => lines.push(line),
    ...extra,
  });
}

/** Runs one statement as the superuser the env connects as. */
const asAdmin = (statement: string) => sql`${sql.raw(statement)}`.execute(env.db);

/**
 * A connection to the test database as a new login role. setup runs as the
 * superuser once the role exists, with the role's name, to grant or
 * configure it. The role's credential is random and lives only in this
 * throwaway container.
 */
async function connectAsRole(
  name: string,
  setup: (role: string) => Promise<void>,
): Promise<Kysely<DB>> {
  const credential = randomBytes(12).toString("hex");
  await asAdmin(`create role ${name} login password '${credential}'`);
  await setup(name);
  const url = new URL(env.url);
  url.username = name;
  url.password = credential;
  return createDb(url.toString());
}

/** Moves the injected clock on and runs one poll, as the 5-second timer would. */
async function tick(watcher: ReturnType<typeof createInboxWatcher>, seconds: number) {
  clock += seconds * 1000;
  return watcher.pollOnce();
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest();

/**
 * An ingest whose transaction commits and then loses its answer: the
 * connection drops before the answer comes, and the server cannot be asked
 * how the transaction ended. Ingest keeps the objects and throws the
 * connection error, which the watcher takes for a database outage.
 */
function answerLostIngest() {
  const answerLost = new Proxy(env.db, {
    get(target, prop) {
      if (prop === "transaction") {
        return () => {
          const real = env.db.transaction();
          return {
            execute: async (fn: (trx: Transaction<DB>) => Promise<unknown>) => {
              await real.execute(fn);
              throw new Error("Connection terminated unexpectedly");
            },
          };
        };
      }
      // commitState's status query is the only call made through this.
      if (prop === "getExecutor") {
        return () => {
          throw new Error("Connection refused");
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Kysely<DB>;
  return createIngest({ db: answerLost, store: env.store });
}

test("the watcher polls every 5 seconds", () => {
  expect(POLL_MS).toBe(5_000);
});

describe("settle window", () => {
  test("a file written in chunks with 5 s pauses is not imported until 15 s after the last write", async () => {
    const watcher = watcherFor(env.ingest);
    const bytes = build3mf({ plates: 2, sliced: [1] });
    const chunks = [
      bytes.subarray(0, 100),
      bytes.subarray(100, 300),
      bytes.subarray(300, 600),
      bytes.subarray(600),
    ];
    const path = join(inbox, "Slow copy.3mf");
    const before = await footprint(env);

    // One chunk, then a poll, every 5 seconds: the copy is still running.
    await writeFile(path, chunks[0] as Buffer);
    await watcher.pollOnce();
    for (const chunk of chunks.slice(1)) {
      clock += 5_000;
      await appendFile(path, chunk);
      await watcher.pollOnce();
      expect(await footprint(env)).toEqual(before);
    }
    // The last write was at this clock. 5 and 10 seconds later it is still
    // inside the settle window.
    await tick(watcher, 5);
    expect(await footprint(env)).toEqual(before);
    await tick(watcher, 5);
    expect(await footprint(env)).toEqual(before);
    expect(await exists(path)).toBe(true);

    // 15 seconds after the last write it is settled and imported.
    const pass = await tick(watcher, 5);
    expect(pass.imported).toHaveLength(1);
    const after = await footprint(env);
    expect(after.models).toBe(before.models + 1);
    expect(after.files).toBe(before.files + 1);
    const file = await env.repos.files.get(pass.imported[0]?.fileId ?? "");
    expect(file?.originalName).toBe("Slow copy.3mf");
    expect(file?.size).toBe(bytes.length);
    expect(file?.sha256.equals(sha256(bytes))).toBe(true);
    expect(await exists(path)).toBe(false);
  });
});

describe("import", () => {
  test("a settled .3mf appears as a model and the inbox copy is deleted", async () => {
    const watcher = watcherFor(env.ingest);
    const bytes = build3mf({ plates: 3, sliced: [1, 2] });
    const path = join(inbox, "Desk organiser.3mf");
    await writeFile(path, bytes);

    await watcher.pollOnce();
    expect(await exists(path)).toBe(true);
    const pass = await tick(watcher, SETTLE_SECONDS);

    expect(pass.imported).toHaveLength(1);
    const { modelId, fileId } = pass.imported[0] ?? { modelId: "", fileId: "" };
    const model = await env.repos.models.get(modelId);
    expect(model?.name).toBe("Desk organiser");
    const file = await env.repos.files.get(fileId);
    expect(file?.modelId).toBe(modelId);
    expect(file?.size).toBe(bytes.length);
    expect(file?.sha256.equals(sha256(bytes))).toBe(true);
    const plates = await env.db
      .selectFrom("plates")
      .select("index")
      .where("fileId", "=", fileId)
      .orderBy("index")
      .execute();
    expect(plates.map((p) => p.index)).toEqual([1, 2, 3]);

    // The bucket holds the bytes the inbox had.
    const blob = await env.db
      .selectFrom("blobs")
      .select("key")
      .where("id", "=", file?.blobId ?? "")
      .executeTakeFirstOrThrow();
    const chunks: Buffer[] = [];
    for await (const chunk of await env.store.getBlobStream(blob.key)) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).equals(bytes)).toBe(true);

    // The inbox copy is gone and nothing went to failed.
    expect(await exists(path)).toBe(false);
    expect(await exists(join(inbox, "failed"))).toBe(false);
    expect(await readdir(inbox)).toEqual([]);

    // A later poll imports nothing more.
    const again = await tick(watcher, SETTLE_SECONDS);
    expect(again.imported).toEqual([]);
  });
});

describe("failures", () => {
  test("a bad file moves to failed with a reason file", async () => {
    const watcher = watcherFor(env.ingest);
    const bytes = Buffer.from("this is not a zip archive, whatever its name says");
    const path = join(inbox, "Broken download.3mf");
    await writeFile(path, bytes);
    const before = await footprint(env);

    await watcher.pollOnce();
    const pass = await tick(watcher, SETTLE_SECONDS);

    expect(pass.failed).toHaveLength(1);
    expect(await footprint(env)).toEqual(before);
    expect(await exists(path)).toBe(false);
    const failed = join(inbox, "failed");
    expect((await readdir(failed)).sort()).toEqual([
      "Broken download.3mf",
      "Broken download.3mf.reason.txt",
    ]);
    // The file is moved, not rewritten.
    expect((await readFile(join(failed, "Broken download.3mf"))).equals(bytes)).toBe(true);
    const reason = await readFile(join(failed, "Broken download.3mf.reason.txt"), "utf8");
    expect(reason).toBe(
      "This file is not a supported .3mf, .stl, .step, .stp or .scad file; nothing was saved.\n",
    );

    // Never retried: later polls leave failed alone and import nothing.
    const later = await tick(watcher, SETTLE_SECONDS);
    expect(later.failed).toEqual([]);
    expect(later.imported).toEqual([]);
    expect((await readdir(failed)).length).toBe(2);
  });

  test("the store down leaves the inbox file in place for the next poll (not moved to failed)", async () => {
    let down = true;
    const flaky: IngestStore = {
      putBlob: async (stream, opts) => {
        if (down) {
          stream.resume();
          throw new StoreUnavailable("PutObject", "ECONNREFUSED");
        }
        return env.store.putBlob(stream, opts);
      },
      deleteBlobs: async (keys) => {
        if (down) throw new StoreUnavailable("DeleteObjects", "ECONNREFUSED");
        return env.store.deleteBlobs(keys);
      },
    };
    // The store check meets the same outage.
    const real = inboxProbes({ db: env.db, store: env.store });
    const probes: InboxProbes = {
      database: () => real.database(),
      store: async () => {
        if (down) throw new StoreUnavailable("ListObjectsV2", "ECONNREFUSED");
        return real.store();
      },
    };
    const watcher = watcherFor(createIngest({ db: env.db, store: flaky }), { probes });
    const bytes = build3mf({ plates: 1 });
    const path = join(inbox, "During the outage.3mf");
    await writeFile(path, bytes);
    const before = await footprint(env);

    await watcher.pollOnce();
    const pass = await tick(watcher, SETTLE_SECONDS);
    expect(pass.imported).toEqual([]);
    expect(pass.failed).toEqual([]);
    expect(pass.waiting).toBe(true);
    expect(await exists(path)).toBe(true);
    expect(await exists(join(inbox, "failed"))).toBe(false);
    expect(await footprint(env)).toEqual(before);
    expect(lines.some((l) => l.includes("Storage is unavailable right now"))).toBe(true);

    // Still down on the next poll: still in place.
    await tick(watcher, 5);
    expect(await exists(path)).toBe(true);
    expect(await exists(join(inbox, "failed"))).toBe(false);

    // The store comes back. The check at +5 s failed, so the next is due 10 s
    // later; that poll imports the file and deletes the copy.
    down = false;
    const next = await tick(watcher, 10);
    expect(next.imported).toHaveLength(1);
    expect(await exists(path)).toBe(false);
    expect((await footprint(env)).models).toBe(before.models + 1);
  });

  test("a commit that lands while its answer is lost is found on the retry, not made twice", async () => {
    const lossy = answerLostIngest();
    let calls = 0;
    const watcher = watcherFor({
      ingestFile: (input) => {
        calls += 1;
        return calls === 1 ? lossy.ingestFile(input) : env.ingest.ingestFile(input);
      },
    });
    const bytes = build3mf({ plates: 1 });
    const path = join(inbox, "Answer lost.3mf");
    await writeFile(path, bytes);
    const before = await footprint(env);

    await watcher.pollOnce();
    const first = await tick(watcher, SETTLE_SECONDS);
    // The database answers the check, so this counts as one failed try for
    // the file; it stays in the inbox for the retry.
    expect(first.failed).toEqual([]);
    expect(await exists(path)).toBe(true);
    expect((await footprint(env)).files).toBe(before.files + 1);

    const retry = await tick(watcher, 5);
    expect(calls).toBe(1);
    expect(retry.imported).toHaveLength(1);
    expect(retry.failed).toEqual([]);
    const after = await footprint(env);
    expect(after.models).toBe(before.models + 1);
    expect(after.files).toBe(before.files + 1);
    const file = await env.repos.files.get(retry.imported[0]?.fileId ?? "");
    expect(file?.originalName).toBe("Answer lost.3mf");
    expect(file?.sha256.equals(sha256(bytes))).toBe(true);
    expect(await exists(path)).toBe(false);
    expect(await exists(join(inbox, "failed"))).toBe(false);
  });

  test("a commit whose answer was lost before a restart is found by the next process, not made twice", async () => {
    // The first process meets the lost answer and stops, as on a container
    // recreate or a host reboot; a new watcher sees the file for the first
    // time, with nothing in memory from the first.
    const lossy = answerLostIngest();
    const bytes = build3mf({ plates: 1 });
    const path = join(inbox, "Before a restart.3mf");
    await writeFile(path, bytes);
    const before = await footprint(env);

    const first = watcherFor(lossy);
    await first.pollOnce();
    const lost = await tick(first, SETTLE_SECONDS);
    expect(lost.failed).toEqual([]);
    expect(await exists(path)).toBe(true);
    expect((await footprint(env)).files).toBe(before.files + 1);
    await first.stop();

    let calls = 0;
    const second = watcherFor({
      ingestFile: (input) => {
        calls += 1;
        return env.ingest.ingestFile(input);
      },
    });
    await second.pollOnce();
    const pass = await tick(second, SETTLE_SECONDS);
    expect(calls).toBe(0);
    expect(pass.imported).toHaveLength(1);
    expect(pass.failed).toEqual([]);
    const after = await footprint(env);
    expect(after.models).toBe(before.models + 1);
    expect(after.files).toBe(before.files + 1);
    const file = await env.repos.files.get(pass.imported[0]?.fileId ?? "");
    expect(file?.originalName).toBe("Before a restart.3mf");
    expect(await exists(path)).toBe(false);
  });

  test("ignored names are never imported or moved", async () => {
    const watcher = watcherFor(env.ingest);
    const names = [".hidden.3mf", "Download.3mf.part", "Download.3mf.crdownload", "Copy.stl.tmp"];
    for (const name of names) await writeFile(join(inbox, name), build3mf({ plates: 1 }));
    const before = await footprint(env);

    await watcher.pollOnce();
    await tick(watcher, SETTLE_SECONDS);
    await tick(watcher, SETTLE_SECONDS);

    expect(await footprint(env)).toEqual(before);
    expect((await readdir(inbox)).sort()).toEqual([...names].sort());
    await rm(inbox, { recursive: true, force: true });
  });
});

describe("telling a bad file from an outage", () => {
  test("a database role with no grant on files (42501) moves no file to failed, and the inbox waits", async () => {
    const noGrant = await connectAsRole("inbox_no_grant", async (role) => {
      await asAdmin(`grant usage on schema public to ${role}`);
    });
    try {
      let broken = true;
      const healthy = inboxProbes({ db: env.db, store: env.store });
      const denied = inboxProbes({ db: noGrant, store: env.store });
      const deniedRepos = createRepos(noGrant);
      const watcher = watcherFor(env.ingest, {
        findImported: (q) => (broken ? deniedRepos : env.repos).files.findImported(q),
        probes: {
          database: () => (broken ? denied : healthy).database(),
          store: () => (broken ? denied : healthy).store(),
        },
      });
      await writeFile(join(inbox, "A grant missing.3mf"), build3mf({ plates: 1 }));
      await writeFile(join(inbox, "B grant missing.3mf"), build3mf({ plates: 2 }));
      const before = await footprint(env);

      await watcher.pollOnce();
      const pass = await tick(watcher, SETTLE_SECONDS);
      expect(pass.waiting).toBe(true);
      expect(pass.failed).toEqual([]);
      for (let i = 0; i < 10; i += 1) {
        const later = await tick(watcher, 5);
        expect(later.failed).toEqual([]);
      }
      expect(await exists(join(inbox, FAILED_DIR))).toBe(false);
      expect((await readdir(inbox)).sort()).toEqual(["A grant missing.3mf", "B grant missing.3mf"]);
      expect(await footprint(env)).toEqual(before);
      expect(lines.filter((l) => l.includes("not answering"))).toHaveLength(1);

      // The grant is fixed: once the backoff has passed, both import.
      broken = false;
      const back = await tick(watcher, BACKOFF_MAX_MS / 1000);
      expect(back.imported.map((i) => i.name)).toEqual([
        "A grant missing.3mf",
        "B grant missing.3mf",
      ]);
      expect(await readdir(inbox)).toEqual([]);
      expect(lines.filter((l) => l.includes("importing again"))).toHaveLength(1);
    } finally {
      await noGrant.destroy();
    }
  });

  test("a database in read-only mode (25006) moves no file to failed, and nothing is uploaded again while it lasts", async () => {
    const readOnly = await connectAsRole("inbox_read_only", async (role) => {
      await asAdmin(`grant usage on schema public to ${role}`);
      await asAdmin(
        `grant select, insert, update, delete on all tables in schema public to ${role}`,
      );
      await asAdmin(`grant usage, select on all sequences in schema public to ${role}`);
      // As after a failover to a standby, or with default_transaction_read_only set.
      await asAdmin(`alter role ${role} set default_transaction_read_only = on`);
    });
    try {
      let uploads = 0;
      const counting: IngestStore = {
        putBlob: (stream, opts) => {
          uploads += 1;
          return env.store.putBlob(stream, opts);
        },
        deleteBlobs: (keys) => env.store.deleteBlobs(keys),
      };
      const roRepos = createRepos(readOnly);
      const watcher = watcherFor(createIngest({ db: readOnly, store: counting }), {
        findImported: (q) => roRepos.files.findImported(q),
        probes: inboxProbes({ db: readOnly, store: env.store }),
      });
      await writeFile(join(inbox, "A read only.3mf"), build3mf({ plates: 1 }));
      await writeFile(join(inbox, "B read only.3mf"), build3mf({ plates: 1 }));
      const before = await footprint(env);

      await watcher.pollOnce();
      const pass = await tick(watcher, SETTLE_SECONDS);
      expect(pass.waiting).toBe(true);
      expect(pass.failed).toEqual([]);
      const afterFirst = uploads;
      // Ten minutes of polls: no file goes to failed and nothing is uploaded
      // again while the database stays read-only.
      for (let i = 0; i < 120; i += 1) await tick(watcher, 5);
      expect(uploads).toBe(afterFirst);
      expect(await exists(join(inbox, FAILED_DIR))).toBe(false);
      expect((await readdir(inbox)).sort()).toEqual(["A read only.3mf", "B read only.3mf"]);
      expect((await footprint(env)).models).toBe(before.models);
    } finally {
      await readOnly.destroy();
    }
  });

  test("a store that takes the upload, then refuses it and refuses the check, gets the file uploaded once, not on every poll", async () => {
    // A write-only bucket policy (s3:PutObject only): the body is stored,
    // the size check (HeadObject) is denied, and so is the listing the
    // store check makes.
    let broken = true;
    // Uploads of the file itself; a good import also puts its plate thumbnail.
    let uploads = 0;
    const writeOnly: IngestStore = {
      putBlob: async (stream, opts) => {
        if (opts.contentType === "model/3mf") uploads += 1;
        const stored = await env.store.putBlob(stream, opts);
        if (broken) throw new StoreError("HeadObject", "AccessDenied", 403);
        return stored;
      },
      deleteBlobs: (keys) => env.store.deleteBlobs(keys),
    };
    const real = inboxProbes({ db: env.db, store: env.store });
    const watcher = watcherFor(createIngest({ db: env.db, store: writeOnly }), {
      probes: {
        database: () => real.database(),
        store: async () => {
          if (broken) throw new StoreError("ListObjectsV2", "AccessDenied", 403);
          return real.store();
        },
      },
    });
    const path = join(inbox, "Write only.3mf");
    await writeFile(path, build3mf({ plates: 1 }));

    await watcher.pollOnce();
    const pass = await tick(watcher, SETTLE_SECONDS);
    expect(pass.waiting).toBe(true);
    expect(uploads).toBe(1);
    for (let i = 0; i < 120; i += 1) await tick(watcher, 5);
    expect(uploads).toBe(1);
    expect(await exists(path)).toBe(true);
    expect(await exists(join(inbox, FAILED_DIR))).toBe(false);

    broken = false;
    const back = await tick(watcher, BACKOFF_MAX_MS / 1000);
    expect(back.imported).toHaveLength(1);
    expect(uploads).toBe(2);
    expect(await exists(path)).toBe(false);
  });

  test(`with storage and the database answering, a file that fails ${STRIKES} times moves to failed with the error, and the file after it still imports`, async () => {
    const boom = new TypeError("boom in a parser nobody expected");
    const watcher = watcherFor({
      ingestFile: (input) => {
        if (input.originalName === "A fails.3mf") return Promise.reject(boom);
        return env.ingest.ingestFile(input);
      },
    });
    const bad = join(inbox, "A fails.3mf");
    await writeFile(bad, build3mf({ plates: 1 }));
    await writeFile(join(inbox, "B imports.3mf"), build3mf({ plates: 1 }));

    await watcher.pollOnce();
    const first = await tick(watcher, SETTLE_SECONDS);
    expect(first.waiting).toBe(false);
    expect(first.failed).toEqual([]);
    // The file after it imports in the same pass.
    expect(first.imported.map((i) => i.name)).toEqual(["B imports.3mf"]);
    expect(await exists(bad)).toBe(true);

    const second = await tick(watcher, 5);
    expect(second.failed).toEqual([]);
    expect(await exists(bad)).toBe(true);

    const third = await tick(watcher, 5);
    const reason = repeatedErrorReason(boom);
    expect(third.failed).toEqual([{ name: "A fails.3mf", reason }]);
    expect(await readFile(join(inbox, FAILED_DIR, `A fails.3mf${REASON_SUFFIX}`), "utf8")).toBe(
      `${reason}\n`,
    );
    expect(reason).toContain("boom in a parser nobody expected");
    expect(await readdir(inbox)).toEqual([FAILED_DIR]);
  });

  test("the server's checks pass against a database and a bucket that answer", async () => {
    const probes = inboxProbes({ db: env.db, store: env.store });
    await expect(probes.database()).resolves.toBeUndefined();
    await expect(probes.store()).resolves.toBeUndefined();
  });
});

describe("the checks write", () => {
  // A write fault that leaves reads working: the data disk full (53100), a
  // write-side I/O error, a tablespace on a filesystem gone read-only. The
  // role keeps its grants and the session is not read-only, so a check that
  // only reads passes. A trigger stands in for the fault: it fails every
  // insert into one table with the SQLSTATE a full disk gives.
  async function failWrites(table: string): Promise<() => Promise<void>> {
    await asAdmin(
      "create or replace function inbox_test_disk_full() returns trigger language plpgsql as " +
        "$$ begin raise exception 'could not extend file: No space left on device' " +
        "using errcode = '53100'; end $$",
    );
    await asAdmin(
      `create trigger inbox_test_disk_full before insert on ${table} ` +
        "for each row execute function inbox_test_disk_full()",
    );
    return async () => {
      await asAdmin(`drop trigger if exists inbox_test_disk_full on ${table}`);
    };
  }

  test.each(["models", "blobs", "files"])(
    "the database check fails when an insert into %s fails, though reads work",
    async (table) => {
      const restore = await failWrites(table);
      try {
        const probes = inboxProbes({ db: env.db, store: env.store });
        await expect(probes.database()).rejects.toThrow(/No space left on device/);
      } finally {
        await restore();
      }
    },
  );

  test("the database check leaves no row behind", async () => {
    const before = await footprint(env);
    const probes = inboxProbes({ db: env.db, store: env.store });
    for (let i = 0; i < 3; i += 1) await probes.database();
    expect(await footprint(env)).toEqual(before);
  });

  test("a database that reads but cannot write moves no file to failed, and the inbox waits until it can", async () => {
    const restore = await failWrites("files");
    let restored = false;
    try {
      const watcher = watcherFor(env.ingest);
      await writeFile(join(inbox, "A disk full.3mf"), build3mf({ plates: 1 }));
      await writeFile(join(inbox, "B disk full.3mf"), build3mf({ plates: 2 }));
      const before = await footprint(env);

      await watcher.pollOnce();
      const pass = await tick(watcher, SETTLE_SECONDS);
      expect(pass.waiting).toBe(true);
      expect(pass.failed).toEqual([]);
      // Half an hour of polls: past the point where held tries would count.
      for (let i = 0; i < 360; i += 1) {
        const later = await tick(watcher, 5);
        expect(later.failed).toEqual([]);
      }
      expect(await exists(join(inbox, FAILED_DIR))).toBe(false);
      expect((await readdir(inbox)).sort()).toEqual(["A disk full.3mf", "B disk full.3mf"]);
      expect(await footprint(env)).toEqual(before);
      // Seen as an outage by the checks, not guessed from two files failing.
      const started = lines.filter((l) => l.includes("not answering"));
      expect(started).toHaveLength(1);
      expect(started[0]).toContain("No space left on device");
      expect(lines.filter((l) => l.includes("the checks cannot see"))).toEqual([]);

      await restore();
      restored = true;
      const back = await tick(watcher, BACKOFF_MAX_MS / 1000);
      expect(back.imported.map((i) => i.name)).toEqual(["A disk full.3mf", "B disk full.3mf"]);
      expect(await readdir(inbox)).toEqual([]);
    } finally {
      if (!restored) await restore();
    }
  });

  /** The store's write check (s3.ts), or a rejection while it has none. */
  const checkWrite = (store: unknown): Promise<unknown> => {
    const check = (store as { checkWrite?: () => Promise<unknown> }).checkWrite;
    return check === undefined
      ? Promise.reject(new Error("the store has no write check"))
      : check.call(store);
  };

  test("the store's write check passes on a bucket that takes writes, and leaves nothing behind", async () => {
    const before = await env.store.listPrefix("");
    await expect(checkWrite(env.store)).resolves.toBeUndefined();
    await expect(checkWrite(env.store)).resolves.toBeUndefined();
    // Nothing is left anywhere in the bucket, models/ included.
    expect(await env.store.listPrefix("")).toEqual(before);
  });

  test("the store's write check fails as StoreUnavailable when the store does not answer", async () => {
    const dead = createBlobStore(
      {
        endpoint: "http://127.0.0.1:9",
        region: "us-east-1",
        bucket: "platehouse-nowhere",
        accessKeyId: "test-only-key-id",
        secretAccessKey: "test-only-secret",
        forcePathStyle: true,
      },
      { maxAttempts: 1, connectionTimeoutMs: 1_000 },
    );
    try {
      await expect(checkWrite(dead)).rejects.toBeInstanceOf(StoreUnavailable);
    } finally {
      dead.destroy();
    }
  });
});
