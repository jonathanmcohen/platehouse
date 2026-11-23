// The memory budget counts INGEST_CONCURRENCY .3mf reads at ingest
// (test/compose-example.test.ts). The ingest queue works that many jobs at
// once, but the inbox watcher calls ingestFile directly, outside the queue,
// so the reads themselves take turns through one limit for the process:
// queue and inbox together never run more than INGEST_CONCURRENCY at once.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from "kysely";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

const reads = vi.hoisted(() => ({
  running: 0,
  peak: 0,
  started: 0,
  release: [] as Array<() => void>,
}));

vi.mock("@platehouse/threemf", async (importOriginal) => {
  const real = await importOriginal<typeof import("@platehouse/threemf")>();
  return {
    ...real,
    readProject: async () => {
      reads.running += 1;
      reads.started += 1;
      reads.peak = Math.max(reads.peak, reads.running);
      await new Promise<void>((resolve) => reads.release.push(resolve));
      reads.running -= 1;
      return null;
    },
  };
});

import type { DB } from "../../src/db/types.js";
import { createIngest, type IngestStore } from "../../src/ingest/ingest.js";
import { createReadLimit, INGEST_CONCURRENCY } from "../../src/ingest/read-limit.js";
import { INGEST_CONCURRENCY as QUEUE_CONCURRENCY } from "../../src/jobs/queues.js";

/** Lets every pending promise callback run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

function deferred(): { promise: Promise<void>; resolve(): void; reject(e: Error): void } {
  let resolve = (): void => undefined;
  let reject = (_e: Error): void => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createReadLimit", () => {
  test("with a limit of 2, a third task waits until one of the first two ends", async () => {
    const limit = createReadLimit(2);
    const gates = [deferred(), deferred(), deferred()];
    const started: number[] = [];
    const runs = gates.map((g, i) =>
      limit.run(async () => {
        started.push(i);
        await g.promise;
        return i;
      }),
    );
    await settle();
    expect(started).toEqual([0, 1]);
    gates[1]?.resolve();
    await expect(runs[1]).resolves.toBe(1);
    await settle();
    expect(started).toEqual([0, 1, 2]);
    gates[0]?.resolve();
    gates[2]?.resolve();
    await expect(Promise.all(runs)).resolves.toEqual([0, 1, 2]);
  });

  test("a task that fails frees its place", async () => {
    const limit = createReadLimit(1);
    const first = deferred();
    const one = limit.run(() => first.promise);
    let secondRan = false;
    const two = limit.run(async () => {
      secondRan = true;
    });
    await settle();
    expect(secondRan).toBe(false);
    first.reject(new Error("read failed"));
    await expect(one).rejects.toThrow("read failed");
    await two;
    expect(secondRan).toBe(true);
  });

  test("a task that throws before its promise frees its place too", async () => {
    const limit = createReadLimit(1);
    await expect(
      limit.run(() => {
        throw new Error("at once");
      }),
    ).rejects.toThrow("at once");
    await expect(limit.run(async () => "next")).resolves.toBe("next");
  });

  test("is the queue's concurrency", () => {
    expect(INGEST_CONCURRENCY).toBe(2);
    expect(QUEUE_CONCURRENCY).toBe(INGEST_CONCURRENCY);
  });
});

describe("ingestFile's .3mf reads", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "platehouse-read-limit-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A database that refuses every connection: each ingest fails after its read. */
  const refusing = (): Kysely<DB> =>
    new Kysely<DB>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => ({
          async init() {},
          async acquireConnection() {
            throw new Error("Connection refused");
          },
          async beginTransaction() {},
          async commitTransaction() {},
          async rollbackTransaction() {},
          async releaseConnection() {},
          async destroy() {},
        }),
        createIntrospector: (db) => new PostgresIntrospector(db),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
    });

  const store: IngestStore = {
    async putBlob(stream: Readable) {
      let size = 0;
      for await (const chunk of stream) size += (chunk as Uint8Array).length;
      return { sha256: Buffer.alloc(32), size };
    },
    async deleteBlobs() {},
  };

  test("take turns across every ingest in the process: a third waits for one of two", async () => {
    // Two ingest services, as the queue's worker and the inbox watcher could
    // each be given; the limit is the process's, not one service's.
    const queue = createIngest({ db: refusing(), store });
    const inbox = createIngest({ db: refusing(), store });
    const files = await Promise.all(
      [1, 2, 3].map(async (n) => {
        const path = join(dir, `upload-${n}.3mf`);
        await writeFile(path, Buffer.concat([Buffer.from("PK\u0003\u0004"), Buffer.alloc(64)]));
        return path;
      }),
    );
    const runs = [
      queue.ingestFile({ tmpPath: files[0] as string, originalName: "a.3mf", target: "new" }),
      queue.ingestFile({ tmpPath: files[1] as string, originalName: "b.3mf", target: "new" }),
      inbox.ingestFile({ tmpPath: files[2] as string, originalName: "c.3mf", target: "new" }),
    ].map((p) => p.catch(() => undefined));
    await settle();
    expect(reads.started).toBe(2);
    expect(reads.running).toBe(2);
    reads.release.shift()?.();
    await settle();
    expect(reads.started).toBe(3);
    expect(reads.running).toBe(2);
    for (const release of reads.release.splice(0)) release();
    await Promise.all(runs);
    expect(reads.peak).toBe(INGEST_CONCURRENCY);
  });
});
