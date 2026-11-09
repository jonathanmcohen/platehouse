// Build plan Task 10: the inbox watcher's own rules, with a fake ingest so no
// database or bucket is needed (the real pipeline is under
// test/integration/inbox/). These pin what the integration tests cannot reach
// cheaply: the exact settle boundary, every ignored name, the failed-folder
// names, and the paths that must never loop (a file that cannot be moved, an
// inbox copy that cannot be deleted) or lose a file without a word.
import { createHash } from "node:crypto";
import {
  access,
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  CHANGED_REASON,
  createInboxWatcher,
  FAILED_DIR,
  type ImportedQuery,
  inboxName,
  isIgnoredName,
  NON_UTF8_REASON,
  REASON_SUFFIX,
  UNCONFIRMED_REASON,
  UNEXPECTED_REASON,
} from "../../src/inbox/watch.js";
import { IngestError, type IngestInput } from "../../src/ingest/ingest.js";
import { StoreError } from "../../src/storage/s3.js";

let root: string;
let inbox: string;
let clock: number;
let lines: string[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "platehouse-inbox-"));
  inbox = join(root, "inbox");
  await mkdir(inbox);
  clock = 5_000_000;
  lines = [];
});

afterEach(async () => {
  await chmod(inbox, 0o755).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest();

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

type Behaviour = (input: IngestInput) => Promise<void> | void;

/**
 * An ingest that records each call and, unless told otherwise, "stores" the
 * file: it reads the bytes and remembers their size and SHA-256 under a new
 * file id, as ingestFile does.
 */
function fakeIngest(behaviour: Behaviour = () => undefined) {
  const calls: string[] = [];
  const stored = new Map<string, { size: number; sha256: Buffer }>();
  let n = 0;
  return {
    calls,
    stored,
    ingest: {
      async ingestFile(input: IngestInput) {
        calls.push(input.originalName);
        expect(input.target).toBe("new");
        await behaviour(input);
        const bytes = await readFile(input.tmpPath);
        n += 1;
        const fileId = `file-${n}`;
        stored.set(fileId, { size: bytes.length, sha256: sha256(bytes) });
        return { modelId: `model-${n}`, fileId };
      },
    },
  };
}

/** The fake's stored file with this size and SHA-256, as files.findImported finds a row. */
function storedMatch(fake: ReturnType<typeof fakeIngest>, file: ImportedQuery) {
  for (const [fileId, stored] of fake.stored) {
    if (stored.size === file.size && stored.sha256.equals(file.sha256)) {
      return { modelId: `model-${fileId.slice(5)}`, fileId };
    }
  }
  return undefined;
}

function watcher(
  fake: ReturnType<typeof fakeIngest>,
  extra: Partial<Parameters<typeof createInboxWatcher>[0]> = {},
) {
  return createInboxWatcher({
    dir: inbox,
    settleSeconds: 15,
    ingest: fake.ingest,
    storedFile: async (id) => fake.stored.get(id),
    findImported: async () => undefined,
    // Storage and the database answer unless a test says otherwise.
    probes: { database: async () => undefined, store: async () => undefined },
    now: () => clock,
    log: (line) => lines.push(line),
    ...extra,
  });
}

async function tick(w: ReturnType<typeof createInboxWatcher>, ms: number) {
  clock += ms;
  return w.pollOnce();
}

describe("settle window", () => {
  test("a file is imported once it has been unchanged for the whole window, not a millisecond before", async () => {
    const fake = fakeIngest();
    const w = watcher(fake);
    await writeFile(join(inbox, "cube.stl"), "solid cube\nendsolid cube\n");

    await w.pollOnce();
    await tick(w, 5_000);
    await tick(w, 9_999);
    expect(fake.calls).toEqual([]);
    const pass = await tick(w, 1);
    expect(fake.calls).toEqual(["cube.stl"]);
    expect(pass.imported).toEqual([{ name: "cube.stl", modelId: "model-1", fileId: "file-1" }]);
    expect(await exists(join(inbox, "cube.stl"))).toBe(false);
  });

  test("the window is INBOX_SETTLE_SECONDS, whatever it is set to", async () => {
    const fake = fakeIngest();
    const w = watcher(fake, { settleSeconds: 40 });
    await writeFile(join(inbox, "cube.stl"), "solid cube\nendsolid cube\n");
    await w.pollOnce();
    await tick(w, 39_999);
    expect(fake.calls).toEqual([]);
    await tick(w, 1);
    expect(fake.calls).toEqual(["cube.stl"]);
  });

  test("growth restarts the window", async () => {
    const fake = fakeIngest();
    const w = watcher(fake);
    const path = join(inbox, "slow.stl");
    await writeFile(path, "solid a\n");
    await w.pollOnce();
    await tick(w, 14_000);
    await appendFile(path, "endsolid a\n");
    await tick(w, 1_000);
    await tick(w, 14_999);
    expect(fake.calls).toEqual([]);
    await tick(w, 1);
    expect(fake.calls).toEqual(["slow.stl"]);
  });

  test("a new mtime with the same size restarts the window", async () => {
    const fake = fakeIngest();
    const w = watcher(fake);
    const path = join(inbox, "touched.stl");
    await writeFile(path, "solid a\nendsolid a\n");
    await utimes(path, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
    await w.pollOnce();
    await tick(w, 10_000);
    await utimes(path, new Date("2026-01-02T00:00:00Z"), new Date("2026-01-02T00:00:00Z"));
    await tick(w, 5_000);
    await tick(w, 14_999);
    expect(fake.calls).toEqual([]);
    await tick(w, 1);
    expect(fake.calls).toEqual(["touched.stl"]);
  });

  test("a slow import earlier in a pass does not shorten the window of a file first seen after it", async () => {
    // a.stl takes 40 s to import. b.stl is first seen in the same pass, after
    // that import, so its window starts then, not when the pass began.
    const fake = fakeIngest((input) => {
      if (input.originalName === "a.stl") clock += 40_000;
    });
    const w = watcher(fake);
    await writeFile(join(inbox, "a.stl"), "solid a\nendsolid a\n");
    await w.pollOnce();
    await writeFile(join(inbox, "b.stl"), "solid b\nendsolid b\n");
    await tick(w, 15_000);
    expect(fake.calls).toEqual(["a.stl"]);

    await tick(w, 5_000);
    await tick(w, 9_999);
    expect(fake.calls).toEqual(["a.stl"]);
    await tick(w, 1);
    expect(fake.calls).toEqual(["a.stl", "b.stl"]);
  });

  test("an old mtime does not count as settled: the window starts when the watcher first sees the file", async () => {
    const fake = fakeIngest();
    const w = watcher(fake);
    const path = join(inbox, "rsync-copy.stl");
    await writeFile(path, "solid a\nendsolid a\n");
    // A copy that keeps the source's mtime (rsync -t, cp -p) looks old at once.
    await utimes(path, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
    await w.pollOnce();
    expect(fake.calls).toEqual([]);
    await tick(w, 15_000);
    expect(fake.calls).toEqual(["rsync-copy.stl"]);
  });
});

describe("ignored names", () => {
  test.each([
    [".hidden.3mf", true],
    [".DS_Store", true],
    ["model.3mf.part", true],
    ["model.3mf.PART", true],
    ["model.3mf.crdownload", true],
    ["model.3mf.CRDOWNLOAD", true],
    ["model.stl.tmp", true],
    ["model.stl.Tmp", true],
    ["model.3mf", false],
    ["part.stl", false],
    ["tmp.scad", false],
    ["model.partial.3mf", false],
  ])("%s ignored: %s", (name, ignored) => {
    expect(isIgnoredName(name)).toBe(ignored);
  });

  test("ignored files, folders and symlinks are never imported or moved", async () => {
    const fake = fakeIngest();
    const w = watcher(fake);
    const names = [".hidden.stl", "a.stl.part", "b.stl.crdownload", "c.stl.tmp"];
    for (const name of names) await writeFile(join(inbox, name), "solid a\nendsolid a\n");
    await mkdir(join(inbox, "a folder.stl"));
    await writeFile(join(root, "outside.stl"), "solid outside\nendsolid outside\n");
    await symlink(join(root, "outside.stl"), join(inbox, "link.stl"));

    await w.pollOnce();
    await tick(w, 15_000);
    await tick(w, 15_000);

    expect(fake.calls).toEqual([]);
    expect((await readdir(inbox)).sort()).toEqual([...names, "a folder.stl", "link.stl"].sort());
    expect(await exists(join(root, "outside.stl"))).toBe(true);
  });

  test("the failed folder itself is never scanned", async () => {
    const fake = fakeIngest();
    const w = watcher(fake);
    await mkdir(join(inbox, FAILED_DIR));
    await writeFile(join(inbox, FAILED_DIR, "old.stl"), "solid a\nendsolid a\n");
    await w.pollOnce();
    await tick(w, 15_000);
    expect(fake.calls).toEqual([]);
    expect(await readdir(join(inbox, FAILED_DIR))).toEqual(["old.stl"]);
  });
});

describe("after ingest", () => {
  test("the inbox copy is deleted only when the stored size and SHA-256 match it", async () => {
    const fake = fakeIngest();
    const w = watcher(fake);
    await writeFile(join(inbox, "good.stl"), "solid good\nendsolid good\n");
    await w.pollOnce();
    await tick(w, 15_000);
    expect(await exists(join(inbox, "good.stl"))).toBe(false);
    expect(await exists(join(inbox, FAILED_DIR))).toBe(false);
  });

  test("a file that changed while it was imported is kept in failed, with a reason, and not imported again", async () => {
    const fake = fakeIngest();
    // Ingest stores the bytes it read, then something appends to the inbox
    // copy before the watcher checks it.
    const ingest = {
      async ingestFile(input: IngestInput) {
        const result = await fake.ingest.ingestFile(input);
        await appendFile(input.tmpPath, "more bytes\n");
        return result;
      },
    };
    const w = watcher(fake, { ingest });
    await writeFile(join(inbox, "changing.stl"), "solid a\nendsolid a\n");
    await w.pollOnce();
    const pass = await tick(w, 15_000);

    expect(pass.failed).toEqual([{ name: "changing.stl", reason: CHANGED_REASON }]);
    expect(await exists(join(inbox, "changing.stl"))).toBe(false);
    expect(await readFile(join(inbox, FAILED_DIR, `changing.stl${REASON_SUFFIX}`), "utf8")).toBe(
      `${CHANGED_REASON}\n`,
    );
    await tick(w, 15_000);
    expect(fake.calls).toEqual(["changing.stl"]);
  });

  test.each([
    ["no record", async () => undefined],
    [
      "a lookup that fails",
      async () => {
        throw new Error("connection terminated");
      },
    ],
  ])(
    "an import that cannot be confirmed (%s) is kept in failed, not deleted",
    async (_l, lookup) => {
      const fake = fakeIngest();
      const w = watcher(fake, { storedFile: lookup });
      await writeFile(join(inbox, "unconfirmed.stl"), "solid a\nendsolid a\n");
      await w.pollOnce();
      const pass = await tick(w, 15_000);
      expect(pass.failed).toEqual([{ name: "unconfirmed.stl", reason: UNCONFIRMED_REASON }]);
      expect(await exists(join(inbox, FAILED_DIR, "unconfirmed.stl"))).toBe(true);
      await tick(w, 15_000);
      expect(fake.calls).toEqual(["unconfirmed.stl"]);
    },
  );

  test("an inbox copy that cannot be deleted is not imported again", async () => {
    if (process.getuid?.() === 0) {
      // Root ignores the folder's mode, so the unlink cannot be made to fail.
      return;
    }
    const fake = fakeIngest(async () => {
      await chmod(inbox, 0o555);
    });
    const w = watcher(fake);
    await writeFile(join(inbox, "stuck.stl"), "solid a\nendsolid a\n");
    await w.pollOnce();
    const pass = await tick(w, 15_000);
    expect(pass.imported).toHaveLength(1);
    expect(await exists(join(inbox, "stuck.stl"))).toBe(true);
    expect(lines.some((l) => l.includes("stuck.stl") && l.includes("could not delete"))).toBe(true);
    await tick(w, 15_000);
    await tick(w, 15_000);
    expect(fake.calls).toEqual(["stuck.stl"]);
  });
});

describe("failures", () => {
  test("a refused file moves to failed with the refusal as its reason", async () => {
    const fake = fakeIngest(() => {
      throw new IngestError(
        "unsupported_type",
        "This file is not a supported .3mf, .stl, .step, .stp or .scad file; nothing was saved",
      );
    });
    const w = watcher(fake);
    await writeFile(join(inbox, "notes.txt"), "not a model\n");
    await w.pollOnce();
    const pass = await tick(w, 15_000);
    const reason =
      "This file is not a supported .3mf, .stl, .step, .stp or .scad file; nothing was saved.";
    expect(pass.failed).toEqual([{ name: "notes.txt", reason }]);
    expect(await readFile(join(inbox, FAILED_DIR, "notes.txt"), "utf8")).toBe("not a model\n");
    expect(await readFile(join(inbox, FAILED_DIR, `notes.txt${REASON_SUFFIX}`), "utf8")).toBe(
      `${reason}\n`,
    );
  });

  test("an unexpected error moves the file to failed with a plain reason and logs the error", async () => {
    const fake = fakeIngest(() => {
      throw new TypeError("boom in the parser");
    });
    const w = watcher(fake);
    await writeFile(join(inbox, "odd.stl"), "solid a\nendsolid a\n");
    await w.pollOnce();
    const pass = await tick(w, 15_000);
    expect(pass.failed).toEqual([{ name: "odd.stl", reason: UNEXPECTED_REASON }]);
    expect(lines.some((l) => l.includes("odd.stl") && l.includes("boom in the parser"))).toBe(true);
    await tick(w, 15_000);
    expect(fake.calls).toEqual(["odd.stl"]);
  });

  test("names in failed never collide: (2), (3) and so on, reason files beside each", async () => {
    let attempt = 0;
    const fake = fakeIngest(() => {
      attempt += 1;
      throw new IngestError("unsupported_type", `Refused ${attempt}`);
    });
    const w = watcher(fake);
    for (let i = 1; i <= 3; i += 1) {
      await writeFile(join(inbox, "bad.3mf"), `copy ${i}\n`);
      await tick(w, 1);
      await tick(w, 15_000);
    }
    const failed = join(inbox, FAILED_DIR);
    expect((await readdir(failed)).sort()).toEqual(
      [
        "bad (2).3mf",
        `bad (2).3mf${REASON_SUFFIX}`,
        "bad (3).3mf",
        `bad (3).3mf${REASON_SUFFIX}`,
        "bad.3mf",
        `bad.3mf${REASON_SUFFIX}`,
      ].sort(),
    );
    expect(await readFile(join(failed, "bad (3).3mf"), "utf8")).toBe("copy 3\n");
    expect(await readFile(join(failed, `bad (3).3mf${REASON_SUFFIX}`), "utf8")).toBe(
      "Refused 3.\n",
    );
  });

  test("a long name still fits in failed with its reason file", async () => {
    const fake = fakeIngest(() => {
      throw new IngestError("unsupported_type", "Refused");
    });
    const w = watcher(fake);
    // 246 bytes of name: a reason file beside it would be 257 bytes, over the
    // 255-byte limit of ext4 and APFS.
    // e-acute, two bytes in UTF-8, written by code point to keep this file ASCII.
    const name = `${String.fromCharCode(0xe9).repeat(120)}ab.3mf`;
    expect(Buffer.byteLength(name)).toBe(246);
    await writeFile(join(inbox, name), "x\n");
    await w.pollOnce();
    await tick(w, 15_000);
    const failed = await readdir(join(inbox, FAILED_DIR));
    expect(failed).toHaveLength(2);
    for (const entry of failed) expect(Buffer.byteLength(entry)).toBeLessThanOrEqual(255);
    const moved = failed.find((f) => !f.endsWith(REASON_SUFFIX)) ?? "";
    expect(moved.endsWith(".3mf")).toBe(true);
    expect(failed).toContain(`${moved}${REASON_SUFFIX}`);
    expect(await readFile(join(inbox, FAILED_DIR, moved), "utf8")).toBe("x\n");
  });

  test("a file that cannot be moved to failed stays put, is logged, and is not retried until it changes", async () => {
    const fake = fakeIngest(() => {
      throw new IngestError("unsupported_type", "Refused");
    });
    const w = watcher(fake);
    // A plain file where the failed folder should be: nothing can move into it.
    await writeFile(join(inbox, FAILED_DIR), "in the way\n");
    const path = join(inbox, "bad.stl");
    await writeFile(path, "one\n");
    await w.pollOnce();
    await tick(w, 15_000);
    expect(await exists(path)).toBe(true);
    expect(lines.some((l) => l.includes("bad.stl") && l.includes("could not move"))).toBe(true);
    await tick(w, 15_000);
    await tick(w, 15_000);
    expect(fake.calls).toEqual(["bad.stl"]);

    // A new copy under the same name is a new file and gets its own try.
    await writeFile(path, "two, longer\n");
    await tick(w, 5_000);
    await tick(w, 15_000);
    expect(fake.calls).toEqual(["bad.stl", "bad.stl"]);
  });
});

describe("outages", () => {
  test("storage unavailable leaves the file in place, stops the pass, and logs once until it recovers", async () => {
    let down = true;
    const fake = fakeIngest(() => {
      if (down) {
        throw new IngestError(
          "storage_unavailable",
          "Storage is unavailable right now; nothing was saved",
        );
      }
    });
    const w = watcher(fake);
    await writeFile(join(inbox, "a.stl"), "solid a\nendsolid a\n");
    await writeFile(join(inbox, "b.stl"), "solid b\nendsolid b\n");
    await w.pollOnce();
    const pass = await tick(w, 15_000);

    expect(pass.waiting).toBe(true);
    expect(pass.failed).toEqual([]);
    // The pass stopped at the first file: the outage is not per file.
    expect(fake.calls).toHaveLength(1);
    expect(await exists(join(inbox, "a.stl"))).toBe(true);
    expect(await exists(join(inbox, "b.stl"))).toBe(true);
    expect(await exists(join(inbox, FAILED_DIR))).toBe(false);

    await tick(w, 5_000);
    await tick(w, 5_000);
    const outageLines = lines.filter((l) => l.includes("Storage is unavailable"));
    expect(outageLines).toHaveLength(1);

    down = false;
    const back = await tick(w, 5_000);
    expect(back.waiting).toBe(false);
    expect(back.imported.map((i) => i.name).sort()).toEqual(["a.stl", "b.stl"]);
    expect(lines.some((l) => l.includes("importing again"))).toBe(true);
    expect(await readdir(inbox)).toEqual([]);
  });

  test.each([
    [
      "a refused connection",
      Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    ],
    [
      "a connection exception (SQLSTATE 08006)",
      Object.assign(new Error("lost"), { code: "08006" }),
    ],
    [
      "a database shutting down (57P01)",
      Object.assign(new Error("terminating"), { code: "57P01" }),
    ],
    ["a database starting up (57P03)", Object.assign(new Error("starting up"), { code: "57P03" })],
    ["too many connections (53300)", Object.assign(new Error("too many"), { code: "53300" })],
    ["a pool timeout", new Error("timeout exceeded when trying to connect")],
    ["a closed connection", new Error("Connection terminated unexpectedly")],
  ])("a database outage (%s) leaves the file in place", async (_label, error) => {
    let down = true;
    const fake = fakeIngest(() => {
      if (down) throw error;
    });
    const w = watcher(fake);
    await writeFile(join(inbox, "a.stl"), "solid a\nendsolid a\n");
    await w.pollOnce();
    const pass = await tick(w, 15_000);
    expect(pass.waiting).toBe(true);
    expect(pass.failed).toEqual([]);
    expect(await exists(join(inbox, "a.stl"))).toBe(true);
    expect(await exists(join(inbox, FAILED_DIR))).toBe(false);
    down = false;
    await tick(w, 5_000);
    expect(await exists(join(inbox, "a.stl"))).toBe(false);
  });

  // A fault in the environment, not the file: every file would meet it, so
  // none may go to failed for it (a broken store would empty the inbox).
  test.each([
    [
      "storage refusing access (AccessDenied, HTTP 403)",
      new StoreError("PutObject", "AccessDenied", 403),
    ],
    ["a missing bucket (NoSuchBucket, HTTP 404)", new StoreError("PutObject", "NoSuchBucket", 404)],
    ["a storage server error (HTTP 500)", new StoreError("PutObject", "InternalError", 500)],
    ["a full storage server (HTTP 507)", new StoreError("PutObject", "InsufficientStorage", 507)],
    [
      "a database refusing the login (28P01)",
      Object.assign(new Error("password authentication failed"), { code: "28P01" }),
    ],
    [
      "a database with a full disk (53100)",
      Object.assign(new Error("disk full"), { code: "53100" }),
    ],
  ])(
    "an environment fault (%s) leaves every file in place and stops the pass",
    async (_label, error) => {
      let down = true;
      const fake = fakeIngest(() => {
        if (down) throw error;
      });
      const w = watcher(fake);
      await writeFile(join(inbox, "a.stl"), "solid a\nendsolid a\n");
      await writeFile(join(inbox, "b.stl"), "solid b\nendsolid b\n");
      await w.pollOnce();
      const pass = await tick(w, 15_000);
      expect(pass.waiting).toBe(true);
      expect(pass.failed).toEqual([]);
      expect(fake.calls).toEqual(["a.stl"]);
      expect(await exists(join(inbox, FAILED_DIR))).toBe(false);
      await tick(w, 5_000);
      await tick(w, 5_000);
      expect(lines.filter((l) => l.includes("left in place"))).toHaveLength(1);

      down = false;
      const back = await tick(w, 5_000);
      expect(back.imported.map((i) => i.name)).toEqual(["a.stl", "b.stl"]);
      expect(await readdir(inbox)).toEqual([]);
    },
  );

  test("while the database is down, a file is not uploaded again on every poll", async () => {
    const refused = () =>
      Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    let down = true;
    const fake = fakeIngest(() => {
      if (down) throw refused();
    });
    const lookups: string[] = [];
    const w = watcher(fake, {
      findImported: async (file) => {
        lookups.push(file.originalName);
        if (down) throw refused();
        return undefined;
      },
    });
    await writeFile(join(inbox, "b.stl"), "solid b\nendsolid b\n");
    await w.pollOnce();
    const first = await tick(w, 15_000);
    expect(first.waiting).toBe(true);
    // The database was asked first and did not answer: nothing was uploaded.
    expect(lookups).toEqual(["b.stl"]);
    expect(fake.calls).toEqual([]);

    // a.stl settles during the outage; it sorts first, so it is tried first.
    await writeFile(join(inbox, "a.stl"), "solid a\nendsolid a\n");
    for (let i = 0; i < 5; i += 1) {
      const pass = await tick(w, 5_000);
      expect(pass.waiting).toBe(true);
    }
    // Each poll asked the database first and stopped there: no upload.
    expect(fake.calls).toEqual([]);
    expect(lookups.length).toBeGreaterThan(1);
    expect(lines.filter((l) => l.includes("left in place"))).toHaveLength(1);

    down = false;
    const back = await tick(w, 5_000);
    expect(back.imported.map((i) => i.name)).toEqual(["a.stl", "b.stl"]);
    expect(fake.calls).toEqual(["a.stl", "b.stl"]);
    expect(await readdir(inbox)).toEqual([]);
  });

  test("a commit that landed while its answer was lost is found on the retry, not imported twice", async () => {
    const fake = fakeIngest();
    let lost = true;
    const ingest = {
      async ingestFile(input: IngestInput) {
        // The rows commit, then the connection drops before the answer comes.
        await fake.ingest.ingestFile(input);
        if (lost) {
          lost = false;
          throw new Error("Connection terminated unexpectedly");
        }
        throw new Error("a retry must not reach ingest");
      },
    };
    const asked: ImportedQuery[] = [];
    const w = watcher(fake, {
      ingest,
      findImported: async (file) => {
        asked.push(file);
        return storedMatch(fake, file);
      },
    });
    const bytes = Buffer.from("solid lost\nendsolid lost\n");
    const path = join(inbox, "lost.stl");
    await writeFile(path, bytes);
    // Read as the watcher reads it. A plain lstat rounds ctime to the
    // millisecond, a bigint one truncates, so the two differ by 1 ms whenever
    // the sub-millisecond part is 0.5 ms or more.
    const arrived = (await lstat(path, { bigint: true })).ctime;
    // Real time passes before the first poll, so a lower bound taken from the
    // wall clock when the file is first seen cannot equal its ctime.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await w.pollOnce();
    const first = await tick(w, 15_000);
    expect(first.waiting).toBe(true);
    expect(await exists(path)).toBe(true);

    const retry = await tick(w, 5_000);
    expect(fake.calls).toEqual(["lost.stl"]);
    expect(retry.imported).toEqual([{ name: "lost.stl", modelId: "model-1", fileId: "file-1" }]);
    expect(retry.failed).toEqual([]);
    expect(await exists(path)).toBe(false);
    // Asked before the first attempt (nothing yet) and again before the retry.
    expect(asked).toHaveLength(2);
    for (const q of asked) {
      expect(q.originalName).toBe("lost.stl");
      expect(q.size).toBe(bytes.length);
      expect(q.sha256.equals(sha256(bytes))).toBe(true);
      // Only rows written since the file reached the inbox count.
      expect(q.since.getTime()).toBe(arrived.getTime());
    }
  });

  test("a metadata change between a lost answer and the retry does not make a second model", async () => {
    // chmod, chown or an xattr write (Samba storing a Finder xattr when the
    // share is opened) moves the file's ctime past the landed row's
    // created_at; the retry must still find the row.
    const fake = fakeIngest();
    const created = new Map<string, Date>();
    let lost = true;
    const ingest = {
      async ingestFile(input: IngestInput) {
        const result = await fake.ingest.ingestFile(input);
        created.set(result.fileId, new Date());
        if (lost) {
          lost = false;
          throw new Error("Connection terminated unexpectedly");
        }
        return result;
      },
    };
    const w = watcher(fake, {
      ingest,
      findImported: async (file) => {
        const found = storedMatch(fake, file);
        const at = found === undefined ? undefined : created.get(found.fileId);
        return at !== undefined && at >= file.since ? found : undefined;
      },
    });
    const path = join(inbox, "touched.stl");
    await writeFile(path, "solid touched\nendsolid touched\n");
    await w.pollOnce();
    const first = await tick(w, 15_000);
    expect(first.waiting).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await chmod(path, 0o600);
    const landed = created.get("file-1");
    expect(landed).toBeDefined();
    // Truncated, as the watcher would read it afresh, so a rounded value 1 ms
    // higher cannot make the gap look real when it is not.
    expect((await lstat(path, { bigint: true })).ctime.getTime()).toBeGreaterThan(
      landed?.getTime() ?? 0,
    );

    const retry = await tick(w, 5_000);
    expect(fake.calls).toEqual(["touched.stl"]);
    expect(retry.imported).toEqual([{ name: "touched.stl", modelId: "model-1", fileId: "file-1" }]);
    expect(await exists(path)).toBe(false);
  });

  test("a commit whose answer was lost before a restart is found by the next process, not imported twice", async () => {
    // Everything the watcher keeps in memory goes with the process; what the
    // lost commit wrote stays in the database. created holds each stored
    // file's created_at, as the files table would.
    const fake = fakeIngest();
    const created = new Map<string, Date>();
    const lostAnswer = {
      async ingestFile(input: IngestInput) {
        const result = await fake.ingest.ingestFile(input);
        created.set(result.fileId, new Date());
        throw new Error("Connection terminated unexpectedly");
      },
    };
    const findImported = async (file: ImportedQuery) => {
      const found = storedMatch(fake, file);
      const at = found === undefined ? undefined : created.get(found.fileId);
      return at !== undefined && at >= file.since ? found : undefined;
    };
    const bytes = Buffer.from("solid restart\nendsolid restart\n");
    const path = join(inbox, "restart.stl");
    await writeFile(path, bytes);

    const before = watcher(fake, { ingest: lostAnswer, findImported });
    await before.pollOnce();
    const first = await tick(before, 15_000);
    expect(first.waiting).toBe(true);
    expect(await exists(path)).toBe(true);
    await before.stop();

    // A new process: a new watcher sees the file for the first time.
    const after = watcher(fake, {
      ingest: {
        async ingestFile() {
          throw new Error("the file must not be imported a second time");
        },
      },
      findImported,
    });
    await after.pollOnce();
    const pass = await tick(after, 15_000);
    expect(pass.imported).toEqual([{ name: "restart.stl", modelId: "model-1", fileId: "file-1" }]);
    expect(pass.failed).toEqual([]);
    expect(fake.calls).toEqual(["restart.stl"]);
    expect(await exists(path)).toBe(false);
  });

  test("the same file imported before it reached the inbox is imported again", async () => {
    const fake = fakeIngest();
    const bytes = Buffer.from("solid again\nendsolid again\n");
    // A model made from the same name and bytes a minute before this copy.
    fake.stored.set("file-0", { size: bytes.length, sha256: sha256(bytes) });
    const earlier = new Date(Date.now() - 60_000);
    const w = watcher(fake, {
      findImported: async (file) => {
        const found = storedMatch(fake, file);
        return found !== undefined && earlier >= file.since ? found : undefined;
      },
    });
    await writeFile(join(inbox, "again.stl"), bytes);
    await w.pollOnce();
    const pass = await tick(w, 15_000);
    expect(fake.calls).toEqual(["again.stl"]);
    expect(pass.imported).toEqual([{ name: "again.stl", modelId: "model-1", fileId: "file-1" }]);
  });

  test("after a storage outage the retry asks the database again before uploading", async () => {
    let down = true;
    const fake = fakeIngest(() => {
      if (down) throw new IngestError("storage_unavailable", "Storage is unavailable right now");
    });
    const lookups: string[] = [];
    const w = watcher(fake, {
      findImported: async (file) => {
        lookups.push(file.originalName);
        return undefined;
      },
    });
    await writeFile(join(inbox, "a.stl"), "solid a\nendsolid a\n");
    await w.pollOnce();
    await tick(w, 15_000);
    down = false;
    await tick(w, 5_000);
    expect(fake.calls).toEqual(["a.stl", "a.stl"]);
    expect(lookups).toEqual(["a.stl", "a.stl"]);
    expect(await readdir(inbox)).toEqual([]);
  });
});

describe("names that are not UTF-8", () => {
  const latin1 = (stem: number[]) => Buffer.concat([Buffer.from(stem), Buffer.from(".stl")]);
  // "café.stl" and "cafè.stl" as Latin-1: one byte each, neither valid UTF-8.
  const cafe = latin1([0x63, 0x61, 0x66, 0xe9]);
  const cafe2 = latin1([0x63, 0x61, 0x66, 0xe8]);

  test("a UTF-8 name is its own key", () => {
    expect(inboxName(Buffer.from("caf\u00e9.stl"))).toEqual({
      key: "caf\u00e9.stl",
      name: "caf\u00e9.stl",
      utf8: true,
    });
  });

  test("names that decode alike keep keys of their own, which no UTF-8 name can equal", () => {
    const a = inboxName(cafe);
    const b = inboxName(cafe2);
    expect(a.utf8).toBe(false);
    expect(a.name).toBe("caf\ufffd.stl");
    expect(b.name).toBe(a.name);
    expect(b.key).not.toBe(a.key);
    expect(a.key.startsWith("/")).toBe(true);
  });

  test("a settled file whose name is not UTF-8 moves to failed with a reason, not skipped without a word", async (ctx) => {
    const fake = fakeIngest();
    const w = watcher(fake);
    const inboxBytes = Buffer.from(`${inbox}/`);
    try {
      await writeFile(Buffer.concat([inboxBytes, cafe]), "solid a\nendsolid a\n");
    } catch (error) {
      // Written reason for the skip: APFS (macOS) refuses a name that is not
      // UTF-8 with EILSEQ, so no such file can exist there to test. ext4 on
      // Hades and the ubuntu CI runner take any bytes, and this test runs there.
      if ((error as { code?: string }).code === "EILSEQ") return ctx.skip();
      throw error;
    }
    await writeFile(Buffer.concat([inboxBytes, cafe2]), "solid b\nendsolid b\n");
    await w.pollOnce();
    const early = await tick(w, 14_999);
    expect(early.failed).toEqual([]);

    const pass = await tick(w, 1);
    expect(pass.failed).toEqual([
      { name: "caf\ufffd.stl", reason: NON_UTF8_REASON },
      { name: "caf\ufffd.stl", reason: NON_UTF8_REASON },
    ]);
    expect(fake.calls).toEqual([]);
    expect(await readdir(inbox)).toEqual([FAILED_DIR]);
    expect((await readdir(join(inbox, FAILED_DIR))).sort()).toEqual([
      "caf\ufffd (2).stl",
      `caf\ufffd (2).stl${REASON_SUFFIX}`,
      "caf\ufffd.stl",
      `caf\ufffd.stl${REASON_SUFFIX}`,
    ]);
    // Each is logged with its bytes, so the original name is not lost.
    for (const raw of [cafe, cafe2]) {
      expect(lines.filter((l) => l.includes(`bytes ${raw.toString("hex")}`))).toHaveLength(1);
    }
  });
});

describe("polling", () => {
  test("a missing inbox folder is created", async () => {
    await rm(inbox, { recursive: true });
    const w = watcher(fakeIngest());
    await w.pollOnce();
    expect(await exists(inbox)).toBe(true);
  });

  test("a file that vanishes before it settles is forgotten without an error", async () => {
    const fake = fakeIngest();
    const w = watcher(fake);
    await writeFile(join(inbox, "gone.stl"), "solid a\nendsolid a\n");
    await w.pollOnce();
    await rm(join(inbox, "gone.stl"));
    const pass = await tick(w, 15_000);
    expect(pass.imported).toEqual([]);
    expect(pass.failed).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  test("overlapping polls share one pass and never import a file twice", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = fakeIngest(() => gate);
    const w = watcher(fake);
    await writeFile(join(inbox, "a.stl"), "solid a\nendsolid a\n");
    await w.pollOnce();
    clock += 15_000;
    const first = w.pollOnce();
    const second = w.pollOnce();
    release();
    const [p1, p2] = await Promise.all([first, second]);
    expect(p1).toBe(p2);
    expect(fake.calls).toEqual(["a.stl"]);
  });

  test("start polls on the interval and stop waits for the pass in flight", async () => {
    const fake = fakeIngest();
    // Each clock read moves time on 5 s, so the settle window passes in a few polls.
    const w = watcher(fake, {
      pollMs: 5,
      now: () => {
        clock += 5_000;
        return clock;
      },
    });
    await writeFile(join(inbox, "a.stl"), "solid a\nendsolid a\n");
    w.start();
    for (let i = 0; i < 200 && fake.calls.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await w.stop();
    expect(fake.calls).toEqual(["a.stl"]);
    expect(await exists(join(inbox, "a.stl"))).toBe(false);

    // Nothing polls after stop.
    await writeFile(join(inbox, "b.stl"), "solid b\nendsolid b\n");
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.calls).toEqual(["a.stl"]);
  });
});
