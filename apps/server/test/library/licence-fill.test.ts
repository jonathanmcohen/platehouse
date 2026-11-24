// The licence fill on upgrade (#445), without a database: what it decides for
// one model, and how a run walks the library, counts and records itself. The
// database side and a run against a real Postgres and object store are in
// test/integration/library/licence-fill.test.ts.
import { describe, expect, test, vi } from "vitest";
import {
  createLicenceFill,
  LICENCE_STEP,
  type LicenceFillResult,
  type LicenceOutcome,
  type LicenceStore,
  type ReadLicence,
} from "../../src/library/licence-fill.js";
import { RECONVERT_PAUSED, type SourceFile, SourceOutage } from "../../src/library/reconvert.js";

const model = (n: number) => `0190f5a8-3c2e-7a4b-9c1d-2e3f4a5b6c${String(n).padStart(2, "0")}`;
const file = (fileId: string): SourceFile => ({ fileId, key: `k/${fileId}`, size: 100 });
const ZERO = { checked: 0, filled: 0, none: 0, kept: 0, unreadable: 0 };

/**
 * An in-memory LicenceStore over a list of model ids with no licence. A model
 * written drops out of the candidates, as it does in the database; a model in
 * `taken` has gained a licence since it was read, so its write matches no row.
 */
function memoryStore(ids: string[], files: Record<string, SourceFile[]>) {
  const finished = new Map<string, LicenceFillResult>();
  const progress = new Map<string, LicenceFillResult & { after: string }>();
  const written = new Map<string, { spdx: string | null; note: string | null }>();
  const taken = new Set<string>();
  let locked = false;
  let lease = new AbortController();
  const add = (name: string, modelId: string, outcome: LicenceOutcome) => {
    const p = progress.get(name) ?? { ...ZERO, after: modelId };
    p.checked += 1;
    p[outcome] += 1;
    p.after = modelId;
    progress.set(name, p);
  };
  const store: LicenceStore = {
    stepFinished: async (name) => finished.has(name),
    exclusive: async (_name, fn) => {
      if (locked) return null;
      locked = true;
      try {
        return await fn(lease.signal);
      } finally {
        locked = false;
      }
    },
    resumeAfter: async (name) => progress.get(name)?.after ?? null,
    count: async (name, modelId, outcome) => add(name, modelId, outcome),
    finishStep: async (name) => {
      const { after: _after, ...counts } = progress.get(name) ?? { ...ZERO, after: "" };
      if (!finished.has(name)) finished.set(name, counts);
      progress.delete(name);
      return counts;
    },
    sourceFiles: async (modelId) => files[modelId] ?? [],
    licenceCandidates: async (after, limit) =>
      ids
        .filter((id) => !written.has(id))
        .filter((id) => after === null || id > after)
        .sort()
        .slice(0, limit)
        .map((modelId) => ({ modelId })),
    writeLicence: async (modelId, set, count) => {
      if (taken.has(modelId)) return false;
      written.set(modelId, set);
      add(count.name, modelId, "filled");
      return true;
    },
  };
  return {
    store,
    finished,
    progress,
    written,
    taken,
    lock: () => {
      locked = true;
    },
    loseLease: () => lease.abort(),
    resetLease: () => {
      lease = new AbortController();
    },
  };
}

/** Each file's licence, by id; null means the file cannot be read. */
function reader(licences: Record<string, string | null | "unreadable">) {
  const read: string[] = [];
  const readLicence: ReadLicence = vi.fn(async (f: SourceFile) => {
    read.push(f.fileId);
    const l = licences[f.fileId];
    if (l === undefined) throw new Error(`no licence for ${f.fileId}`);
    return l === "unreadable" ? null : { license: l };
  });
  return { readLicence, read };
}

function fill(
  mem: ReturnType<typeof memoryStore>,
  readLicence: ReadLicence,
  extra: { batchSize?: number } = {},
) {
  const lines: string[] = [];
  const run = createLicenceFill({
    store: mem.store,
    readLicence,
    log: (l) => lines.push(l),
    ...extra,
  });
  return { run, lines };
}

describe("createLicenceFill", () => {
  test("fills the SPDX id from the oldest file that names a licence", async () => {
    const mem = memoryStore([model(1)], { [model(1)]: [file("a"), file("b"), file("c")] });
    const { readLicence, read } = reader({ a: null, b: "BY-ND", c: "BY" });
    const { run } = fill(mem, readLicence);
    expect(await run.run()).toEqual({ ...ZERO, checked: 1, filled: 1 });
    expect(mem.written.get(model(1))).toEqual({ spdx: "CC-BY-ND-4.0", note: null });
    expect(read).toEqual(["a", "b"]);
  });

  test("fills a note for a footer licence", async () => {
    const mem = memoryStore([model(1)], { [model(1)]: [file("a")] });
    const { run } = fill(mem, reader({ a: "Standard Digital File License" }).readLicence);
    await run.run();
    expect(mem.written.get(model(1))).toEqual({
      spdx: null,
      note: "License on MakerWorld: Standard Digital File License",
    });
  });

  test("fills a note for an unknown licence", async () => {
    const mem = memoryStore([model(1)], { [model(1)]: [file("a")] });
    const { run } = fill(mem, reader({ a: "Some New License" }).readLicence);
    await run.run();
    expect(mem.written.get(model(1))).toEqual({
      spdx: null,
      note: "License on MakerWorld: Some New License",
    });
  });

  test("counts none when no file names a licence", async () => {
    const mem = memoryStore([model(1)], { [model(1)]: [file("a"), file("b")] });
    const { run } = fill(mem, reader({ a: null, b: "  " }).readLicence);
    expect(await run.run()).toEqual({ ...ZERO, checked: 1, none: 1 });
    expect(mem.written.size).toBe(0);
  });

  test("counts unreadable when no licence was found and a file could not be read", async () => {
    const mem = memoryStore([model(1)], { [model(1)]: [file("a"), file("b")] });
    const { run } = fill(mem, reader({ a: "unreadable", b: null }).readLicence);
    expect(await run.run()).toEqual({ ...ZERO, checked: 1, unreadable: 1 });
  });

  test("fills from a later file even when an earlier one could not be read", async () => {
    const mem = memoryStore([model(1)], { [model(1)]: [file("a"), file("b")] });
    const { run } = fill(mem, reader({ a: "unreadable", b: "CC0" }).readLicence);
    expect(await run.run()).toEqual({ ...ZERO, checked: 1, filled: 1 });
    expect(mem.written.get(model(1))).toEqual({ spdx: "CC0-1.0", note: null });
  });

  test("counts a model the reader throws on as could not be read, and goes on", async () => {
    const mem = memoryStore([model(1), model(2)], {
      [model(1)]: [file("a")],
      [model(2)]: [file("b")],
    });
    // The reader has no entry for "a", so it throws on it.
    const { run } = fill(mem, reader({ b: "BY" }).readLicence);
    expect(await run.run()).toEqual({ ...ZERO, checked: 2, filled: 1, unreadable: 1 });
  });

  test("uses a later file's licence when the reader throws on an earlier one", async () => {
    const mem = memoryStore([model(1)], { [model(1)]: [file("a"), file("b")] });
    const { run } = fill(mem, reader({ b: "CC0" }).readLicence);
    expect(await run.run()).toEqual({ ...ZERO, checked: 1, filled: 1 });
  });

  test("counts kept when the model gained a licence while it ran", async () => {
    const mem = memoryStore([model(1)], { [model(1)]: [file("a")] });
    mem.taken.add(model(1));
    const { run } = fill(mem, reader({ a: "BY" }).readLicence);
    expect(await run.run()).toEqual({ ...ZERO, checked: 1, kept: 1 });
    expect(mem.written.size).toBe(0);
  });

  test("stops after the model in hand when told to, and goes on from there", async () => {
    const ids = [model(1), model(2), model(3)];
    const files = Object.fromEntries(ids.map((id, i) => [id, [file(`f${i}`)]]));
    const mem = memoryStore(ids, files);
    const { readLicence } = reader({ f0: "BY", f1: "BY", f2: "BY" });
    const { run, lines } = fill(mem, readLicence);
    expect(await run.run(() => true)).toBe(RECONVERT_PAUSED);
    expect(mem.progress.get(LICENCE_STEP)).toMatchObject({ checked: 1, after: model(1) });
    expect(lines.join("\n")).toContain("stopped after model");
    expect(await run.pending()).toBe(true);
    expect(await run.run()).toEqual({ ...ZERO, checked: 3, filled: 3 });
    expect(await run.pending()).toBe(false);
  });

  test("stops before the next model when the signal aborts", async () => {
    const ids = [model(1), model(2)];
    const files = Object.fromEntries(ids.map((id, i) => [id, [file(`f${i}`)]]));
    const mem = memoryStore(ids, files);
    const ctl = new AbortController();
    const { run } = fill(mem, reader({ f0: "BY", f1: "BY" }).readLicence);
    ctl.abort();
    expect(await run.run(() => false, ctl.signal)).toBe(RECONVERT_PAUSED);
    expect(mem.progress.size).toBe(0);
  });

  test("stops when it loses its lease", async () => {
    const ids = [model(1), model(2)];
    const files = Object.fromEntries(ids.map((id, i) => [id, [file(`f${i}`)]]));
    const mem = memoryStore(ids, files);
    const { readLicence } = reader({ f0: "BY", f1: "BY" });
    const { run, lines } = fill(mem, async (f, s) => {
      mem.loseLease();
      return readLicence(f, s);
    });
    expect(await run.run()).toBe(RECONVERT_PAUSED);
    expect(mem.progress.get(LICENCE_STEP)).toMatchObject({ checked: 1, after: model(1) });
    expect(lines.join("\n")).toContain("lost its lease; stopping");
  });

  test("rethrows a store outage", async () => {
    const mem = memoryStore([model(1)], { [model(1)]: [file("a")] });
    const { run } = fill(mem, async () => {
      throw new SourceOutage(new Error("down"));
    });
    await expect(run.run()).rejects.toBeInstanceOf(SourceOutage);
    expect(mem.progress.size).toBe(0);
    expect(mem.finished.size).toBe(0);
  });

  test("pages through the candidates in id order", async () => {
    const ids = [model(1), model(2), model(3)];
    const files = Object.fromEntries(ids.map((id, i) => [id, [file(`f${i}`)]]));
    const mem = memoryStore(ids, files);
    const { run } = fill(mem, reader({ f0: "BY", f1: "BY", f2: "BY" }).readLicence, {
      batchSize: 2,
    });
    expect(await run.run()).toEqual({ ...ZERO, checked: 3, filled: 3 });
  });

  test("does nothing while another run holds the step", async () => {
    const mem = memoryStore([model(1)], { [model(1)]: [file("a")] });
    mem.lock();
    const { readLicence } = reader({ a: "BY" });
    const { run } = fill(mem, readLicence);
    expect(await run.run()).toBeNull();
    expect(readLicence).not.toHaveBeenCalled();
    expect(await run.pending()).toBe(true);
  });

  test("records the step once and does nothing after", async () => {
    const mem = memoryStore([model(1)], { [model(1)]: [file("a")] });
    const { readLicence } = reader({ a: "BY" });
    const { run } = fill(mem, readLicence);
    expect(await run.run()).toEqual({ ...ZERO, checked: 1, filled: 1 });
    expect(mem.finished.get(LICENCE_STEP)).toEqual({ ...ZERO, checked: 1, filled: 1 });
    expect(await run.pending()).toBe(false);
    expect(await run.run()).toBeNull();
    expect(readLicence).toHaveBeenCalledTimes(1);
  });

  test("records the step with every count at 0 when there is nothing to check", async () => {
    const mem = memoryStore([], {});
    const { run } = fill(mem, reader({}).readLicence);
    expect(await run.run()).toEqual(ZERO);
    expect(mem.finished.get(LICENCE_STEP)).toEqual(ZERO);
  });
});
