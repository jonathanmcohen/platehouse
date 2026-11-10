// Build plan Task 10: the inbox watcher's own rules, with a fake ingest so no
// database or bucket is needed (the real pipeline is under
// test/integration/inbox/). These pin what the integration tests cannot reach
// cheaply: the exact settle boundary, every ignored name, the failed-folder
// names, and the paths that must never loop (a file that cannot be moved, an
// inbox copy that cannot be deleted) or lose a file without a word.
import { createHash } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  lstatSync,
  openSync,
  renameSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import {
  access,
  appendFile,
  chmod,
  type FileHandle,
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
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Estimates } from "../../src/estimates/service.js";
import {
  BACKOFF_FIRST_MS,
  BACKOFF_MAX_MS,
  CHANGED_REASON,
  createInboxWatcher,
  FAILED_DIR,
  HELD_REASON,
  HOLD_COPY_PREFIX,
  HOLD_PREFIX,
  type ImportedFile,
  type ImportedQuery,
  type InboxProbes,
  type InboxWatcherDeps,
  inboxFileId,
  inboxName,
  inboxProbes,
  isIgnoredName,
  MAX_INBOX_BYTES,
  MAX_INBOX_IDS,
  NON_UTF8_REASON,
  REASON_SUFFIX,
  repeatedErrorReason,
  STILL_WRITING_REASON,
  STRIKES,
  SWAPPED_REASON,
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

/**
 * Hooks into node:fs/promises, for faults and races a real folder cannot give
 * on demand (a full disk part way through a copy, an inbox file that will not
 * read, a file put under a name at one exact moment, a filesystem with no
 * hard links). Every other call, and every call while no test sets a hook,
 * reaches the real one; afterEach clears them.
 */
const fsHooks = vi.hoisted(() => ({
  /** What an open of path returns in place of the real handle. */
  wrap: undefined as ((path: string, handle: FileHandle) => FileHandle) | undefined,
  /**
   * Runs before a hard link from existingPath to newPath is made, as another
   * writer would in that moment; when it throws, the link fails with that
   * error, as under fs.protected_hardlinks or on a filesystem that refuses
   * hard links.
   */
  beforeLink: undefined as ((newPath: string, existingPath: string) => Promise<void>) | undefined,
  /** Runs before a folder is made at path; when it throws, mkdir fails with that error. */
  beforeMkdir: undefined as ((path: string) => Promise<void>) | undefined,
  /**
   * Runs just before anything is made under newPath by a rename onto it, a
   * symlink at it, a copy to it or an open that may create it: the last
   * moment another writer can take the name first.
   */
  beforeCreate: undefined as ((newPath: string) => Promise<void>) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const { constants } = await import("node:fs");
  const creates = (flags: unknown) =>
    typeof flags === "number" ? (flags & constants.O_CREAT) !== 0 : /[wax]/.test(String(flags));
  const open = async (...args: Parameters<typeof actual.open>): Promise<FileHandle> => {
    if (args[1] !== undefined && creates(args[1])) await fsHooks.beforeCreate?.(String(args[0]));
    const handle = await actual.open(...args);
    return fsHooks.wrap?.(String(args[0]), handle) ?? handle;
  };
  const link = async (...args: Parameters<typeof actual.link>): Promise<void> => {
    await fsHooks.beforeLink?.(String(args[1]), String(args[0]));
    return actual.link(...args);
  };
  const mkdir = async (...args: Parameters<typeof actual.mkdir>) => {
    await fsHooks.beforeMkdir?.(String(args[0]));
    return actual.mkdir(...args);
  };
  const rename = async (...args: Parameters<typeof actual.rename>): Promise<void> => {
    await fsHooks.beforeCreate?.(String(args[1]));
    return actual.rename(...args);
  };
  const symlink = async (...args: Parameters<typeof actual.symlink>): Promise<void> => {
    await fsHooks.beforeCreate?.(String(args[1]));
    return actual.symlink(...args);
  };
  const copyFile = async (...args: Parameters<typeof actual.copyFile>): Promise<void> => {
    await fsHooks.beforeCreate?.(String(args[1]));
    return actual.copyFile(...args);
  };
  const hooked = { open, link, rename, symlink, copyFile, mkdir };
  return { ...actual, default: { ...actual, ...hooked }, ...hooked };
});

/** The handle with some methods replaced; every other call reaches the real handle. */
function patched(handle: FileHandle, methods: Record<string, unknown>): FileHandle {
  return new Proxy(handle, {
    get(target, prop) {
      if (typeof prop === "string" && Object.hasOwn(methods, prop)) return methods[prop];
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Makes the first open of the inbox file at path run change just after the
 * watcher's fstat on it, as a writer appending or truncating in that moment
 * would: the file has settled and been checked, and only then changes.
 */
function changeAfterCheck(path: string, change: () => Promise<void>): void {
  let pending = true;
  fsHooks.wrap = (opened, handle) => {
    if (opened !== path) return handle;
    return patched(handle, {
      stat: async (...args: unknown[]) => {
        const st: unknown = await Reflect.apply(handle.stat, handle, args);
        if (pending) {
          pending = false;
          await change();
        }
        return st;
      },
    });
  };
}

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
  fsHooks.wrap = undefined;
  fsHooks.beforeLink = undefined;
  fsHooks.beforeMkdir = undefined;
  fsHooks.beforeCreate = undefined;
  await chmod(inbox, 0o755).catch(() => undefined);
  await chmod(join(root, "tmp", "inbox-copies"), 0o755).catch(() => undefined);
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
    tmpDir: join(root, "tmp"),
    ingest: fake.ingest,
    storedFile: async (id) => fake.stored.get(id),
    findImported: async () => [],
    // Required; the tests under "after ingest" pass their own to watch it.
    onIngested: async () => undefined,
    // Storage, the database and the temp folder answer unless a test says otherwise.
    probes: {
      database: async () => undefined,
      store: async () => undefined,
      tmpDir: async () => undefined,
    },
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
    tmpDir: async () => undefined,
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
        await appendFile(join(inbox, "changing.stl"), "more bytes\n");
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

  test("onIngested is required, and the server's estimates wiring queues the stored file", async () => {
    const fake = fakeIngest();
    const without: Omit<InboxWatcherDeps, "onIngested"> = {
      dir: inbox,
      settleSeconds: 15,
      tmpDir: join(root, "tmp"),
      ingest: fake.ingest,
      storedFile: async (id) => fake.stored.get(id),
      findImported: async () => [],
      probes: {
        database: async () => undefined,
        store: async () => undefined,
        tmpDir: async () => undefined,
      },
      now: () => clock,
      log: (line) => lines.push(line),
    };
    // @ts-expect-error A watcher built without onIngested must not compile, or
    // inbox plates would wait for the 10-minute Orca poll; pnpm tsc -b checks
    // this line, since vitest does not type-check.
    const missing: InboxWatcherDeps = without;
    expect(missing.dir).toBe(inbox);

    const queued: string[] = [];
    const estimates: Pick<Estimates, "enqueueFile"> = {
      enqueueFile: async (fileId) => {
        queued.push(fileId);
        return 1;
      },
    };
    // The wiring the watch.ts header gives the server, as written there.
    const w = createInboxWatcher({
      ...without,
      onIngested: (r) => estimates.enqueueFile(r.fileId),
    });
    await writeFile(join(inbox, "wired.stl"), "solid w\nendsolid w\n");
    await w.pollOnce();
    const pass = await tick(w, 15_000);
    expect(pass.imported).toHaveLength(1);
    expect(queued).toEqual([pass.imported[0]?.fileId]);
  });
});

describe("a symlink swapped in for a settled file", () => {
  // The only check on what a name is happens at the listing's lstat. These
  // pin that the watcher reads the file it checked and never follows a link
  // put in its place afterwards (the header: symlinks are never imported).
  const OUTSIDE_TEXT = "not a model, and not the inbox's to read\n";

  /** Renames a symlink to target over the inbox name, as a hostile writer would. */
  function swapInLink(target: string, name: string): void {
    symlinkSync(target, join(inbox, "link.swap.part"));
    renameSync(join(inbox, "link.swap.part"), join(inbox, name));
  }

  test("a link swapped in after the check and before the file is opened is not followed or imported", async () => {
    const fake = fakeIngest();
    let swap = false;
    const outside = join(root, "outside.scad");
    const w = watcher(fake, {
      // now() is read just after the file's lstat, before it is opened.
      now: () => {
        if (swap) {
          swap = false;
          swapInLink(outside, "model.scad");
        }
        return clock;
      },
    });
    await writeFile(outside, OUTSIDE_TEXT);
    await writeFile(join(inbox, "model.scad"), "cube(1);\n");
    await w.pollOnce();
    swap = true;
    const pass = await tick(w, 15_000);

    expect(fake.calls).toEqual([]);
    expect(pass.imported).toEqual([]);
    expect(pass.failed).toEqual([]);
    expect((await lstat(join(inbox, "model.scad"))).isSymbolicLink()).toBe(true);
    expect(await readFile(outside, "utf8")).toBe(OUTSIDE_TEXT);
    expect(await exists(join(inbox, FAILED_DIR))).toBe(false);
    // The link is ignored from then on, as any symlink is.
    await tick(w, 15_000);
    await tick(w, 15_000);
    expect(fake.calls).toEqual([]);
  });

  test("a link swapped in once the file is open imports the settled bytes, and the link is left alone", async () => {
    const fake = fakeIngest();
    const outside = join(root, "outside.scad");
    const original = "cube(2);\n";
    const tmpPaths: string[] = [];
    const ingest = {
      async ingestFile(input: IngestInput) {
        tmpPaths.push(input.tmpPath);
        return fake.ingest.ingestFile(input);
      },
    };
    const w = watcher(fake, {
      ingest,
      // Asked before the upload, after the file is opened: the swap lands in
      // the window the database round trip leaves.
      findImported: async () => {
        swapInLink(outside, "model.scad");
        return [];
      },
    });
    await writeFile(outside, OUTSIDE_TEXT);
    await writeFile(join(inbox, "model.scad"), original);
    await w.pollOnce();
    const pass = await tick(w, 15_000);

    expect(pass.imported).toHaveLength(1);
    const fileId = pass.imported[0]?.fileId ?? "";
    expect(fake.stored.get(fileId)?.sha256).toEqual(sha256(Buffer.from(original)));
    // Ingest read the watcher's own copy, never a path in the inbox, and the
    // copy is gone once ingest is done with it.
    expect(tmpPaths).toHaveLength(1);
    expect(tmpPaths[0]?.startsWith(join(root, "tmp"))).toBe(true);
    expect(await exists(tmpPaths[0] ?? "")).toBe(false);
    // The link is neither deleted nor moved, and what it points at is untouched.
    expect((await lstat(join(inbox, "model.scad"))).isSymbolicLink()).toBe(true);
    expect(await readFile(outside, "utf8")).toBe(OUTSIDE_TEXT);
    expect(await exists(join(inbox, FAILED_DIR))).toBe(false);
  });
});

/** Writes a new file and renames it over the inbox name, as rsync does: a new inode under the name. */
function renameOverSync(name: string, text: string): void {
  const temp = join(inbox, `.${name}.swap`);
  writeFileSync(temp, text);
  renameSync(temp, join(inbox, name));
}

describe("a file put under an imported file's name while it is checked", () => {
  // After an import the watcher checks the inbox copy and deletes it. A writer
  // that renames a new file over the name in that time (rsync does this) must
  // never lose that file: it was never imported, and the inbox copy can be
  // its only copy.
  const FIRST = "solid first\nendsolid first\n";
  const SECOND = "solid second, a different file\nendsolid second\n";

  test.each([
    ["while the stored record is read", "record"],
    ["while the open inbox file is hashed again", "hash"],
  ])(
    "a same-named file renamed in %s is not deleted, and is imported as a file of its own",
    async (_l, when) => {
      const fake = fakeIngest();
      const path = join(inbox, "part.stl");
      let pending = true;
      const swap = () => {
        if (!pending) return;
        pending = false;
        renameOverSync("part.stl", SECOND);
      };
      if (when === "hash") {
        // The check after the import reads the open file with createReadStream;
        // the copy before it reads with read, so this runs only for the check.
        fsHooks.wrap = (opened, handle) => {
          if (opened !== path) return handle;
          return patched(handle, {
            createReadStream: (...args: unknown[]) => {
              swap();
              return Reflect.apply(handle.createReadStream, handle, args);
            },
          });
        };
      }
      const w = watcher(fake, {
        storedFile: async (id) => {
          if (when === "record") swap();
          return fake.stored.get(id);
        },
      });
      await writeFile(path, FIRST);
      await w.pollOnce();
      const pass = await tick(w, 15_000);

      expect(pending).toBe(false);
      expect(pass.imported.map((i) => i.name)).toEqual(["part.stl"]);
      expect(pass.failed).toEqual([]);
      // The new file is still under the name, untouched, and nothing else is left.
      expect(await readFile(path, "utf8")).toBe(SECOND);
      expect(await readdir(inbox)).toEqual(["part.stl"]);
      expect(
        lines.some(
          (l) => l.includes("part.stl") && l.includes("another file was put under its name"),
        ),
      ).toBe(true);

      // It is a new file: it settles and is imported as a model of its own.
      await tick(w, 5_000);
      const again = await tick(w, 15_000);
      expect(fake.calls).toEqual(["part.stl", "part.stl"]);
      expect(again.imported).toHaveLength(1);
      const fileId = again.imported[0]?.fileId ?? "";
      expect(fake.stored.get(fileId)?.sha256).toEqual(sha256(Buffer.from(SECOND)));
      expect(await readdir(inbox)).toEqual([]);
    },
  );

  test("a same-named file that cannot be put back because a third took the name moves to failed, not lost", async () => {
    const fake = fakeIngest();
    const path = join(inbox, "part.stl");
    const THIRD = "solid third\nendsolid third\n";
    let pending = true;
    fsHooks.beforeLink = async (newPath) => {
      if (newPath === path) await writeFile(path, THIRD);
    };
    const w = watcher(fake, {
      storedFile: async (id) => {
        if (pending) {
          pending = false;
          renameOverSync("part.stl", SECOND);
        }
        return fake.stored.get(id);
      },
    });
    await writeFile(path, FIRST);
    await w.pollOnce();
    const pass = await tick(w, 15_000);

    expect(pass.imported.map((i) => i.name)).toEqual(["part.stl"]);
    expect(pass.failed).toEqual([{ name: "part.stl", reason: SWAPPED_REASON }]);
    expect(await readFile(join(inbox, FAILED_DIR, "part.stl"), "utf8")).toBe(SECOND);
    expect(await readFile(join(inbox, FAILED_DIR, `part.stl${REASON_SUFFIX}`), "utf8")).toBe(
      `${SWAPPED_REASON}\n`,
    );
    expect(await readFile(path, "utf8")).toBe(THIRD);
    expect((await readdir(inbox)).sort()).toEqual([FAILED_DIR, "part.stl"].sort());
  });

  test("a file left in a holding folder by a process that stopped part way moves to failed with a reason", async () => {
    const fake = fakeIngest();
    const holding = join(inbox, `${HOLD_PREFIX}0190a6f0-0000-7000-8000-000000000000`);
    await mkdir(holding);
    await writeFile(join(holding, "left.stl"), FIRST);
    const w = watcher(fake);
    const pass = await w.pollOnce();

    expect(pass.failed).toEqual([{ name: "left.stl", reason: HELD_REASON }]);
    expect(await readFile(join(inbox, FAILED_DIR, "left.stl"), "utf8")).toBe(FIRST);
    expect(await readFile(join(inbox, FAILED_DIR, `left.stl${REASON_SUFFIX}`), "utf8")).toBe(
      `${HELD_REASON}\n`,
    );
    expect(await readdir(inbox)).toEqual([FAILED_DIR]);
    expect(fake.calls).toEqual([]);
  });

  test("a file overwritten in place after its check and before it is deleted is kept in failed, never deleted", async () => {
    // Windows Explorer, or cp onto an existing name, writes the same inode
    // (O_TRUNC): the device and inode under the name still match the open
    // file, but the bytes are new and were never imported.
    const fake = fakeIngest();
    const path = join(inbox, "part.stl");
    let overwritten = false;
    fsHooks.beforeCreate = async (newPath) => {
      // The last moment before the delete: the move into the holding folder.
      if (overwritten || !newPath.startsWith(join(inbox, HOLD_PREFIX))) return;
      overwritten = true;
      writeFileSync(path, SECOND);
    };
    const w = watcher(fake);
    await writeFile(path, FIRST);
    const before = await lstat(path, { bigint: true });
    await w.pollOnce();
    const pass = await tick(w, 15_000);

    expect(overwritten).toBe(true);
    expect(pass.imported.map((i) => i.name)).toEqual(["part.stl"]);
    expect(pass.failed).toEqual([{ name: "part.stl", reason: CHANGED_REASON }]);
    const kept = join(inbox, FAILED_DIR, "part.stl");
    expect(await readFile(kept, "utf8")).toBe(SECOND);
    expect((await lstat(kept, { bigint: true })).ino).toBe(before.ino);
    expect(await readFile(`${kept}${REASON_SUFFIX}`, "utf8")).toBe(`${CHANGED_REASON}\n`);
    expect(await readdir(inbox)).toEqual([FAILED_DIR]);
    expect(lines.some((l) => l.includes("deleted the inbox copy"))).toBe(false);
  });
});

describe("a file put under an imported file's name during the import", () => {
  // A writer can rename a new file over the name while ingest uploads the old
  // one (the longest step) or while onIngested runs. That new file was never
  // imported: it stays in the inbox, untouched, and is imported later as a
  // file of its own, never moved to failed with a reason that says a model
  // was made from it. The import that finished stands.
  const FIRST = "solid first\nendsolid first\n";
  const SECOND = "solid second, a different file\nendsolid second\n";

  test.each([
    ["during ingest", "ingest", "found"],
    ["while onIngested runs", "onIngested", "found"],
    ["during ingest, with no record of the stored file", "ingest", "missing"],
  ])(
    "a new file renamed over the name %s stays in the inbox and is imported later as its own model",
    async (_l, when, record) => {
      const path = join(inbox, "part.stl");
      // The new file as it was put there, to see that it is left untouched.
      let swappedIn: BigIntStats | undefined;
      const swap = () => {
        renameOverSync("part.stl", SECOND);
        swappedIn = lstatSync(path, { bigint: true });
      };
      let ingested = 0;
      const fake = fakeIngest(() => {
        ingested += 1;
        // Ingest has the watcher's copy; the swap lands while it uploads.
        if (when === "ingest" && ingested === 1) swap();
      });
      let pending = true;
      const w = watcher(fake, {
        onIngested: async () => {
          if (when === "onIngested" && pending) {
            pending = false;
            swap();
          }
        },
        // The first import's record is missing in the "missing" case; the
        // later import of the new file is confirmed as usual.
        storedFile: async (id) =>
          record === "missing" && fake.calls.length === 1 ? undefined : fake.stored.get(id),
      });
      await writeFile(path, FIRST);
      const firstId = await inboxIdOf("part.stl");
      await w.pollOnce();
      const pass = await tick(w, 15_000);

      // The first import stands.
      expect(pass.imported).toEqual([{ name: "part.stl", modelId: "model-1", fileId: firstId }]);
      expect(fake.stored.get(firstId)?.sha256).toEqual(sha256(Buffer.from(FIRST)));
      // The new file is left under the name, untouched, and nothing went to failed.
      expect(pass.failed).toEqual([]);
      expect(await exists(join(inbox, FAILED_DIR))).toBe(false);
      expect(await readFile(path, "utf8")).toBe(SECOND);
      expect(await readdir(inbox)).toEqual(["part.stl"]);
      expect(lines.some((l) => l.includes(`moved part.stl to ${FAILED_DIR}`))).toBe(false);
      // Untouched: never moved aside and linked or copied back, which would
      // change its inode or its ctime.
      const now = await lstat(path, { bigint: true });
      expect(swappedIn).toBeDefined();
      expect([now.ino, now.ctimeNs]).toEqual([swappedIn?.ino, swappedIn?.ctimeNs]);

      // It is a new file: it settles and is imported as a model of its own.
      await tick(w, 5_000);
      const again = await tick(w, 15_000);
      expect(fake.calls).toEqual(["part.stl", "part.stl"]);
      expect(again.imported).toHaveLength(1);
      const secondId = again.imported[0]?.fileId ?? "";
      expect(secondId).not.toBe(firstId);
      expect(fake.stored.get(secondId)?.sha256).toEqual(sha256(Buffer.from(SECOND)));
      expect(again.failed).toEqual([]);
      expect(await readdir(inbox)).toEqual([]);
    },
  );

  test.each([
    ["no record of the stored file is found", "missing"],
    ["the stored record does not match", "mismatch"],
  ])(
    "when %s, a new file renamed over the name before it is moved is not moved to failed, and is imported later",
    async (_l, record) => {
      const fake = fakeIngest();
      const path = join(inbox, "part.stl");
      let first = true;
      const swapOnce = () => {
        if (!first) return;
        first = false;
        renameOverSync("part.stl", SECOND);
      };
      const w = watcher(fake, {
        storedFile: async (id) => {
          const real = fake.stored.get(id);
          if (fake.calls.length > 1) return real;
          if (record === "missing") {
            // The record read is the last step before the move.
            swapOnce();
            return undefined;
          }
          return { size: 1, sha256: Buffer.alloc(32) };
        },
      });
      if (record === "mismatch") {
        // The check hashes the open file with createReadStream (the copy
        // before it reads with read), and then moves what holds the name.
        fsHooks.wrap = (opened, handle) => {
          if (opened !== path) return handle;
          return patched(handle, {
            createReadStream: (...args: unknown[]) => {
              swapOnce();
              return Reflect.apply(handle.createReadStream, handle, args);
            },
          });
        };
      }
      await writeFile(path, FIRST);
      await w.pollOnce();
      const pass = await tick(w, 15_000);

      expect(first).toBe(false);
      expect(pass.imported.map((i) => i.name)).toEqual(["part.stl"]);
      expect(pass.failed).toEqual([]);
      expect(await exists(join(inbox, FAILED_DIR))).toBe(false);
      expect(await readFile(path, "utf8")).toBe(SECOND);
      expect(await readdir(inbox)).toEqual(["part.stl"]);

      await tick(w, 5_000);
      const again = await tick(w, 15_000);
      expect(again.imported).toHaveLength(1);
      const fileId = again.imported[0]?.fileId ?? "";
      expect(fake.stored.get(fileId)?.sha256).toEqual(sha256(Buffer.from(SECOND)));
      expect(await readdir(inbox)).toEqual([]);
    },
  );

  test("a file that changed during its import, with no usable failed folder, stays in the inbox and is not tried again until it changes", async () => {
    const fake = fakeIngest();
    const ingest = {
      async ingestFile(input: IngestInput) {
        const result = await fake.ingest.ingestFile(input);
        await appendFile(join(inbox, "changing.stl"), "more bytes\n");
        return result;
      },
    };
    const w = watcher(fake, { ingest });
    // A plain file where the failed folder should be: nothing can move into it.
    await writeFile(join(inbox, FAILED_DIR), "in the way\n");
    const path = join(inbox, "changing.stl");
    await writeFile(path, "solid a\nendsolid a\n");
    await w.pollOnce();
    const pass = await tick(w, 15_000);

    expect(pass.failed).toEqual([]);
    expect(await readFile(path, "utf8")).toBe("solid a\nendsolid a\nmore bytes\n");
    expect((await readdir(inbox)).sort()).toEqual([FAILED_DIR, "changing.stl"].sort());
    expect(lines.some((l) => l.includes("changing.stl") && l.includes("could not move"))).toBe(
      true,
    );
    await tick(w, 15_000);
    await tick(w, 15_000);
    expect(fake.calls).toEqual(["changing.stl"]);
  });
});

describe("putting a file back under its name without hard links", () => {
  // A file found under an imported file's name is put back there, never over
  // a file that took the name since. Hard links make that one step; without
  // them (EPERM under fs.protected_hardlinks for a file the watcher does not
  // own, or a filesystem with none), or for a symlink, the put-back must
  // still refuse to replace what took the name.
  const FIRST = "solid first\nendsolid first\n";
  const SECOND = "solid second, a different file\nendsolid second\n";
  const THIRD = "solid third\nendsolid third\n";

  /**
   * Makes a hard link to path fail with EPERM as fs.protected_hardlinks does:
   * from the held file, which another user owns (the SMB writer), but not
   * from a file the watcher made itself. With every, any link to path fails,
   * as on a filesystem with no hard links at all.
   */
  function noHardLinks(
    path: string,
    onRefuse: () => void = () => undefined,
    every = false,
  ): void {
    fsHooks.beforeLink = async (newPath, existingPath) => {
      if (newPath !== path) return;
      if (!every && basename(existingPath) !== basename(path)) return;
      onRefuse();
      throw coded(`EPERM: operation not permitted, link '${newPath}'`, "EPERM");
    };
  }

  /** Whether opened is the held file: the name, inside a holding folder. */
  const isHeld = (opened: string, path: string) =>
    opened.startsWith(join(inbox, HOLD_PREFIX)) && basename(opened) === basename(path);

  /** Whether opened is a file the put-back may write: the name, or one in a holding folder. */
  const isPutBackWrite = (opened: string, path: string) =>
    opened === path || (opened.startsWith(join(inbox, HOLD_PREFIX)) && !isHeld(opened, path));

  test.each([
    ["a regular file, with link() refused", "file"],
    ["a symlink", "link"],
  ])(
    "putting back %s never overwrites a file that takes the name just before it",
    async (_l, what) => {
      const fake = fakeIngest();
      const path = join(inbox, "part.stl");
      const outside = join(root, "outside.stl");
      await writeFile(outside, "not the inbox's\n");
      // Armed once the put-back starts: the next thing made under the name.
      let armed = what === "link";
      noHardLinks(path, () => {
        armed = true;
      });
      let swapped = false;
      fsHooks.beforeCreate = async (newPath) => {
        if (!armed || !swapped || newPath !== path) return;
        armed = false;
        // A third file takes the name between any check and the put-back.
        renameOverSync("part.stl", THIRD);
      };
      const w = watcher(fake, {
        storedFile: async (id) => {
          if (!swapped) {
            swapped = true;
            if (what === "file") renameOverSync("part.stl", SECOND);
            else {
              symlinkSync(outside, join(inbox, "part.link.part"));
              renameSync(join(inbox, "part.link.part"), path);
            }
          }
          return fake.stored.get(id);
        },
      });
      await writeFile(path, FIRST);
      await w.pollOnce();
      const pass = await tick(w, 15_000);

      expect(armed).toBe(false);
      expect(pass.imported.map((i) => i.name)).toEqual(["part.stl"]);
      // The third file is never overwritten.
      expect((await lstat(path)).isFile()).toBe(true);
      expect(await readFile(path, "utf8")).toBe(THIRD);
      // What was held goes to failed, kept, with the reason that says so.
      expect(pass.failed).toEqual([{ name: "part.stl", reason: SWAPPED_REASON }]);
      const kept = join(inbox, FAILED_DIR, "part.stl");
      if (what === "file") expect(await readFile(kept, "utf8")).toBe(SECOND);
      else expect((await lstat(kept)).isSymbolicLink()).toBe(true);
      expect(await readFile(outside, "utf8")).toBe("not the inbox's\n");
      expect((await readdir(inbox)).sort()).toEqual([FAILED_DIR, "part.stl"].sort());
    },
  );

  test("with link() refused and the name free, the file is put back whole and imported later as its own model", async () => {
    const fake = fakeIngest();
    const path = join(inbox, "part.stl");
    noHardLinks(path);
    let swapped = false;
    const w = watcher(fake, {
      storedFile: async (id) => {
        if (!swapped) {
          swapped = true;
          renameOverSync("part.stl", SECOND);
        }
        return fake.stored.get(id);
      },
    });
    await writeFile(path, FIRST);
    await w.pollOnce();
    const pass = await tick(w, 15_000);

    expect(pass.failed).toEqual([]);
    expect(await readFile(path, "utf8")).toBe(SECOND);
    expect(await readdir(inbox)).toEqual(["part.stl"]);

    await tick(w, 5_000);
    const again = await tick(w, 15_000);
    expect(again.imported).toHaveLength(1);
    const fileId = again.imported[0]?.fileId ?? "";
    expect(fake.stored.get(fileId)?.sha256).toEqual(sha256(Buffer.from(SECOND)));
    expect(await readdir(inbox)).toEqual([]);
  });

  test.each([
    ["nothing else takes the name", false],
    ["another file is renamed over the name during the copy", true],
  ])(
    "with link() refused, a put-back on a full disk leaves nothing part-written under the name and loses no file (%s)",
    async (_l, newcomer) => {
      const fake = fakeIngest();
      const path = join(inbox, "part.stl");
      const FOURTH = "solid fourth\nendsolid fourth\n";
      let refused = false;
      noHardLinks(path, () => {
        refused = true;
      });
      // Once link() is refused the disk is full: a new holding folder cannot
      // be made, and a copy's writes fail after the first byte.
      fsHooks.beforeMkdir = async (made) => {
        if (refused && made.startsWith(join(inbox, HOLD_PREFIX))) {
          throw coded(`ENOSPC: no space left on device, mkdir '${made}'`, "ENOSPC");
        }
      };
      fsHooks.wrap = (opened, handle) => {
        if (!refused || !isPutBackWrite(opened, path)) return handle;
        let writes = 0;
        return patched(handle, {
          write: async (...args: unknown[]) => {
            writes += 1;
            if (writes > 1) {
              if (newcomer) renameOverSync("part.stl", FOURTH);
              throw coded("ENOSPC: no space left on device, write", "ENOSPC");
            }
            const [buffer, offset] = args as [Buffer, number];
            return Reflect.apply(handle.write, handle, [buffer, offset, 1, 0]);
          },
        });
      };
      let swapped = false;
      const w = watcher(fake, {
        storedFile: async (id) => {
          if (!swapped) {
            swapped = true;
            renameOverSync("part.stl", SECOND);
          }
          return fake.stored.get(id);
        },
      });
      await writeFile(path, FIRST);
      await w.pollOnce();
      const pass = await tick(w, 15_000);

      expect(refused).toBe(true);
      // The held file is kept whole in failed.
      expect(pass.failed).toEqual([{ name: "part.stl", reason: SWAPPED_REASON }]);
      expect(await readFile(join(inbox, FAILED_DIR, "part.stl"), "utf8")).toBe(SECOND);
      if (newcomer) {
        // A newcomer is left under the name, whole, never moved or deleted.
        expect(await readFile(path, "utf8")).toBe(FOURTH);
        expect((await readdir(inbox)).sort()).toEqual([FAILED_DIR, "part.stl"].sort());
        return;
      }
      // Nothing part-written is left under the name, or anywhere in the inbox.
      expect(await readdir(inbox)).toEqual([FAILED_DIR]);

      // A watcher started after a restart finds nothing to import.
      fsHooks.wrap = undefined;
      fsHooks.beforeMkdir = undefined;
      const restarted = watcher(fake);
      await restarted.pollOnce();
      await tick(restarted, 15_000);
      await tick(restarted, 15_000);
      expect(fake.calls).toEqual(["part.stl"]);
    },
  );

  test.each([
    ["while it is copied back", "copy"],
    ["just after the copy is linked under the name", "link"],
  ])(
    "with link() refused, a file still being written %s is kept whole in failed, and no cut-short copy is imported",
    async (_l, when) => {
      const fake = fakeIngest();
      const path = join(inbox, "part.stl");
      const MORE = "more bytes the writer sent\n";
      const LATER = "and more after the put-back\n";
      noHardLinks(path);
      // The writer, under another uid over SMB, keeps the file open.
      let writer: number | undefined;
      let appended = false;
      const append = () => {
        if (appended || writer === undefined) return;
        appended = true;
        writeSync(writer, MORE);
      };
      if (when === "copy") {
        // The writer sends more just as the copy is finished.
        fsHooks.wrap = (opened, handle) => {
          if (writer === undefined || !isPutBackWrite(opened, path)) return handle;
          return patched(handle, {
            close: async () => {
              append();
              return handle.close();
            },
          });
        };
      } else {
        const refuse = fsHooks.beforeLink;
        fsHooks.beforeLink = async (newPath, existingPath) => {
          await refuse?.(newPath, existingPath);
          // The copy's own link to the name: the writer sends more first.
          if (newPath === path) append();
        };
      }
      let swapped = false;
      const w = watcher(fake, {
        storedFile: async (id) => {
          if (!swapped) {
            swapped = true;
            renameOverSync("part.stl", SECOND);
            writer = openSync(path, "a");
          }
          return fake.stored.get(id);
        },
      });
      try {
        await writeFile(path, FIRST);
        await w.pollOnce();
        const pass = await tick(w, 15_000);
        expect(appended).toBe(true);
        if (writer !== undefined) writeSync(writer, LATER);

        // The writer's file is kept, the same inode, with everything it wrote.
        expect(pass.failed).toEqual([{ name: "part.stl", reason: STILL_WRITING_REASON }]);
        const kept = join(inbox, FAILED_DIR, "part.stl");
        expect(await readFile(kept, "utf8")).toBe(`${SECOND}${MORE}${LATER}`);
        expect(await readFile(`${kept}${REASON_SUFFIX}`, "utf8")).toBe(
          `${STILL_WRITING_REASON}\n`,
        );
        // No copy is left under the name to be imported cut short.
        expect(await readdir(inbox)).toEqual([FAILED_DIR]);
        await tick(w, 15_000);
        await tick(w, 15_000);
        expect(fake.calls).toEqual(["part.stl"]);
      } finally {
        if (writer !== undefined) closeSync(writer);
      }
    },
  );

  test("a copy a stopped process left beside a held file is removed, and the held file moves to failed", async () => {
    const fake = fakeIngest();
    const holding = join(inbox, `${HOLD_PREFIX}0190a6f0-0000-7000-8000-000000000000`);
    await mkdir(holding);
    await writeFile(join(holding, "part.stl"), SECOND);
    // Part of a copy back under the name, cut off by the stop.
    await writeFile(join(holding, `${HOLD_COPY_PREFIX}0190a6f0-0000-7000-8000-000000000001`), "sol");
    const w = watcher(fake);
    const pass = await w.pollOnce();

    expect(pass.failed).toEqual([{ name: "part.stl", reason: HELD_REASON }]);
    expect((await readdir(join(inbox, FAILED_DIR))).sort()).toEqual(
      ["part.stl", `part.stl${REASON_SUFFIX}`].sort(),
    );
    expect(await readFile(join(inbox, FAILED_DIR, "part.stl"), "utf8")).toBe(SECOND);
    expect(await readdir(inbox)).toEqual([FAILED_DIR]);
  });

  test("on a filesystem with no hard links at all, the file is kept whole in failed and nothing part-written is put under the name", async () => {
    const fake = fakeIngest();
    const path = join(inbox, "part.stl");
    noHardLinks(path, () => undefined, true);
    let swapped = false;
    const w = watcher(fake, {
      storedFile: async (id) => {
        if (!swapped) {
          swapped = true;
          renameOverSync("part.stl", SECOND);
        }
        return fake.stored.get(id);
      },
    });
    await writeFile(path, FIRST);
    await w.pollOnce();
    const pass = await tick(w, 15_000);

    expect(pass.failed).toEqual([{ name: "part.stl", reason: SWAPPED_REASON }]);
    expect(await readFile(join(inbox, FAILED_DIR, "part.stl"), "utf8")).toBe(SECOND);
    expect(await readdir(inbox)).toEqual([FAILED_DIR]);
  });
});

describe("a file put under a failing file's name before it is moved to failed", () => {
  // A file is moved to failed by its name. What holds the name then must be
  // the file that failed: a corrected copy dropped in under the same name, or
  // a symlink, is never moved to failed under the old file's reason.
  const BAD = "solid bad\nendsolid bad\n";
  const FIXED = "solid fixed, a corrected copy\nendsolid fixed\n";

  test.each([
    ["a corrected copy", "copy"],
    ["a symlink", "link"],
  ])(
    "%s put under the name of a file on its last strike, later in the pass, is not moved to failed",
    async (_l, what) => {
      const boom = new TypeError("boom in the parser");
      const outside = join(root, "outside.stl");
      await writeFile(outside, BAD);
      let replaced = false;
      const fake = fakeIngest((input) => {
        if (input.originalName === "a.stl" && !replaced) throw boom;
        if (input.originalName === "b.stl" && !replaced) {
          // b.stl is tried after a.stl's last strike and before the pass ends.
          replaced = true;
          if (what === "copy") renameOverSync("a.stl", FIXED);
          else {
            symlinkSync(outside, join(inbox, "a.link.part"));
            renameSync(join(inbox, "a.link.part"), join(inbox, "a.stl"));
          }
        }
      });
      const w = watcher(fake);
      await writeFile(join(inbox, "a.stl"), BAD);
      await w.pollOnce();
      await tick(w, 15_000);
      // b.stl is first seen here, so it settles in time for a.stl's third try.
      await writeFile(join(inbox, "b.stl"), "solid b\nendsolid b\n");
      await tick(w, 1);
      const third = await tick(w, 15_000);

      expect(fake.calls).toEqual(["a.stl", "a.stl", "a.stl", "b.stl"]);
      expect(third.failed).toEqual([]);
      expect(await exists(join(inbox, FAILED_DIR))).toBe(false);
      expect(
        lines.some((l) => l.includes("a.stl") && l.includes(`not moved to ${FAILED_DIR}`)),
      ).toBe(true);
      if (what === "link") {
        expect((await lstat(join(inbox, "a.stl"))).isSymbolicLink()).toBe(true);
        expect(await readFile(outside, "utf8")).toBe(BAD);
        return;
      }
      // The corrected copy is a new file: it settles and is imported.
      expect(await readFile(join(inbox, "a.stl"), "utf8")).toBe(FIXED);
      await tick(w, 5_000);
      const later = await tick(w, 15_000);
      expect(later.imported.map((i) => i.name)).toEqual(["a.stl"]);
      const fileId = later.imported[0]?.fileId ?? "";
      expect(fake.stored.get(fileId)?.sha256).toEqual(sha256(Buffer.from(FIXED)));
    },
  );

  test("a corrected copy put under the name while ingest refuses the old file is not moved to failed, and is imported", async () => {
    let refused = false;
    const fake = fakeIngest(() => {
      if (refused) return;
      refused = true;
      renameOverSync("a.stl", FIXED);
      throw new IngestError("unsupported_type", "Refused");
    });
    const w = watcher(fake);
    await writeFile(join(inbox, "a.stl"), BAD);
    await w.pollOnce();
    const pass = await tick(w, 15_000);

    expect(pass.failed).toEqual([]);
    expect(await exists(join(inbox, FAILED_DIR))).toBe(false);
    expect(await readFile(join(inbox, "a.stl"), "utf8")).toBe(FIXED);
    expect(lines.some((l) => l.includes("a.stl") && l.includes("looked at again"))).toBe(true);

    await tick(w, 5_000);
    const later = await tick(w, 15_000);
    expect(later.imported.map((i) => i.name)).toEqual(["a.stl"]);
    const fileId = later.imported[0]?.fileId ?? "";
    expect(fake.stored.get(fileId)?.sha256).toEqual(sha256(Buffer.from(FIXED)));
  });
});

describe("a file that changes after it settles", () => {
  // The settle window and the fstat after the open say the file is done. A
  // writer can still append or truncate after that check (a stalled copy that
  // resumes, a writer that keeps appending). What is imported must be the
  // file that settled, never more or less of it.

  test("a file appended after it settles is not imported on that pass, and is imported whole once it settles again", async () => {
    const fake = fakeIngest();
    const w = watcher(fake);
    const path = join(inbox, "grow.stl");
    await writeFile(path, "solid a\n");
    changeAfterCheck(path, () => appendFile(path, "endsolid a\n"));
    // Every byte written to a copy in the temp folder, to see that the copy
    // holds no more than the size that settled.
    let copied = 0;
    const atCheck = fsHooks.wrap;
    fsHooks.wrap = (opened, handle) => {
      if (!opened.startsWith(join(root, "tmp", "inbox-copies"))) {
        return atCheck?.(opened, handle) ?? handle;
      }
      return patched(handle, {
        write: async (...args: unknown[]) => {
          const done = (await Reflect.apply(handle.write, handle, args)) as {
            bytesWritten: number;
          };
          copied += done.bytesWritten;
          return done;
        },
      });
    };
    await w.pollOnce();
    const pass = await tick(w, 15_000);

    expect(copied).toBe("solid a\n".length);
    expect(fake.calls).toEqual([]);
    expect(pass.imported).toEqual([]);
    expect(pass.failed).toEqual([]);
    expect(await readFile(path, "utf8")).toBe("solid a\nendsolid a\n");
    expect(lines.some((l) => l.includes("counts against the file"))).toBe(false);

    // Its settle window starts again at the next poll.
    await tick(w, 5_000);
    await tick(w, 14_999);
    expect(fake.calls).toEqual([]);
    const again = await tick(w, 1);
    expect(fake.calls).toEqual(["grow.stl"]);
    expect(again.imported).toHaveLength(1);
    const fileId = again.imported[0]?.fileId ?? "";
    expect(fake.stored.get(fileId)?.sha256).toEqual(sha256(Buffer.from("solid a\nendsolid a\n")));
    expect(await exists(path)).toBe(false);
  });

  test("a file truncated after it settles is not imported on that pass, and is imported as it is once it settles again", async () => {
    const fake = fakeIngest();
    const w = watcher(fake);
    const path = join(inbox, "shrink.stl");
    await writeFile(path, "solid a\nendsolid a\n");
    changeAfterCheck(path, async () => {
      const handle = await open(path, "r+");
      try {
        await handle.truncate(8);
      } finally {
        await handle.close();
      }
    });
    await w.pollOnce();
    const pass = await tick(w, 15_000);

    expect(fake.calls).toEqual([]);
    expect(pass.imported).toEqual([]);
    expect(pass.failed).toEqual([]);

    await tick(w, 5_000);
    const again = await tick(w, 15_000);
    expect(fake.calls).toEqual(["shrink.stl"]);
    const fileId = again.imported[0]?.fileId ?? "";
    expect(fake.stored.get(fileId)?.sha256).toEqual(sha256(Buffer.from("solid a\n")));
  });

  test("a copy that comes up short of the settled size is never imported, even when fstat still matches", async () => {
    // A read that ends early while the file's size and mtime still say it
    // is whole (a network filesystem, say): only the copy's own size shows it.
    const path = join(inbox, "short.stl");
    let short = true;
    fsHooks.wrap = (opened, handle) =>
      opened !== path
        ? handle
        : patched(handle, {
            read: async (...args: unknown[]) => {
              if (short) {
                short = false;
                return { bytesRead: 0, buffer: args[0] };
              }
              return Reflect.apply(handle.read, handle, args);
            },
          });
    const fake = fakeIngest();
    const w = watcher(fake);
    await writeFile(path, "solid a\nendsolid a\n");
    await w.pollOnce();
    const pass = await tick(w, 15_000);
    expect(fake.calls).toEqual([]);
    expect(pass.failed).toEqual([]);
    expect(lines.some((l) => l.includes("counts against the file"))).toBe(false);

    await tick(w, 5_000);
    const again = await tick(w, 15_000);
    expect(fake.calls).toEqual(["short.stl"]);
    const fileId = again.imported[0]?.fileId ?? "";
    expect(fake.stored.get(fileId)?.sha256).toEqual(sha256(Buffer.from("solid a\nendsolid a\n")));
  });

  test("a file that grows past the size limit after it settles is never imported as an oversized model", async () => {
    // What each ingest call was handed, by size; nothing is read.
    const sizes: number[] = [];
    const w = watcher(fakeIngest(), {
      ingest: {
        async ingestFile(input: IngestInput) {
          sizes.push((await lstat(input.tmpPath)).size);
          return { modelId: "model-x", fileId: "file-x" };
        },
      },
      storedFile: async () => undefined,
    });
    const path = join(inbox, "swelling.3mf");
    await writeFile(path, "small at first\n");
    changeAfterCheck(path, async () => {
      // Sparse, so no disk space is used.
      const handle = await open(path, "r+");
      try {
        await handle.truncate(MAX_INBOX_BYTES + 1);
      } finally {
        await handle.close();
      }
    });
    await w.pollOnce();
    const pass = await tick(w, 15_000);
    expect(sizes).toEqual([]);
    expect(pass.imported).toEqual([]);
    expect(pass.failed).toEqual([]);

    // Once it settles at its new size, the size limit refuses it.
    await tick(w, 5_000);
    const later = await tick(w, 15_000);
    expect(later.failed).toEqual([{ name: "swelling.3mf", reason: TOO_LARGE_REASON }]);
    expect(sizes).toEqual([]);
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

  test("a failed folder that is a symlink is not used: nothing moves through it, and it is logged", async () => {
    const fake = fakeIngest(() => {
      throw new IngestError("unsupported_type", "Refused");
    });
    const w = watcher(fake);
    const elsewhere = join(root, "elsewhere");
    await mkdir(elsewhere);
    await symlink(elsewhere, join(inbox, FAILED_DIR));
    const path = join(inbox, "notes.txt");
    await writeFile(path, "not a model\n");
    await w.pollOnce();
    const pass = await tick(w, 15_000);

    expect(pass.failed).toEqual([]);
    expect(await readdir(elsewhere)).toEqual([]);
    expect(await readFile(path, "utf8")).toBe("not a model\n");
    expect(
      lines.some(
        (l) =>
          l.includes("notes.txt") && l.includes("could not move") && l.includes("not a folder"),
      ),
    ).toBe(true);
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
      tmpDir: async () => undefined,
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
      tmpDir: async () => undefined,
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
      // Ingest reads the watcher's own copy, so the inbox copy is what goes.
      const path = join(inbox, input.originalName);
      await rm(path);
      throw wrapped(coded(`ENOENT: no such file or directory, open '${path}'`, "ENOENT"));
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

describe("a temp folder that will not take the copy", () => {
  // Ingest reads a copy the watcher writes in TMP_DIR/inbox-copies. A copy
  // that cannot be written (TMP_DIR full, read-only, unwritable or gone) is
  // the environment's fault, never the file's: it is an outage, not a strike.
  const copies = () => join(root, "tmp", "inbox-copies");

  /** Each way of breaking the temp folder, with how to mend it; undefined when it cannot run here. */
  const breakers: Array<[string, () => Promise<(() => Promise<void>) | undefined>]> = [
    [
      "full part way through the copy (ENOSPC)",
      async () => {
        fsHooks.wrap = (path, handle) => {
          if (!path.startsWith(copies())) return handle;
          const full = async () => {
            throw coded("ENOSPC: no space left on device, write", "ENOSPC");
          };
          return patched(handle, { write: full, writeFile: full });
        };
        return async () => {
          fsHooks.wrap = undefined;
        };
      },
    ],
    [
      "unwritable (EACCES)",
      async () => {
        // Root ignores the folder's mode, so this case cannot run as root.
        if (process.getuid?.() === 0) return undefined;
        await mkdir(copies(), { recursive: true });
        await chmod(copies(), 0o500);
        return async () => {
          await chmod(copies(), 0o700);
        };
      },
    ],
  ];

  test.for(breakers)(
    "a temp folder %s leaves the file in place with no strike, backs off, and imports once it takes writes",
    async ([, breakIt], ctx) => {
      const fake = fakeIngest();
      const w = watcher(fake);
      const path = join(inbox, "a.stl");
      await writeFile(path, "solid a\nendsolid a\n");
      const mend = await breakIt();
      if (mend === undefined) {
        // Written reason for the skip: root ignores the folder's mode. Skipped,
        // not passed, so the report says this checked nothing.
        return ctx.skip();
      }
      await w.pollOnce();
      const first = await tick(w, 15_000);
      expect(first.waiting).toBe(true);
      expect(first.failed).toEqual([]);
      // The second try comes 5 s later, the third 10 s after that.
      expect((await tick(w, 5_000)).waiting).toBe(true);
      expect((await tick(w, 5_000)).waiting).toBe(true);
      expect((await tick(w, 5_000)).waiting).toBe(true);

      // Three failed copies: nothing counted against the file, nothing moved.
      expect(fake.calls).toEqual([]);
      expect(await readFile(path, "utf8")).toBe("solid a\nendsolid a\n");
      expect(await exists(join(inbox, FAILED_DIR))).toBe(false);
      expect(lines.some((l) => l.includes("counts against the file"))).toBe(false);
      expect(lines.some((l) => l.includes("a.stl") && l.includes("temp folder"))).toBe(true);

      // Mended. The next try is due 20 s after the third, not at the next poll.
      await mend();
      const early = await tick(w, 15_000);
      expect(early.imported).toEqual([]);
      expect(early.waiting).toBe(true);
      const back = await tick(w, 5_000);
      expect(back.imported.map((i) => i.name)).toEqual(["a.stl"]);
      expect(await exists(path)).toBe(false);
      expect(await exists(join(inbox, FAILED_DIR))).toBe(false);
    },
  );

  test("a TMP_DIR that is not a folder is an outage the temp folder check confirms, and the inbox imports once it is a folder", async () => {
    const tmp = join(root, "tmp");
    await writeFile(tmp, "a file where the temp folder should be\n");
    const real = inboxProbes({ db: {} as never, store: {} as never, tmpDir: tmp });
    const fake = fakeIngest();
    const w = watcher(fake, {
      probes: {
        database: async () => undefined,
        store: async () => undefined,
        tmpDir: () => real.tmpDir(),
      },
    });
    const path = join(inbox, "a.stl");
    await writeFile(path, "solid a\nendsolid a\n");
    await w.pollOnce();
    const pass = await tick(w, 15_000);
    expect(pass.waiting).toBe(true);
    expect(pass.failed).toEqual([]);
    for (let i = 0; i < 10; i += 1) expect((await tick(w, 5_000)).failed).toEqual([]);
    expect(fake.calls).toEqual([]);
    expect(await exists(path)).toBe(true);
    expect(await exists(join(inbox, FAILED_DIR))).toBe(false);
    const outage = lines.filter((l) => l.includes("not answering"));
    expect(outage).toHaveLength(1);
    expect(outage[0]).toContain("temp folder");

    await rm(tmp);
    await mkdir(tmp);
    const back = await tick(w, BACKOFF_MAX_MS);
    expect(back.imported.map((i) => i.name)).toEqual(["a.stl"]);
    expect(lines.filter((l) => l.includes("importing again"))).toHaveLength(1);
  });

  test("a failure reading the inbox file itself still counts against the file", async () => {
    const path = join(inbox, "unreadable.stl");
    const eio = coded("EIO: i/o error, read", "EIO");
    fsHooks.wrap = (opened, handle) =>
      opened !== path
        ? handle
        : patched(handle, {
            read: async () => {
              throw eio;
            },
            createReadStream: () =>
              new Readable({
                read() {
                  this.destroy(eio);
                },
              }),
          });
    const fake = fakeIngest();
    const w = watcher(fake);
    await writeFile(path, "solid a\nendsolid a\n");
    await w.pollOnce();
    await tick(w, 15_000);
    await tick(w, 5_000);
    const third = await tick(w, 5_000);
    expect(third.failed).toEqual([{ name: "unreadable.stl", reason: repeatedErrorReason(eio) }]);
    expect(fake.calls).toEqual([]);
  });
});

describe("the checks", () => {
  // The store and temp folder checks themselves; the database check needs a
  // real Postgres and is in test/integration/inbox/.
  const listed = { objects: [], next: undefined };

  test("the temp folder check passes on a folder that takes a write, and leaves nothing behind", async () => {
    const tmp = join(root, "tmp");
    const probes = inboxProbes({ db: {} as never, store: {} as never, tmpDir: tmp });
    await expect(probes.tmpDir()).resolves.toBeUndefined();
    await expect(probes.tmpDir()).resolves.toBeUndefined();
    expect(await readdir(join(tmp, "inbox-copies"))).toEqual([]);
  });

  test("the temp folder check fails when TMP_DIR is not a folder", async () => {
    const tmp = join(root, "tmp");
    await writeFile(tmp, "not a folder\n");
    const probes = inboxProbes({ db: {} as never, store: {} as never, tmpDir: tmp });
    await expect(probes.tmpDir()).rejects.toThrow();
  });

  test("the temp folder check fails when the disk is full, and leaves nothing behind", async () => {
    const tmp = join(root, "tmp");
    fsHooks.wrap = (path, handle) => {
      if (!path.startsWith(join(tmp, "inbox-copies"))) return handle;
      const full = async () => {
        throw coded("ENOSPC: no space left on device, write", "ENOSPC");
      };
      return patched(handle, { write: full, writeFile: full });
    };
    const probes = inboxProbes({ db: {} as never, store: {} as never, tmpDir: tmp });
    await expect(probes.tmpDir()).rejects.toThrow(/ENOSPC/);
    fsHooks.wrap = undefined;
    expect(await readdir(join(tmp, "inbox-copies"))).toEqual([]);
  });

  test("the temp folder check fails when the copy folder cannot be written", async (ctx) => {
    if (process.getuid?.() === 0) {
      // Written reason for the skip: root ignores the folder's mode.
      return ctx.skip();
    }
    const tmp = join(root, "tmp");
    await mkdir(join(tmp, "inbox-copies"), { recursive: true });
    await chmod(join(tmp, "inbox-copies"), 0o500);
    const probes = inboxProbes({ db: {} as never, store: {} as never, tmpDir: tmp });
    await expect(probes.tmpDir()).rejects.toThrow(/EACCES/);
  });

  test("the store check fails when the store will not take a write, though it still lists", async () => {
    const store = {
      listPage: async () => listed,
      checkWrite: async () => {
        throw new StoreError("PutObject", "QuotaExceeded", 403);
      },
    };
    const probes = inboxProbes({ db: {} as never, store, tmpDir: join(root, "tmp") });
    await expect(probes.store()).rejects.toThrow(/QuotaExceeded/);
  });

  test("the store check fails when the listing fails, though writes work", async () => {
    const store = {
      listPage: async () => {
        throw new StoreError("ListObjectsV2", "AccessDenied", 403);
      },
      checkWrite: async () => undefined,
    };
    const probes = inboxProbes({ db: {} as never, store, tmpDir: join(root, "tmp") });
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
    const probes = inboxProbes({ db: {} as never, store, tmpDir: join(root, "tmp") });
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
