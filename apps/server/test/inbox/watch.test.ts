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
  type ImportedFile,
  type ImportedQuery,
  type InboxProbes,
  inboxFileId,
  inboxName,
  inboxProbes,
  isIgnoredName,
  MAX_INBOX_BYTES,
  MAX_INBOX_IDS,
  NON_UTF8_REASON,
  REASON_SUFFIX,
  repeatedErrorReason,
  STRIKES,
  TOO_LARGE_REASON,
  tooLargeReason,
  UNCONFIRMED_REASON,
} from "../../src/inbox/watch.js";
import {
  INGEST_FAILED_MESSAGE,
  IngestError,
  type IngestInput,
  IngestOutcomeUnknown,
} from "../../src/ingest/ingest.js";
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
 * file: it reads the bytes and remembers their size and SHA-256 under the
 * file id the caller chose (a new one when none was), as ingestFile does.
 * models holds each stored file's model, as the files table would.
 */
function fakeIngest(behaviour: Behaviour = () => undefined) {
  const calls: string[] = [];
  const ids: Array<string | undefined> = [];
  const stored = new Map<string, { size: number; sha256: Buffer }>();
  const models = new Map<string, string>();
  let n = 0;
  return {
    calls,
    ids,
    stored,
    models,
    ingest: {
      async ingestFile(input: IngestInput) {
        calls.push(input.originalName);
        ids.push(input.fileId);
        expect(input.target).toBe("new");
        await behaviour(input);
        const bytes = await readFile(input.tmpPath);
        n += 1;
        const fileId = input.fileId ?? `file-${n}`;
        const modelId = `model-${n}`;
        stored.set(fileId, { size: bytes.length, sha256: sha256(bytes) });
        models.set(fileId, modelId);
        return { modelId, fileId };
      },
    },
  };
}

/** The fake's file rows with the ids asked about, as files.findImported finds them. */
function storedRow(fake: ReturnType<typeof fakeIngest>, q: ImportedQuery): ImportedFile[] {
  return q.fileIds.flatMap((fileId) => {
    const modelId = fake.models.get(fileId);
    return modelId === undefined ? [] : [{ modelId, fileId, live: true }];
  });
}

/** The id of attempt 0 in a query: it names the copy the watcher asked about. */
const copyAsked = (q: ImportedQuery) => q.fileIds[0] ?? "";

/**
 * A findImported that answers from a fixed set of rows, keyed by file id,
 * recording each query it is asked.
 */
function rowsIn(rows: Map<string, ImportedFile>, queries: ImportedQuery[] = []) {
  return async (q: ImportedQuery): Promise<ImportedFile[]> => {
    queries.push(q);
    return q.fileIds.flatMap((id) => rows.get(id) ?? []);
  };
}

/**
 * The id the watcher chooses for an inbox file as it is now on disk, its
 * ctime read as the watcher reads it (a bigint lstat, truncated to the
 * millisecond).
 */
async function inboxIdOf(name: string, attempt = 0): Promise<string> {
  const path = join(inbox, name);
  const bytes = await readFile(path);
  const { ctime } = await lstat(path, { bigint: true });
  return inboxFileId({ name, size: bytes.length, sha256: sha256(bytes), arrived: ctime, attempt });
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
    findImported: async () => [],
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
    const id = await inboxIdOf("cube.stl");

    await w.pollOnce();
    await tick(w, 5_000);
    await tick(w, 9_999);
    expect(fake.calls).toEqual([]);
    const pass = await tick(w, 1);
    expect(fake.calls).toEqual(["cube.stl"]);
    expect(pass.imported).toEqual([{ name: "cube.stl", modelId: "model-1", fileId: id }]);
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

  test("an inbox copy that cannot be deleted is not imported again", async (ctx) => {
    if (process.getuid?.() === 0) {
      // Written reason for the skip: root ignores the folder's mode, so the
      // unlink cannot be made to fail. Skipped, not passed, so the report
      // says this checked nothing.
      return ctx.skip();
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

  test("onIngested runs with the stored file once ingest returns, before the stored copy is checked", async () => {
    const fake = fakeIngest();
    const order: string[] = [];
    const handed: Array<{ modelId: string; fileId: string }> = [];
    const w = watcher(fake, {
      onIngested: async (result) => {
        order.push("onIngested");
        handed.push(result);
      },
      storedFile: async (id) => {
        order.push("storedFile");
        return fake.stored.get(id);
      },
    });
    await writeFile(join(inbox, "plates.stl"), "solid p\nendsolid p\n");
    await w.pollOnce();
    const pass = await tick(w, 15_000);
    expect(pass.imported).toHaveLength(1);
    const [imported] = pass.imported;
    expect(handed).toEqual([{ modelId: imported?.modelId, fileId: imported?.fileId }]);
    expect(order).toEqual(["onIngested", "storedFile"]);
    expect(await exists(join(inbox, "plates.stl"))).toBe(false);
  });

  test("an onIngested that fails is logged, and the import and the delete still go ahead", async () => {
    const fake = fakeIngest();
    const w = watcher(fake, {
      onIngested: async () => {
        throw new Error("slicer queue is not there");
      },
    });
    await writeFile(join(inbox, "queued.stl"), "solid q\nendsolid q\n");
    await w.pollOnce();
    const pass = await tick(w, 15_000);
    expect(pass.imported).toHaveLength(1);
    expect(pass.failed).toEqual([]);
    expect(await exists(join(inbox, "queued.stl"))).toBe(false);
    expect(await exists(join(inbox, FAILED_DIR))).toBe(false);
    expect(
      lines.some((l) => l.includes("queued.stl") && l.includes("slicer queue is not there")),
    ).toBe(true);
    await tick(w, 15_000);
    expect(fake.calls).toEqual(["queued.stl"]);
  });

  test("onIngested does not run for a file ingest refuses", async () => {
    const fake = fakeIngest(() => {
      throw new IngestError("unsupported_type", "Refused");
    });
    const handed: unknown[] = [];
    const w = watcher(fake, {
      onIngested: async (result) => {
        handed.push(result);
      },
    });
    await writeFile(join(inbox, "notes.stl"), "not a model\n");
    await w.pollOnce();
    const pass = await tick(w, 15_000);
    expect(pass.failed).toHaveLength(1);
    expect(handed).toEqual([]);
  });

  test("onIngested runs for an earlier import whose answer was lost, since that attempt never ran it", async () => {
    const fake = fakeIngest();
    let lost = true;
    const ingest = {
      async ingestFile(input: IngestInput) {
        await fake.ingest.ingestFile(input);
        if (lost) {
          lost = false;
          throw new Error("Connection terminated unexpectedly");
        }
        throw new Error("a retry must not reach ingest");
      },
    };
    const handed: Array<{ modelId: string; fileId: string }> = [];
    const w = watcher(fake, {
      ingest,
      findImported: async (file) => storedRow(fake, file),
      onIngested: async (result) => {
        handed.push(result);
      },
    });
    await writeFile(join(inbox, "lost.stl"), "solid lost\nendsolid lost\n");
    await w.pollOnce();
    const id = await inboxIdOf("lost.stl");
    await tick(w, 15_000);
    expect(handed).toEqual([]);
    const retry = await tick(w, 5_000);
    expect(retry.imported).toEqual([{ name: "lost.stl", modelId: "model-1", fileId: id }]);
    expect(handed).toEqual([{ modelId: "model-1", fileId: id }]);
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
        lookups.push(copyAsked(file));
        if (down) throw refused();
        return [];
      },
    });
    await writeFile(join(inbox, "b.stl"), "solid b\nendsolid b\n");
    const b = await inboxIdOf("b.stl");
    await w.pollOnce();
    const first = await tick(w, 15_000);
    expect(first.waiting).toBe(true);
    // The database was asked first and did not answer: nothing was uploaded.
    expect(lookups).toEqual([b]);
    expect(fake.calls).toEqual([]);

    // a.stl settles during the outage; it sorts first, so it is tried first.
    await writeFile(join(inbox, "a.stl"), "solid a\nendsolid a\n");
    for (let i = 0; i < 5; i += 1) {
      const pass = await tick(w, 5_000);
      expect(pass.waiting).toBe(true);
    }
    // No file is tried until a check passes: no question, no upload.
    expect(fake.calls).toEqual([]);
    expect(lookups).toEqual([b]);
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
        return storedRow(fake, file);
      },
    });
    const bytes = Buffer.from("solid lost\nendsolid lost\n");
    const path = join(inbox, "lost.stl");
    await writeFile(path, bytes);
    // Read as the watcher reads it. A plain lstat rounds ctime to the
    // millisecond, a bigint one truncates, so the two differ by 1 ms whenever
    // the sub-millisecond part is 0.5 ms or more.
    const arrived = (await lstat(path, { bigint: true })).ctime;
    const id = inboxFileId({
      name: "lost.stl",
      size: bytes.length,
      sha256: sha256(bytes),
      arrived,
      attempt: 0,
    });
    await w.pollOnce();
    const first = await tick(w, 15_000);
    // The database answers the check, so this is one failed try for the file.
    expect(first.failed).toEqual([]);
    expect(await exists(path)).toBe(true);
    // Ingest was asked to write its row under the id the watcher chose.
    expect(fake.ids).toEqual([id]);

    const retry = await tick(w, 5_000);
    expect(fake.calls).toEqual(["lost.stl"]);
    expect(retry.imported).toEqual([{ name: "lost.stl", modelId: "model-1", fileId: id }]);
    expect(retry.failed).toEqual([]);
    expect(await exists(path)).toBe(false);
    // Asked before the first attempt (nothing yet) and again before the
    // retry, both times for this copy's ids, attempt 0's first.
    expect(asked.map(copyAsked)).toEqual([id, id]);
  });

  test("the file id is the same for the same copy and differs for any change to it", () => {
    const base = {
      name: "part.3mf",
      size: 10,
      sha256: sha256(Buffer.from("ten bytes!")),
      arrived: new Date(1_767_225_600_123),
      attempt: 0,
    };
    const id = inboxFileId(base);
    expect(inboxFileId({ ...base })).toBe(id);
    // UUIDv7-shaped, lowercase, its time field the arrival.
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16)).toBe(1_767_225_600_123);
    const others = [
      inboxFileId({ ...base, name: "Part.3mf" }),
      inboxFileId({ ...base, size: 11 }),
      inboxFileId({ ...base, sha256: sha256(Buffer.from("other one!")) }),
      inboxFileId({ ...base, arrived: new Date(1_767_225_600_124) }),
      inboxFileId({ ...base, attempt: 1 }),
    ];
    expect(new Set([id, ...others]).size).toBe(6);
  });

  test("an upload of the same name and bytes while the inbox copy waits is not taken for its import", async () => {
    // The web UI or the API (tus) stores the same file, under an id of its
    // own, after the inbox copy arrived and before the watcher tries it.
    const fake = fakeIngest();
    const bytes = Buffer.from("solid twin\nendsolid twin\n");
    const w = watcher(fake, { findImported: async (file) => storedRow(fake, file) });
    await writeFile(join(inbox, "twin.stl"), bytes);
    await w.pollOnce();
    await fake.ingest.ingestFile({
      tmpPath: join(inbox, "twin.stl"),
      originalName: "twin.stl",
      target: "new",
    });
    expect([...fake.stored.keys()]).toEqual(["file-1"]);

    const pass = await tick(w, 15_000);
    // The inbox copy made a model of its own, and no line claims otherwise.
    expect(fake.calls).toEqual(["twin.stl", "twin.stl"]);
    expect(pass.imported).toEqual([
      { name: "twin.stl", modelId: "model-2", fileId: expect.not.stringMatching(/^file-1$/) },
    ]);
    expect(lines.filter((l) => l.includes("already imported"))).toEqual([]);
  });

  test("a metadata change between a lost answer and the retry does not make a second model", async () => {
    // chmod, chown or an xattr write (Samba storing a Finder xattr when the
    // share is opened) moves the file's ctime; the retry must still ask for
    // the id the first attempt used.
    const fake = fakeIngest();
    let lost = true;
    const ingest = {
      async ingestFile(input: IngestInput) {
        const result = await fake.ingest.ingestFile(input);
        if (lost) {
          lost = false;
          throw new Error("Connection terminated unexpectedly");
        }
        return result;
      },
    };
    const w = watcher(fake, { ingest, findImported: async (file) => storedRow(fake, file) });
    const path = join(inbox, "touched.stl");
    await writeFile(path, "solid touched\nendsolid touched\n");
    const id = await inboxIdOf("touched.stl");
    await w.pollOnce();
    const first = await tick(w, 15_000);
    expect(first.failed).toEqual([]);
    expect(fake.ids).toEqual([id]);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await chmod(path, 0o600);
    // Read afresh, the ctime would now give another id.
    expect(await inboxIdOf("touched.stl")).not.toBe(id);

    const retry = await tick(w, 5_000);
    expect(fake.calls).toEqual(["touched.stl"]);
    expect(retry.imported).toEqual([{ name: "touched.stl", modelId: "model-1", fileId: id }]);
    expect(await exists(path)).toBe(false);
  });

  test("a commit whose answer was lost before a restart is found by the next process, not imported twice", async () => {
    // Everything the watcher keeps in memory goes with the process; what the
    // lost commit wrote stays in the database, as the fake's rows do.
    const fake = fakeIngest();
    const lostAnswer = {
      async ingestFile(input: IngestInput) {
        await fake.ingest.ingestFile(input);
        throw new Error("Connection terminated unexpectedly");
      },
    };
    const findImported = async (file: ImportedQuery) => storedRow(fake, file);
    const bytes = Buffer.from("solid restart\nendsolid restart\n");
    const path = join(inbox, "restart.stl");
    await writeFile(path, bytes);
    const id = await inboxIdOf("restart.stl");

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
    expect(pass.imported).toEqual([{ name: "restart.stl", modelId: "model-1", fileId: id }]);
    expect(pass.failed).toEqual([]);
    expect(fake.calls).toEqual(["restart.stl"]);
    expect(await exists(path)).toBe(false);
  });

  test("the same file imported before it reached the inbox is imported again", async () => {
    const fake = fakeIngest();
    const bytes = Buffer.from("solid again\nendsolid again\n");
    // A model made from the same name and bytes a minute before this copy,
    // under an id of its own.
    fake.stored.set("file-0", { size: bytes.length, sha256: sha256(bytes) });
    fake.models.set("file-0", "model-0");
    const w = watcher(fake, { findImported: async (file) => storedRow(fake, file) });
    await writeFile(join(inbox, "again.stl"), bytes);
    const id = await inboxIdOf("again.stl");
    await w.pollOnce();
    const pass = await tick(w, 15_000);
    expect(fake.calls).toEqual(["again.stl"]);
    expect(pass.imported).toEqual([{ name: "again.stl", modelId: "model-1", fileId: id }]);
  });

  test("a row under the copy's id whose model is in the trash is passed over for the next id", async () => {
    // The lost answer's model was trashed before the retry: a purge deletes
    // its bytes, so the copy gets a model of its own, under the next id.
    const fake = fakeIngest();
    const asked: ImportedQuery[] = [];
    await writeFile(join(inbox, "trashed.stl"), "solid trashed\nendsolid trashed\n");
    const first = await inboxIdOf("trashed.stl", 0);
    const second = await inboxIdOf("trashed.stl", 1);
    const w = watcher(fake, {
      findImported: async (file) => {
        asked.push(file);
        const trashed = file.fileIds.includes(first)
          ? [{ modelId: "model-trashed", fileId: first, live: false }]
          : [];
        return [...trashed, ...storedRow(fake, file)];
      },
    });
    await w.pollOnce();
    const pass = await tick(w, 15_000);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.fileIds.slice(0, 2)).toEqual([first, second]);
    expect(fake.ids).toEqual([second]);
    expect(pass.imported).toEqual([{ name: "trashed.stl", modelId: "model-1", fileId: second }]);
    expect(lines.filter((l) => l.includes("already imported"))).toEqual([]);
  });

  test("a live row under a later id is found when an earlier id has no row, so the copy is not imported twice", async () => {
    // Attempt 0's model was in the trash, so the copy went to ingest under
    // attempt 1, whose commit landed with its answer lost. Before the retry,
    // Empty trash (or the purge) deleted attempt 0's model and so its file
    // row: no row under attempt 0, a live one under attempt 1.
    const fake = fakeIngest();
    const bytes = Buffer.from("solid gap\nendsolid gap\n");
    const path = join(inbox, "gap.stl");
    await writeFile(path, bytes);
    const second = await inboxIdOf("gap.stl", 1);
    fake.stored.set(second, { size: bytes.length, sha256: sha256(bytes) });
    const rows = new Map<string, ImportedFile>([
      [second, { modelId: "model-live", fileId: second, live: true }],
    ]);
    const w = watcher(fake, { findImported: rowsIn(rows) });
    await w.pollOnce();
    const pass = await tick(w, 15_000);
    expect(fake.calls).toEqual([]);
    expect(pass.imported).toEqual([{ name: "gap.stl", modelId: "model-live", fileId: second }]);
    expect(pass.failed).toEqual([]);
    expect(await exists(path)).toBe(false);
  });

  test("past a trashed id and a missing one, the copy takes the lowest id with no row", async () => {
    // Attempt 0 trashed, attempt 1 gone (its model purged), attempt 2
    // trashed: no live row, so the copy is imported under attempt 1.
    const fake = fakeIngest();
    await writeFile(join(inbox, "holes.stl"), "solid holes\nendsolid holes\n");
    const ids = await Promise.all([0, 1, 2].map((attempt) => inboxIdOf("holes.stl", attempt)));
    const trashed = (fileId: string): ImportedFile => ({ modelId: "model-t", fileId, live: false });
    const rows = new Map<string, ImportedFile>([
      [ids[0] as string, trashed(ids[0] as string)],
      [ids[2] as string, trashed(ids[2] as string)],
    ]);
    const w = watcher(fake, { findImported: rowsIn(rows) });
    await w.pollOnce();
    const pass = await tick(w, 15_000);
    expect(fake.ids).toEqual([ids[1]]);
    expect(pass.imported).toEqual([{ name: "holes.stl", modelId: "model-1", fileId: ids[1] }]);
  });

  test("the database is asked about every id of the copy in one query per try", async () => {
    const fake = fakeIngest();
    await writeFile(join(inbox, "once.stl"), "solid once\nendsolid once\n");
    const all = await Promise.all(
      Array.from({ length: MAX_INBOX_IDS }, (_, attempt) => inboxIdOf("once.stl", attempt)),
    );
    const first = all[0] as string;
    const queries: ImportedQuery[] = [];
    const rows = new Map<string, ImportedFile>([
      [first, { modelId: "model-trashed", fileId: first, live: false }],
    ]);
    const w = watcher(fake, { findImported: rowsIn(rows, queries) });
    await w.pollOnce();
    await tick(w, 15_000);
    expect(fake.calls).toEqual(["once.stl"]);
    expect(queries).toHaveLength(1);
    // Every id this copy can have, attempt 0 first.
    expect(queries[0]?.fileIds).toEqual(all);
  });

  test(`after ${MAX_INBOX_IDS} ids all taken by trashed models, nothing is uploaded and the try counts against the file`, async () => {
    const fake = fakeIngest();
    const asked: ImportedQuery[] = [];
    const w = watcher(fake, {
      findImported: async (file) => {
        asked.push(file);
        return file.fileIds.map((fileId) => ({ modelId: "model-trashed", fileId, live: false }));
      },
    });
    await writeFile(join(inbox, "full.stl"), "solid full\nendsolid full\n");
    await w.pollOnce();
    const pass = await tick(w, 15_000);
    expect(asked).toHaveLength(1);
    expect(new Set(asked[0]?.fileIds).size).toBe(MAX_INBOX_IDS);
    expect(fake.calls).toEqual([]);
    expect(pass.failed).toEqual([]);
    expect(lines.some((l) => l.includes(`try 1 of ${STRIKES}`))).toBe(true);
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
        lookups.push(copyAsked(file));
        return [];
      },
    });
    await writeFile(join(inbox, "a.stl"), "solid a\nendsolid a\n");
    const a = await inboxIdOf("a.stl");
    await w.pollOnce();
    await tick(w, 15_000);
    down = false;
    await tick(w, 5_000);
    expect(fake.calls).toEqual(["a.stl", "a.stl"]);
    expect(lookups).toEqual([a, a]);
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

describe("ingest's error codes", () => {
  // Since Task 9, ingestFile wraps any failure that is not its own (the
  // database, the filesystem, the store refusing) in IngestError
  // ingest_failed, with the original error as its cause. That says nothing
  // about the file, so only unsupported_type and model_not_found send a file
  // to failed at once.
  const wrapped = (cause?: unknown) =>
    new IngestError(
      "ingest_failed",
      INGEST_FAILED_MESSAGE,
      cause === undefined ? undefined : { cause },
    );
  const diskFull = coded("could not extend file: No space left on device", "53100");

  test.each([
    ["unsupported_type", "This file is not a supported file; nothing was saved"],
    ["model_not_found", "That model does not exist or is in the trash; nothing was saved"],
  ] as const)(
    "IngestError %s moves the file to failed at once, without checking the environment",
    async (code, message) => {
      const fake = fakeIngest(() => {
        throw new IngestError(code, message);
      });
      const { probes, at } = checks(() => false);
      const w = watcher(fake, { probes });
      await writeFile(join(inbox, "a.stl"), "solid a\nendsolid a\n");
      await w.pollOnce();
      const pass = await tick(w, 15_000);
      expect(pass.failed).toEqual([{ name: "a.stl", reason: `${message}.` }]);
      expect(at).toEqual([]);
    },
  );

  const notTheFiles: Array<[string, unknown]> = [
    ["ingest_failed from a full disk (53100)", wrapped(diskFull)],
    ["ingest_failed from a TypeError", wrapped(new TypeError("Cannot read properties"))],
    ["ingest_failed from a refused connection", wrapped(coded("connect", "ECONNREFUSED"))],
    ["ingest_failed with no cause", wrapped()],
    ["IngestOutcomeUnknown", new IngestOutcomeUnknown(coded("connection lost", "08006"))],
  ];

  test.each(notTheFiles)(
    "with the checks failing, %s leaves every file in place and stops the pass",
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
      for (let i = 0; i < 60; i += 1) expect((await tick(w, 5_000)).failed).toEqual([]);
      expect(await exists(join(inbox, FAILED_DIR))).toBe(false);

      down = false;
      const back = await tick(w, BACKOFF_MAX_MS);
      expect(back.imported.map((i) => i.name)).toEqual(["a.stl", "b.stl"]);
    },
  );

  test(`with the checks passing, ingest_failed counts against the file: it moves to failed after ${STRIKES} tries, its cause in the reason`, async () => {
    const error = wrapped(new TypeError("boom in the parser"));
    const fake = fakeIngest((input) => {
      if (input.originalName === "a.stl") throw error;
    });
    const w = watcher(fake);
    await writeFile(join(inbox, "a.stl"), "solid a\nendsolid a\n");
    await writeFile(join(inbox, "b.stl"), "solid b\nendsolid b\n");
    await w.pollOnce();
    const first = await tick(w, 15_000);
    expect(first.failed).toEqual([]);
    expect(first.imported.map((i) => i.name)).toEqual(["b.stl"]);
    expect((await tick(w, 5_000)).failed).toEqual([]);
    const third = await tick(w, 5_000);
    expect(third.failed).toEqual([{ name: "a.stl", reason: repeatedErrorReason(error) }]);
    // The reason names what went wrong, not only ingest's general message.
    expect(repeatedErrorReason(error)).toContain("TypeError: boom in the parser");
    expect(fake.calls.filter((n) => n === "a.stl")).toHaveLength(STRIKES);
  });

  test("two files whose ingest_failed errors have different causes each take their strikes; the inbox is not held", async () => {
    const boom = wrapped(new TypeError("boom in the parser"));
    const denied = wrapped(coded("EACCES: permission denied, open 'b.stl'", "EACCES"));
    const fake = fakeIngest((input) => {
      if (input.originalName === "a.stl") throw boom;
      if (input.originalName === "b.stl") throw denied;
    });
    const w = watcher(fake);
    for (const name of ["a.stl", "b.stl", "c.stl"]) {
      await writeFile(join(inbox, name), `solid ${name}\nendsolid ${name}\n`);
    }
    await w.pollOnce();
    const first = await tick(w, 15_000);
    expect(first.waiting).toBe(false);
    expect(first.imported.map((i) => i.name)).toEqual(["c.stl"]);
    await tick(w, 5_000);
    const last = await tick(w, 5_000);
    expect(last.failed.map((f) => f.name)).toEqual(["a.stl", "b.stl"]);
    expect(lines.filter((l) => l.includes("the checks cannot see"))).toEqual([]);
  });

  test("two files whose ingest_failed errors have the same cause hold the inbox", async () => {
    const fake = fakeIngest(() => {
      throw wrapped(coded("could not extend file: No space left on device", "53100"));
    });
    const w = watcher(fake);
    for (const name of ["a.stl", "b.stl", "c.stl"]) {
      await writeFile(join(inbox, name), `solid ${name}\nendsolid ${name}\n`);
    }
    await w.pollOnce();
    const pass = await tick(w, 15_000);
    expect(pass.waiting).toBe(true);
    expect(fake.calls).toEqual(["a.stl", "b.stl"]);
    const started = lines.filter((l) => l.includes("the checks cannot see"));
    expect(started).toHaveLength(1);
    expect(started[0]).toContain("No space left on device");
  });

  test("a file removed while ingest reads it (ENOENT inside ingest_failed) is forgotten, not counted or moved", async () => {
    const fake = fakeIngest(async (input) => {
      await rm(input.tmpPath);
      throw wrapped(coded(`ENOENT: no such file or directory, open '${input.tmpPath}'`, "ENOENT"));
    });
    const { probes, at } = checks(() => false);
    const w = watcher(fake, { probes });
    await writeFile(join(inbox, "a.stl"), "solid a\nendsolid a\n");
    await w.pollOnce();
    const pass = await tick(w, 15_000);
    expect(pass.failed).toEqual([]);
    expect(pass.waiting).toBe(false);
    expect(at).toEqual([]);
    expect(
      lines.some((l) => l.includes("was removed from the inbox while it was being imported")),
    ).toBe(true);
  });
});

describe("the checks", () => {
  // The store check itself; the database check needs a real Postgres and is
  // in test/integration/inbox/.
  const listed = { objects: [], next: undefined };

  test("the store check fails when the store will not take a write, though it still lists", async () => {
    const store = {
      listPage: async () => listed,
      checkWrite: async () => {
        throw new StoreError("PutObject", "QuotaExceeded", 403);
      },
    };
    const probes = inboxProbes({ db: {} as never, store });
    await expect(probes.store()).rejects.toThrow(/QuotaExceeded/);
  });

  test("the store check fails when the listing fails, though writes work", async () => {
    const store = {
      listPage: async () => {
        throw new StoreError("ListObjectsV2", "AccessDenied", 403);
      },
      checkWrite: async () => undefined,
    };
    const probes = inboxProbes({ db: {} as never, store });
    await expect(probes.store()).rejects.toThrow(/AccessDenied/);
  });

  test("the store check passes when the store lists and takes a write", async () => {
    let writes = 0;
    const store = {
      listPage: async () => listed,
      checkWrite: async () => {
        writes += 1;
      },
    };
    const probes = inboxProbes({ db: {} as never, store });
    await expect(probes.store()).resolves.toBeUndefined();
    expect(writes).toBe(1);
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

    // Ten minutes, short of the first try after the wait reaches 5 minutes
    // (5 + 10 + ... + 160 + 300 s = 615 s), when tries count again.
    for (let i = 0; i < 120; i += 1) {
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
    // Once the wait is 5 minutes each try counts against the files, so they
    // move to failed after STRIKES such tries and are not tried again.
    expect(gaps).toEqual([
      5_000,
      10_000,
      20_000,
      40_000,
      80_000,
      160_000,
      ...Array(STRIKES).fill(BACKOFF_MAX_MS),
    ]);
    expect(gaps.every((g) => g <= BACKOFF_MAX_MS)).toBe(true);
  });

  test("the first file's failure in a held pass does not count against it", async () => {
    // a.stl fails the same way as the fault, and keeps failing once it is
    // over, so it is bad on its own; b.stl fails only while the disk is full.
    let broken = true;
    const boom = diskFull;
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

  test("a file's last strike does not move it to failed when a second file fails the same way in the same pass", async () => {
    // The fault meets a.stl alone first, while b.stl has not settled.
    let broken = false;
    const fake = fakeIngest((input) => {
      if (input.originalName === "a.stl") throw diskFull;
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

  test("two files that each fail on their own, with different errors, each take their strikes and move to failed, and the file after them imports", async () => {
    // a.stl breaks the parser; b.stl was dropped in by another uid with mode
    // 0600, so reading it fails with EACCES. The checks pass for both.
    const boom = new TypeError("boom in the parser");
    const denied = coded("EACCES: permission denied, open 'b.stl'", "EACCES");
    const fake = fakeIngest((input) => {
      if (input.originalName === "a.stl") throw boom;
      if (input.originalName === "b.stl") throw denied;
    });
    const w = watcher(fake);
    for (const name of ["a.stl", "b.stl", "c.stl"]) {
      await writeFile(join(inbox, name), `solid ${name}\nendsolid ${name}\n`);
    }
    await w.pollOnce();
    const first = await tick(w, 15_000);
    expect(first.waiting).toBe(false);
    expect(first.imported.map((i) => i.name)).toEqual(["c.stl"]);
    await tick(w, 5_000);
    const last = await tick(w, 5_000);
    expect(last.failed).toEqual([
      { name: "a.stl", reason: repeatedErrorReason(boom) },
      { name: "b.stl", reason: repeatedErrorReason(denied) },
    ]);
    expect(fake.calls.filter((n) => n === "a.stl")).toHaveLength(STRIKES);
    expect(fake.calls.filter((n) => n === "b.stl")).toHaveLength(STRIKES);
    expect(lines.filter((l) => l.includes("the checks cannot see"))).toEqual([]);
    expect((await readdir(inbox)).sort()).toEqual([FAILED_DIR]);
  });

  test("two files that each fail on their own the same way are held at first, then once the wait is 5 minutes their tries count, so they reach failed and the file after them imports", async () => {
    // Each throws its own TypeError with the same message: nothing tells it
    // from a fault the checks cannot see, so the inbox is held at first.
    const reasons = new Map<string, TypeError>();
    const imported: number[] = [];
    const fake = fakeIngest((input) => {
      if (input.originalName === "c.stl") {
        imported.push(clock);
        return;
      }
      const error = new TypeError("boom in the parser");
      reasons.set(input.originalName, error);
      throw error;
    });
    const w = watcher(fake);
    for (const name of ["a.stl", "b.stl", "c.stl"]) {
      await writeFile(join(inbox, name), `solid ${name}\nendsolid ${name}\n`);
    }
    await w.pollOnce();
    const held = await tick(w, 15_000);
    const start = clock;
    expect(held.waiting).toBe(true);
    expect(fake.calls).toEqual(["a.stl", "b.stl"]);

    const failed: Array<{ name: string; reason: string }> = [];
    // A poll every 5 s for 25 minutes.
    for (let i = 0; i < 300; i += 1) failed.push(...(await tick(w, 5_000)).failed);

    // c.stl imports at the first try after a 5-minute wait: 615 s in.
    expect(imported).toEqual([start + 615_000]);
    expect(failed).toEqual([
      { name: "a.stl", reason: repeatedErrorReason(reasons.get("a.stl")) },
      { name: "b.stl", reason: repeatedErrorReason(reasons.get("b.stl")) },
    ]);
    // Seven held tries, then STRIKES that counted.
    expect(fake.calls.filter((n) => n === "a.stl")).toHaveLength(7 + STRIKES);
    expect((await readdir(inbox)).sort()).toEqual([FAILED_DIR]);
    expect(lines.filter((l) => l.includes("the checks cannot see"))).toHaveLength(1);
    expect(lines.filter((l) => l.includes("now count against"))).toHaveLength(1);
  });

  test("files taken out during the hold leave no memory of it: a later pair failing the same way is held from the start, 5 s first, and logged", async () => {
    const tries: number[] = [];
    const fake = fakeIngest((input) => {
      if (input.originalName === "c.stl") tries.push(clock);
      throw diskFull;
    });
    const w = watcher(fake);
    await writeFile(join(inbox, "a.stl"), "solid a\nendsolid a\n");
    await writeFile(join(inbox, "b.stl"), "solid b\nendsolid b\n");
    await w.pollOnce();
    expect((await tick(w, 15_000)).waiting).toBe(true);

    // Jon takes both files out during the hold; the retry finds nothing to try.
    await rm(join(inbox, "a.stl"));
    await rm(join(inbox, "b.stl"));
    const empty = await tick(w, BACKOFF_FIRST_MS);
    expect(empty.waiting).toBe(false);
    expect(fake.calls).toEqual(["a.stl", "b.stl"]);
    // The end of the hold is logged even though no file was tried.
    expect(lines.filter((l) => l.includes("hold") && l.includes("over"))).toHaveLength(1);

    // Days later, two new files meet a full disk.
    clock += 3 * 86_400_000;
    await writeFile(join(inbox, "c.stl"), "solid c\nendsolid c\n");
    await writeFile(join(inbox, "d.stl"), "solid d\nendsolid d\n");
    await w.pollOnce();
    const held = await tick(w, 15_000);
    expect(held.waiting).toBe(true);
    expect(held.failed).toEqual([]);
    expect(lines.filter((l) => l.includes("the checks cannot see"))).toHaveLength(2);
    // 50 s of polls: tries 5 s, 15 s and 35 s after the first.
    for (let i = 0; i < 10; i += 1) await tick(w, 5_000);
    // A new hold: its first wait is 5 s, then 10 s, then 20 s.
    expect(tries.slice(1, 4).map((t, i) => t - (tries[i] ?? 0))).toEqual([5_000, 10_000, 20_000]);
  });

  test("files that reached failed while held tries counted leave no memory of it: a later pair failing the same way is held again, not counted at once", async () => {
    const fake = fakeIngest(() => {
      throw diskFull;
    });
    const w = watcher(fake);
    await writeFile(join(inbox, "a.stl"), "solid a\nendsolid a\n");
    await writeFile(join(inbox, "b.stl"), "solid b\nendsolid b\n");
    await w.pollOnce();
    await tick(w, 15_000);
    // 25 minutes: seven held tries, then STRIKES that counted, and both are
    // in failed.
    for (let i = 0; i < 300; i += 1) await tick(w, 5_000);
    expect(
      (await readdir(join(inbox, FAILED_DIR))).filter((n) => !n.endsWith(REASON_SUFFIX)),
    ).toEqual(["a.stl", "b.stl"]);
    expect(lines.filter((l) => l.includes("now count against"))).toHaveLength(1);

    // Days later, two new files meet the same fault.
    clock += 3 * 86_400_000;
    await writeFile(join(inbox, "c.stl"), "solid c\nendsolid c\n");
    await writeFile(join(inbox, "d.stl"), "solid d\nendsolid d\n");
    await w.pollOnce();
    const held = await tick(w, 15_000);
    expect(held.waiting).toBe(true);
    expect(lines.filter((l) => l.includes("the checks cannot see"))).toHaveLength(2);
    // Ten minutes of held tries: neither takes a strike or reaches failed.
    for (let i = 0; i < 120; i += 1) expect((await tick(w, 5_000)).failed).toEqual([]);
    expect((await readdir(inbox)).sort()).toEqual(["c.stl", "d.stl", FAILED_DIR]);
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

  test("its reason gives the limit in bytes and in MiB, both worked out from the limit", () => {
    expect(TOO_LARGE_REASON).toBe(tooLargeReason(MAX_INBOX_BYTES));
    expect(TOO_LARGE_REASON).toContain("536870912 bytes (512 MiB)");
    // Another limit gives its own figures, not today's.
    expect(tooLargeReason(1_048_576)).toBe(
      "Platehouse could not import this file because it is larger than 1048576 bytes " +
        "(1 MiB), the most it takes; nothing was uploaded.",
    );
    expect(tooLargeReason(1_572_864)).toContain("1572864 bytes (1.5 MiB)");
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
        lookups.push(copyAsked(q));
        return [];
      },
    });
    await sparse(join(inbox, "big.3mf"), MAX_INBOX_BYTES + 1);
    await sparse(join(inbox, "edge.3mf"), MAX_INBOX_BYTES);
    const edge = await inboxIdOf("edge.3mf");
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
    // Only edge.3mf was asked about, under the id of its own size and bytes.
    expect(lookups).toEqual([edge]);
  });
});

describe("names that are not UTF-8", () => {
  const latin1 = (stem: number[]) => Buffer.concat([Buffer.from(stem), Buffer.from(".stl")]);
  // "caf\u00e9.stl" and "caf\u00e8.stl" as Latin-1: one byte each, neither valid UTF-8.
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
