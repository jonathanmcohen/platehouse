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
  open,
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
  BACKOFF_FIRST_MS,
  BACKOFF_MAX_MS,
  CHANGED_REASON,
  createInboxWatcher,
  FAILED_DIR,
  type ImportedQuery,
  type InboxProbes,
  inboxName,
  isIgnoredName,
  MAX_INBOX_BYTES,
  NON_UTF8_REASON,
  REASON_SUFFIX,
  repeatedErrorReason,
  STRIKES,
  TOO_LARGE_REASON,
  UNCONFIRMED_REASON,
} from "../../src/inbox/watch.js";
import { IngestError, type IngestInput } from "../../src/ingest/ingest.js";
import { StoreError, StoreUnavailable } from "../../src/storage/s3.js";

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

/** An error with a code, as pg and Node give them. */
const coded = (message: string, code: string) => Object.assign(new Error(message), { code });

/**
 * Environment checks that fail while down() is true, recording when (on the
 * injected clock) the database check ran.
 */
function checks(down: () => boolean) {
  const at: number[] = [];
  const probes: InboxProbes = {
    database: async () => {
      at.push(clock);
      if (down()) throw coded("connect ECONNREFUSED 10.0.0.5:5432", "ECONNREFUSED");
    },
    store: async () => undefined,
  };
  return { probes, at };
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

  test("a refused file goes to failed at once, without checking the environment", async () => {
    const fake = fakeIngest(() => {
      throw new IngestError("unsupported_type", "Refused");
    });
    const { probes, at } = checks(() => false);
    const w = watcher(fake, { probes });
    await writeFile(join(inbox, "notes.txt"), "not a model\n");
    await w.pollOnce();
    const pass = await tick(w, 15_000);
    expect(pass.failed).toEqual([{ name: "notes.txt", reason: "Refused." }]);
    expect(at).toEqual([]);
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
    const { probes } = checks(() => down);
    const w = watcher(fake, { probes });
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

    // The check at +5 s failed, so the next waits 10 s, until +15 s.
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
    const { probes } = checks(() => down);
    const w = watcher(fake, { probes });
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

  test("while the database is down, a file is not uploaded again on every poll", async () => {
    const refused = () => coded("connect ECONNREFUSED", "ECONNREFUSED");
    let down = true;
    const fake = fakeIngest(() => {
      if (down) throw refused();
    });
    const lookups: string[] = [];
    const { probes } = checks(() => down);
    const w = watcher(fake, {
      probes,
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
    // No file is tried until a check passes: no question, no upload.
    expect(fake.calls).toEqual([]);
    expect(lookups).toEqual(["b.stl"]);
    expect(lines.filter((l) => l.includes("not answering"))).toHaveLength(1);

    // Checks failed at +5 s and +15 s; the next is due at +35 s.
    down = false;
    const back = await tick(w, 10_000);
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
    // The database answers the check, so this is one failed try for the file.
    expect(first.failed).toEqual([]);
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
    expect(first.failed).toEqual([]);

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
    expect(first.failed).toEqual([]);
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
    const { probes } = checks(() => down);
    const w = watcher(fake, {
      probes,
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

describe("telling a bad file from an outage", () => {
  // Errors from every source, none of them on any list: with the checks
  // failing, none may send a file to failed, or a broken store or database
  // would empty the inbox one file at a time.
  const errors: Array<[string, unknown]> = [
    [
      "IngestError storage_unavailable",
      new IngestError("storage_unavailable", "Storage is unavailable right now"),
    ],
    ["StoreUnavailable", new StoreUnavailable("PutObject", "ECONNREFUSED")],
    [
      "StoreError AccessDenied 403 on HeadObject",
      new StoreError("HeadObject", "AccessDenied", 403),
    ],
    [
      "StoreError from the upload library, no status",
      new StoreError("CompleteMultipartUpload", "Error"),
    ],
    ["Postgres disk I/O error 58030", coded("could not write to file", "58030")],
    [
      "Postgres read-only 25006",
      coded("cannot execute INSERT in a read-only transaction", "25006"),
    ],
    ["Postgres permission denied 42501", coded("permission denied for table files", "42501")],
    [
      "Postgres statement timeout 57014",
      coded("canceling statement due to statement timeout", "57014"),
    ],
    ["an error nobody has listed", new Error("something new went wrong")],
    ["a TypeError", new TypeError("Cannot read properties of undefined")],
    ["a thrown string", "not even an Error"],
  ];

  test.each(errors)(
    "with the checks failing, an ingest error (%s) leaves every file in place and stops the pass",
    async (_label, error) => {
      let down = true;
      const fake = fakeIngest(() => {
        if (down) throw error;
      });
      const { probes } = checks(() => down);
      const w = watcher(fake, { probes });
      await writeFile(join(inbox, "a.stl"), "solid a\nendsolid a\n");
      await writeFile(join(inbox, "b.stl"), "solid b\nendsolid b\n");
      await w.pollOnce();
      const pass = await tick(w, 15_000);
      expect(pass.waiting).toBe(true);
      expect(pass.failed).toEqual([]);
      expect(fake.calls).toEqual(["a.stl"]);
      for (let i = 0; i < 60; i += 1) {
        const later = await tick(w, 5_000);
        expect(later.failed).toEqual([]);
      }
      expect(await exists(join(inbox, FAILED_DIR))).toBe(false);
      expect(lines.filter((l) => l.includes("not answering"))).toHaveLength(1);

      down = false;
      const back = await tick(w, BACKOFF_MAX_MS);
      expect(back.imported.map((i) => i.name)).toEqual(["a.stl", "b.stl"]);
      expect(await readdir(inbox)).toEqual([]);
      expect(lines.filter((l) => l.includes("importing again"))).toHaveLength(1);
    },
  );

  test.each(errors)(
    "with the checks failing, a findImported error (%s) leaves every file in place and uploads nothing",
    async (_label, error) => {
      const fake = fakeIngest();
      const { probes } = checks(() => true);
      const w = watcher(fake, {
        probes,
        findImported: async () => {
          throw error;
        },
      });
      await writeFile(join(inbox, "a.stl"), "solid a\nendsolid a\n");
      await writeFile(join(inbox, "b.stl"), "solid b\nendsolid b\n");
      await w.pollOnce();
      const pass = await tick(w, 15_000);
      expect(pass.waiting).toBe(true);
      expect(pass.failed).toEqual([]);
      for (let i = 0; i < 60; i += 1) await tick(w, 5_000);
      expect(fake.calls).toEqual([]);
      expect(await exists(join(inbox, FAILED_DIR))).toBe(false);
    },
  );

  test("during an outage the checks back off: 5 s, doubling each failed check, at most 5 minutes", async () => {
    const down = true;
    const fake = fakeIngest(() => {
      if (down) throw new Error("the import failed");
    });
    const { probes, at } = checks(() => down);
    const w = watcher(fake, { probes });
    await writeFile(join(inbox, "a.stl"), "solid a\nendsolid a\n");
    await w.pollOnce();
    await tick(w, 15_000);
    const start = clock;
    // A poll every 5 s for half an hour.
    for (let i = 0; i < 360; i += 1) await tick(w, 5_000);
    const gaps = at.map((t, i) => (i === 0 ? t - start : t - (at[i - 1] ?? 0)));
    expect(BACKOFF_FIRST_MS).toBe(5_000);
    expect(BACKOFF_MAX_MS).toBe(300_000);
    expect(gaps.slice(0, 9)).toEqual([
      0, 5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000,
    ]);
    expect(gaps.every((g) => g <= BACKOFF_MAX_MS)).toBe(true);
    // The file was tried once, when the outage began, and never again.
    expect(fake.calls).toEqual(["a.stl"]);
    expect(lines.filter((l) => l.includes("not answering"))).toHaveLength(1);
    expect(lines.filter((l) => l.includes("importing again"))).toHaveLength(0);
  });

  test("the outage start is logged with the error, the end once, and the backoff resets after a good pass", async () => {
    let down = true;
    const fake = fakeIngest(() => {
      if (down) throw coded("could not write to file", "58030");
    });
    const { probes, at } = checks(() => down);
    const w = watcher(fake, { probes });
    await writeFile(join(inbox, "a.stl"), "solid a\nendsolid a\n");
    await w.pollOnce();
    await tick(w, 15_000);
    for (let i = 0; i < 20; i += 1) await tick(w, 5_000);
    const started = lines.filter((l) => l.includes("not answering"));
    expect(started).toHaveLength(1);
    expect(started[0]).toContain("could not write to file");
    expect(started[0]).toContain("ECONNREFUSED");

    down = false;
    await tick(w, BACKOFF_MAX_MS);
    expect(await exists(join(inbox, "a.stl"))).toBe(false);
    expect(lines.filter((l) => l.includes("importing again"))).toHaveLength(1);

    // A second outage starts again at 5 s.
    down = true;
    await writeFile(join(inbox, "b.stl"), "solid b\nendsolid b\n");
    await tick(w, 5_000);
    await tick(w, 15_000);
    const second = clock;
    const before = at.length;
    await tick(w, 5_000);
    expect(at.length).toBe(before + 1);
    expect((at[at.length - 1] ?? 0) - second).toBe(5_000);
    expect(lines.filter((l) => l.includes("not answering"))).toHaveLength(2);
  });

  test("a store that refuses after the upload, with the store check refused too, gets the file uploaded once, not every 5 s", async () => {
    // A write-only bucket: the upload is stored, HeadObject is denied, and so
    // is the listing the store check makes.
    const fake = fakeIngest(() => {
      throw new StoreError("HeadObject", "AccessDenied", 403);
    });
    const probes: InboxProbes = {
      database: async () => undefined,
      store: async () => {
        throw new StoreError("ListObjectsV2", "AccessDenied", 403);
      },
    };
    const w = watcher(fake, { probes });
    await writeFile(join(inbox, "a.stl"), "solid a\nendsolid a\n");
    await w.pollOnce();
    await tick(w, 15_000);
    for (let i = 0; i < 120; i += 1) await tick(w, 5_000);
    expect(fake.calls).toEqual(["a.stl"]);
    expect(await exists(join(inbox, FAILED_DIR))).toBe(false);
  });

  test("a check that does not answer in time counts as failed", async () => {
    const fake = fakeIngest(() => {
      throw new Error("the import failed");
    });
    const probes: InboxProbes = {
      database: () => new Promise(() => undefined),
      store: async () => undefined,
    };
    const w = watcher(fake, { probes, probeTimeoutMs: 20 });
    await writeFile(join(inbox, "a.stl"), "solid a\nendsolid a\n");
    await w.pollOnce();
    const pass = await tick(w, 15_000);
    expect(pass.waiting).toBe(true);
    expect(pass.failed).toEqual([]);
    expect(lines.filter((l) => l.includes("not answering"))).toHaveLength(1);
  });

  test(`with the checks passing, a file that fails ${STRIKES} times in a row moves to failed with the error, and other files import in between`, async () => {
    const boom = new TypeError("boom in the parser");
    const fake = fakeIngest((input) => {
      if (input.originalName === "a.stl") throw boom;
    });
    const w = watcher(fake);
    await writeFile(join(inbox, "a.stl"), "solid a\nendsolid a\n");
    await writeFile(join(inbox, "b.stl"), "solid b\nendsolid b\n");
    await w.pollOnce();
    const first = await tick(w, 15_000);
    expect(first.waiting).toBe(false);
    expect(first.failed).toEqual([]);
    expect(first.imported.map((i) => i.name)).toEqual(["b.stl"]);
    expect(await exists(join(inbox, "a.stl"))).toBe(true);

    await writeFile(join(inbox, "c.stl"), "solid c\nendsolid c\n");
    const second = await tick(w, 5_000);
    expect(second.failed).toEqual([]);
    expect(await exists(join(inbox, "a.stl"))).toBe(true);

    const third = await tick(w, 5_000);
    const reason = repeatedErrorReason(boom);
    expect(third.failed).toEqual([{ name: "a.stl", reason }]);
    expect(reason).toContain("TypeError: boom in the parser");
    expect(reason.endsWith(".")).toBe(true);
    expect(await readFile(join(inbox, FAILED_DIR, `a.stl${REASON_SUFFIX}`), "utf8")).toBe(
      `${reason}\n`,
    );
    expect(fake.calls.filter((n) => n === "a.stl")).toHaveLength(STRIKES);
    // c.stl settled and imported while a.stl was failing.
    await tick(w, 15_000);
    expect(fake.calls.filter((n) => n === "c.stl")).toHaveLength(1);
    expect((await readdir(inbox)).sort()).toEqual([FAILED_DIR]);
  });

  test("a change to the file resets its count", async () => {
    const fake = fakeIngest(() => {
      throw new Error("the import failed");
    });
    const w = watcher(fake);
    const path = join(inbox, "a.stl");
    await writeFile(path, "solid a\nendsolid a\n");
    await w.pollOnce();
    await tick(w, 15_000);
    await tick(w, 5_000);
    expect(fake.calls).toHaveLength(2);

    await appendFile(path, "more\n");
    await tick(w, 5_000);
    await tick(w, 15_000);
    await tick(w, 5_000);
    expect(fake.calls).toHaveLength(4);
    expect(await exists(path)).toBe(true);
    const pass = await tick(w, 5_000);
    expect(fake.calls).toHaveLength(5);
    expect(pass.failed.map((f) => f.name)).toEqual(["a.stl"]);
  });

  test("a file that fails once and then imports is not in failed", async () => {
    let fails = 1;
    const fake = fakeIngest(() => {
      if (fails > 0) {
        fails -= 1;
        throw new Error("a passing hiccup");
      }
    });
    const w = watcher(fake);
    await writeFile(join(inbox, "a.stl"), "solid a\nendsolid a\n");
    await w.pollOnce();
    await tick(w, 15_000);
    const pass = await tick(w, 5_000);
    expect(pass.imported.map((i) => i.name)).toEqual(["a.stl"]);
    expect(await exists(join(inbox, FAILED_DIR))).toBe(false);
  });
});

describe("a fault the checks cannot see", () => {
  // The database check only reads, so a fault that breaks writes and not
  // reads passes it: the data disk full (53100) or a write-side I/O error
  // (58030). Every file fails then, with both checks passing.
  const diskFull = coded("could not extend file: No space left on device", "53100");

  test("a second file failing in the same pass, with the checks passing, holds the inbox: no file takes a strike or moves to failed", async () => {
    let broken = true;
    const fake = fakeIngest(() => {
      if (broken) throw diskFull;
    });
    const w = watcher(fake);
    for (const name of ["a.stl", "b.stl", "c.stl"]) {
      await writeFile(join(inbox, name), `solid ${name}\nendsolid ${name}\n`);
    }
    await w.pollOnce();
    const pass = await tick(w, 15_000);
    expect(pass.waiting).toBe(true);
    expect(pass.failed).toEqual([]);
    // The pass stopped at the second failure; c.stl was not tried.
    expect(fake.calls).toEqual(["a.stl", "b.stl"]);

    for (let i = 0; i < 360; i += 1) {
      const later = await tick(w, 5_000);
      expect(later.failed).toEqual([]);
    }
    expect(await exists(join(inbox, FAILED_DIR))).toBe(false);
    expect(fake.calls).not.toContain("c.stl");
    const started = lines.filter((l) => l.includes("the checks cannot see"));
    expect(started).toHaveLength(1);
    expect(started[0]).toContain("a.stl");
    expect(started[0]).toContain("b.stl");
    expect(started[0]).toContain("could not extend file");

    broken = false;
    const back = await tick(w, BACKOFF_MAX_MS);
    expect(back.imported.map((i) => i.name)).toEqual(["a.stl", "b.stl", "c.stl"]);
    expect(await readdir(inbox)).toEqual([]);
    expect(lines.filter((l) => l.includes("importing again"))).toHaveLength(1);
  });

  test("while such a fault lasts the tries back off: 5 s, doubling, at most 5 minutes", async () => {
    const tries: number[] = [];
    const fake = fakeIngest((input) => {
      if (input.originalName === "a.stl") tries.push(clock);
      throw diskFull;
    });
    const w = watcher(fake);
    await writeFile(join(inbox, "a.stl"), "solid a\nendsolid a\n");
    await writeFile(join(inbox, "b.stl"), "solid b\nendsolid b\n");
    await w.pollOnce();
    await tick(w, 15_000);
    // A poll every 5 s for half an hour.
    for (let i = 0; i < 360; i += 1) await tick(w, 5_000);
    const gaps = tries.slice(1).map((t, i) => t - (tries[i] ?? 0));
    expect(gaps.slice(0, 8)).toEqual([
      5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000,
    ]);
    expect(gaps.every((g) => g <= BACKOFF_MAX_MS)).toBe(true);
    expect(await exists(join(inbox, FAILED_DIR))).toBe(false);
  });

  test("the first file's failure in a held pass does not count against it", async () => {
    // a.stl is truly bad; b.stl fails only while the disk is full.
    let broken = true;
    const boom = new TypeError("boom in the parser");
    const fake = fakeIngest((input) => {
      if (input.originalName === "a.stl") throw boom;
      if (broken) throw diskFull;
    });
    const w = watcher(fake);
    await writeFile(join(inbox, "a.stl"), "solid a\nendsolid a\n");
    await writeFile(join(inbox, "b.stl"), "solid b\nendsolid b\n");
    await w.pollOnce();
    const held = await tick(w, 15_000);
    expect(held.waiting).toBe(true);

    broken = false;
    const next = await tick(w, BACKOFF_FIRST_MS);
    expect(next.waiting).toBe(false);
    expect(next.imported.map((i) => i.name)).toEqual(["b.stl"]);
    expect(next.failed).toEqual([]);
    await tick(w, 5_000);
    const last = await tick(w, 5_000);
    expect(last.failed).toEqual([{ name: "a.stl", reason: repeatedErrorReason(boom) }]);
    // Tried once in the held pass, then STRIKES times that counted.
    expect(fake.calls.filter((n) => n === "a.stl")).toHaveLength(STRIKES + 1);
  });

  test("a file's last strike does not move it to failed when a second file fails in the same pass", async () => {
    let broken = false;
    const boom = new TypeError("boom in the parser");
    const fake = fakeIngest((input) => {
      if (input.originalName === "a.stl") throw boom;
      if (broken) throw diskFull;
    });
    const w = watcher(fake);
    const b = join(inbox, "b.stl");
    await writeFile(join(inbox, "a.stl"), "solid a\nendsolid a\n");
    await writeFile(b, "solid b\n");
    await w.pollOnce();
    // b.stl grows, so it settles 15 s after a.stl does.
    await appendFile(b, "endsolid b\n");
    await tick(w, 15_000);
    await tick(w, 14_999);
    expect(fake.calls).toEqual(Array(STRIKES - 1).fill("a.stl"));

    // a.stl's last try and b.stl's first come in the same pass, the disk full.
    broken = true;
    const pass = await tick(w, 1);
    expect(fake.calls).toEqual([...Array(STRIKES).fill("a.stl"), "b.stl"]);
    expect(pass.waiting).toBe(true);
    expect(pass.failed).toEqual([]);
    expect(await exists(join(inbox, "a.stl"))).toBe(true);
    expect(await exists(join(inbox, FAILED_DIR))).toBe(false);
  });
});

describe("the size limit", () => {
  /** A sparse file of exactly size bytes, so no disk space is used. */
  async function sparse(path: string, size: number) {
    const handle = await open(path, "w");
    try {
      await handle.truncate(size);
    } finally {
      await handle.close();
    }
  }

  test("is the 512 MiB uploads have", () => {
    expect(MAX_INBOX_BYTES).toBe(536_870_912);
  });

  test("a file over it moves to failed from its size alone, with nothing read, asked or uploaded", async () => {
    const lookups: string[] = [];
    const calls: string[] = [];
    const w = watcher(fakeIngest(), {
      ingest: {
        async ingestFile(input: IngestInput) {
          calls.push(input.originalName);
          if (input.originalName === "big.3mf") {
            throw new IngestError("unsupported_type", "not this one");
          }
          return { modelId: "model-x", fileId: "file-x" };
        },
      },
      storedFile: async () => undefined,
      findImported: async (q) => {
        lookups.push(`${q.originalName}:${q.size}`);
        return undefined;
      },
    });
    await sparse(join(inbox, "big.3mf"), MAX_INBOX_BYTES + 1);
    await sparse(join(inbox, "edge.3mf"), MAX_INBOX_BYTES);
    await w.pollOnce();
    const pass = await tick(w, 15_000);

    expect(pass.failed.find((f) => f.name === "big.3mf")).toEqual({
      name: "big.3mf",
      reason: TOO_LARGE_REASON,
    });
    expect(await readFile(join(inbox, FAILED_DIR, `big.3mf${REASON_SUFFIX}`), "utf8")).toBe(
      `${TOO_LARGE_REASON}\n`,
    );
    expect(calls).toEqual(["edge.3mf"]);
    expect(lookups).toEqual([`edge.3mf:${MAX_INBOX_BYTES}`]);
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
