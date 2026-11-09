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
import { createHash } from "node:crypto";
import { access, appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Kysely, Transaction } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { DB } from "../../../src/db/types.js";
import { createInboxWatcher, POLL_MS } from "../../../src/inbox/watch.js";
import { createIngest, type IngestStore } from "../../../src/ingest/ingest.js";
import { StoreUnavailable } from "../../../src/storage/s3.js";
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

function watcherFor(ingest: Pick<ReturnType<typeof createIngest>, "ingestFile">) {
  return createInboxWatcher({
    dir: inbox,
    settleSeconds: SETTLE_SECONDS,
    ingest,
    // As the server wires it: the files repository answers both questions.
    storedFile: (id) => env.repos.files.get(id),
    findImported: (q) => env.repos.files.findImported(q),
    now,
    log: (line) => lines.push(line),
  });
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
    const watcher = watcherFor(createIngest({ db: env.db, store: flaky }));
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

    // The store comes back: the next poll imports it and deletes the copy.
    down = false;
    const next = await tick(watcher, 5);
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
    expect(first.waiting).toBe(true);
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
    expect(lost.waiting).toBe(true);
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
