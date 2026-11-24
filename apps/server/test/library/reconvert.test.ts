// The description re-conversion (#357), without a database: what it decides
// for one model, and how a run walks the library, counts and records itself.
// The database side (repos/descriptions.ts) and the run against a real
// Postgres and object store are in test/integration/library/reconvert.test.ts.
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { earlierConversions } from "@platehouse/makerworld";
import { describe, expect, test, vi } from "vitest";
import { MAX_DESCRIPTION_CODE_POINTS } from "../../src/library/converted-description.js";
import {
  composeDescription,
  createDescriptionReconvert,
  type Decision,
  decide,
  descriptionSha256,
  type Outcome,
  RECONVERT_PAUSED,
  RECONVERT_STEP,
  type ReconvertResult,
  type ReconvertStore,
  type SourceFile,
  SourceOutage,
  type SourceText,
  type StoredDescription,
  storeTextReader,
} from "../../src/library/reconvert.js";
import { BlobNotFound, StoreError, StoreUnavailable } from "../../src/storage/s3.js";
import { build3mf } from "../integration/support/ingest.js";

// One description the three converters write three ways: the rc converter
// keeps the bold marks, 0.1.0 drops them, and only the current one breaks the
// Boost Me box into a title and its text.
const HTML =
  "<p><b>Note:</b>Use</p><boostme><boosttitle>Boost Me</boosttitle><boostcontent>Hi</boostcontent></boostme>";
const BY_RC = "**Note:**Use\n\nBoost MeHi";
const BY_010 = "Note:Use\n\nBoost MeHi";
const NOW = "Note:Use\n\nBoost Me\n\nHi";
const NOTE = "License on MakerWorld: Standard Digital File License";

const FILE_A = "0190f5a8-3c2f-7d10-a2b3-c4d5e6f70811";
const FILE_B = "0190f5a8-3c2f-7d10-a2b3-c4d5e6f70812";
const MODEL = "0190f5a8-3c2e-7a4b-9c1d-2e3f4a5b6c71";

const file = (fileId: string): SourceFile => ({ fileId, key: `k/${fileId}`, size: 100 });

function stored(over: Partial<StoredDescription> & { description: string }): StoredDescription {
  return { modelId: MODEL, sha256: null, converter: null, fileId: null, ...over };
}

/** Each file's text, by id; a file mapped to null cannot be read. */
function reader(texts: Record<string, SourceText | null>) {
  const read: string[] = [];
  const readText = vi.fn(async (f: SourceFile) => {
    read.push(f.fileId);
    const text = texts[f.fileId];
    if (text === undefined) throw new Error(`no text for ${f.fileId}`);
    return text;
  });
  return { readText, read };
}

describe("composeDescription", () => {
  test("leaves the note out when it would take the stored text over 200,000 code points", () => {
    const text = "a".repeat(199_995);
    expect(composeDescription(text, NOTE, true)).toBe(text);
    const small = "a".repeat(100_000);
    expect(composeDescription(small, NOTE, true)).toBe(`${small}\n\n${NOTE}`);
  });

  test("is what fillMetadata stores: the text, then the note after a blank line", () => {
    expect(composeDescription("Text", NOTE, true)).toBe(`Text\n\n${NOTE}`);
    expect(composeDescription("Text", NOTE, false)).toBe("Text");
    expect(composeDescription("", NOTE, true)).toBe(NOTE);
    expect(composeDescription("Text", null, true)).toBe("Text");
  });
});

describe("descriptionSha256", () => {
  test("is the SHA-256 of the text's UTF-8 bytes, in lowercase hex", () => {
    const text = `Boost Me ${String.fromCodePoint(0x8c22, 0x8c22)}`;
    expect(descriptionSha256(text)).toBe(
      createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex"),
    );
  });
});

describe("decide, for a description with no record of where it came from", () => {
  test("writes again what the rc converter wrote", async () => {
    const { readText } = reader({ [FILE_A]: { html: HTML, note: null } });
    expect(await decide(stored({ description: BY_RC }), [file(FILE_A)], readText)).toEqual({
      kind: "changed",
      fileId: FILE_A,
      description: NOW,
    } satisfies Decision);
  });

  test("writes again what 0.1.0 wrote", async () => {
    const { readText } = reader({ [FILE_A]: { html: HTML, note: null } });
    expect(await decide(stored({ description: BY_010 }), [file(FILE_A)], readText)).toEqual({
      kind: "changed",
      fileId: FILE_A,
      description: NOW,
    });
  });

  test("keeps the licence note at its foot", async () => {
    const { readText } = reader({ [FILE_A]: { html: HTML, note: NOTE } });
    const decision = await decide(
      stored({ description: `${BY_RC}\n\n${NOTE}` }),
      [file(FILE_A)],
      readText,
    );
    expect(decision).toEqual({ kind: "changed", fileId: FILE_A, description: `${NOW}\n\n${NOTE}` });
  });

  test("never adds the footer of a licence MakerWorld names that is not recognised", async () => {
    const unknown = "License on MakerWorld: Some New Licence";
    const { readText } = reader({ [FILE_A]: { html: HTML, note: unknown } });
    expect(await decide(stored({ description: BY_RC }), [file(FILE_A)], readText)).toEqual({
      kind: "changed",
      fileId: FILE_A,
      description: NOW,
    });
  });

  test("never adds that footer to a description with a recorded hash either", async () => {
    const unknown = "License on MakerWorld: Some New Licence";
    const { readText } = reader({ [FILE_A]: { html: HTML, note: unknown } });
    const decision = await decide(
      stored({
        description: BY_RC,
        sha256: descriptionSha256(BY_RC),
        converter: 1,
        fileId: FILE_A,
      }),
      [file(FILE_A)],
      readText,
    );
    expect(decision).toEqual({ kind: "changed", fileId: FILE_A, description: NOW });
  });

  test("leaves alone a description no converter wrote from any of its files", async () => {
    const { readText } = reader({ [FILE_A]: { html: HTML, note: null } });
    const decision = await decide(
      stored({ description: "Boost MeHi, and my own notes" }),
      [file(FILE_A)],
      readText,
    );
    expect(decision).toEqual({ kind: "unproven" });
  });

  test("leaves alone one that differs from a conversion only in its spacing", async () => {
    const { readText } = reader({ [FILE_A]: { html: HTML, note: null } });
    const decision = await decide(stored({ description: `${BY_RC}\n` }), [file(FILE_A)], readText);
    expect(decision).toEqual({ kind: "unproven" });
  });

  test("finds the file it came from among several, in their order", async () => {
    const { readText, read } = reader({
      [FILE_A]: { html: "<p>Another design</p>", note: null },
      [FILE_B]: { html: HTML, note: null },
    });
    const decision = await decide(
      stored({ description: BY_010 }),
      [file(FILE_A), file(FILE_B)],
      readText,
    );
    expect(decision).toEqual({ kind: "changed", fileId: FILE_B, description: NOW });
    expect(read).toEqual([FILE_A, FILE_B]);
  });

  test("records an unchanged one as the same, so the run can mark it written by this converter", async () => {
    const { readText } = reader({ [FILE_A]: { html: "<p>Plain</p>", note: null } });
    expect(await decide(stored({ description: "Plain" }), [file(FILE_A)], readText)).toEqual({
      kind: "same",
      fileId: FILE_A,
      description: "Plain",
    });
  });

  test("cannot prove one whose only file cannot be read", async () => {
    const { readText } = reader({ [FILE_A]: null });
    expect(await decide(stored({ description: BY_RC }), [file(FILE_A)], readText)).toEqual({
      kind: "unreadable",
    });
  });

  test("cannot prove one whose model has no .3mf left", async () => {
    const { readText } = reader({});
    expect(await decide(stored({ description: BY_RC }), [], readText)).toEqual({
      kind: "unreadable",
    });
  });

  test("never matches a file with no MakerWorld text", async () => {
    const { readText } = reader({ [FILE_A]: { html: null, note: null } });
    expect(await decide(stored({ description: BY_RC }), [file(FILE_A)], readText)).toEqual({
      kind: "unproven",
    });
  });
});

describe("decide, for a description ingest recorded writing", () => {
  test("converts it again from the file it came from, and reads no other", async () => {
    const { readText, read } = reader({ [FILE_B]: { html: HTML, note: null } });
    const decision = await decide(
      stored({
        description: BY_010,
        sha256: descriptionSha256(BY_010),
        converter: 2,
        fileId: FILE_B,
      }),
      [file(FILE_A), file(FILE_B)],
      readText,
    );
    expect(decision).toEqual({ kind: "changed", fileId: FILE_B, description: NOW });
    expect(read).toEqual([FILE_B]);
  });

  test("keeps the licence note at its foot", async () => {
    const before = `${BY_010}\n\n${NOTE}`;
    const { readText } = reader({ [FILE_A]: { html: HTML, note: NOTE } });
    const decision = await decide(
      stored({
        description: before,
        sha256: descriptionSha256(before),
        converter: 2,
        fileId: FILE_A,
      }),
      [file(FILE_A)],
      readText,
    );
    expect(decision).toEqual({ kind: "changed", fileId: FILE_A, description: `${NOW}\n\n${NOTE}` });
  });

  test("leaves alone one changed since, without reading any file", async () => {
    const { readText } = reader({ [FILE_A]: { html: HTML, note: null } });
    const decision = await decide(
      stored({
        description: `${BY_010} and my own notes`,
        sha256: descriptionSha256(BY_010),
        converter: 2,
        fileId: FILE_A,
      }),
      [file(FILE_A)],
      readText,
    );
    expect(decision).toEqual({ kind: "edited" });
    expect(readText).not.toHaveBeenCalled();
  });

  test("cannot convert one whose file is gone", async () => {
    const { readText } = reader({ [FILE_A]: { html: HTML, note: null } });
    const decision = await decide(
      stored({
        description: BY_010,
        sha256: descriptionSha256(BY_010),
        converter: 2,
        fileId: FILE_B,
      }),
      [file(FILE_A)],
      readText,
    );
    expect(decision).toEqual({ kind: "unreadable" });
    expect(readText).not.toHaveBeenCalled();
  });
});

describe("decide, for a description whose conversion is now over the limit", () => {
  // Stored by 0.1.0 or a release candidate, before descriptions over 200,000
  // code points were left out: the current converter's text for it would be
  // "" (or the licence note alone), which would wipe the person's description.
  const LONG_HTML = `<p>${"a".repeat(MAX_DESCRIPTION_CODE_POINTS + 10)}</p>`;
  const earlier = [...earlierConversions(LONG_HTML)].map((c) => c.markdown);

  test("keeps one an earlier converter wrote, with or without its note", async () => {
    expect(earlier.length).toBeGreaterThan(0);
    const before = earlier[0] as string;
    expect(before.length).toBeGreaterThan(MAX_DESCRIPTION_CODE_POINTS);
    const { readText } = reader({ [FILE_A]: { html: LONG_HTML, note: NOTE } });
    expect(await decide(stored({ description: before }), [file(FILE_A)], readText)).toEqual({
      kind: "too_long",
    } satisfies Decision);
    // With its note it is not proved at all now (the note is never added
    // past the limit), and so is left as it is too.
    const withNote = await decide(
      stored({ description: `${before}\n\n${NOTE}` }),
      [file(FILE_A)],
      readText,
    );
    expect(["too_long", "unproven"]).toContain(withNote.kind);
  });

  test("keeps one with a record of where it came from", async () => {
    const before = earlier[0] as string;
    const { readText } = reader({ [FILE_A]: { html: LONG_HTML, note: null } });
    const decision = await decide(
      stored({
        description: before,
        sha256: descriptionSha256(before),
        converter: 3,
        fileId: FILE_A,
      }),
      [file(FILE_A)],
      readText,
    );
    expect(decision).toEqual({ kind: "too_long" });
  });

  test("a run counts it as left as it is and writes nothing", async () => {
    const before = earlier[0] as string;
    const mem = memoryStore([stored({ modelId: model(1), description: before })], {
      [model(1)]: [file(fileOf(1))],
    });
    const reconvert = createDescriptionReconvert({
      store: mem.store,
      readText: reader({ [fileOf(1)]: { html: LONG_HTML, note: NOTE } }).readText,
      log: () => {},
    });
    expect(await reconvert.run()).toEqual({
      checked: 1,
      changed: 0,
      unchanged: 0,
      kept: 1,
      unreadable: 0,
    });
    expect(mem.writes).toEqual([]);
  });
});

/**
 * An in-memory ReconvertStore over a list of stored descriptions. A model
 * written by the current converter drops out of the candidates, as it does in
 * the database, and the counts and the last model counted are kept as progress
 * until the step finishes.
 */
function memoryStore(rows: StoredDescription[], files: Record<string, SourceFile[]>) {
  const finished = new Map<string, ReconvertResult>();
  const progress = new Map<string, ReconvertResult & { after: string }>();
  const written = new Set<string>();
  const writes: Array<{ modelId: string; description: string; fileId: string }> = [];
  const pages: Array<string | null> = [];
  const unproven: Array<{ modelId: string; newestFileId: string }> = [];
  let refuse = new Set<string>();
  let locked = false;
  const add = (name: string, modelId: string, outcome: Outcome) => {
    const p = progress.get(name) ?? {
      checked: 0,
      changed: 0,
      unchanged: 0,
      kept: 0,
      unreadable: 0,
      after: modelId,
    };
    p.checked += 1;
    p[outcome] += 1;
    p.after = modelId;
    progress.set(name, p);
  };
  const store: ReconvertStore = {
    stepFinished: async (name) => finished.has(name),
    exclusive: async (_name, fn) => {
      if (locked) return null;
      locked = true;
      try {
        return await fn(new AbortController().signal);
      } finally {
        locked = false;
      }
    },
    resumeAfter: async (name) => progress.get(name)?.after ?? null,
    count: async (name, modelId, outcome) => add(name, modelId, outcome),
    finishStep: async (name) => {
      const { after: _after, ...counts } = progress.get(name) ?? {
        checked: 0,
        changed: 0,
        unchanged: 0,
        kept: 0,
        unreadable: 0,
        after: "",
      };
      if (!finished.has(name)) finished.set(name, counts);
      progress.delete(name);
      return counts;
    },
    candidates: async (after, limit) => {
      pages.push(after);
      return rows
        .filter((r) => !written.has(r.modelId))
        .filter((r) => after === null || r.modelId > after)
        .sort((a, b) => (a.modelId < b.modelId ? -1 : 1))
        .slice(0, limit);
    },
    sourceFiles: async (modelId) => files[modelId] ?? [],
    markUnproven: async (row, newestFileId) => {
      unproven.push({ modelId: row.modelId, newestFileId });
    },
    write: async (row, next, count) => {
      if (refuse.has(row.modelId)) return false;
      writes.push({ modelId: row.modelId, ...next });
      written.add(row.modelId);
      add(count.name, row.modelId, count.outcome);
      return true;
    },
  };
  return {
    store,
    finished,
    progress,
    writes,
    pages,
    unproven,
    refuseWrites: (ids: string[]) => {
      refuse = new Set(ids);
    },
    lock: () => {
      locked = true;
    },
  };
}

const model = (n: number) => `0190f5a8-3c2e-7a4b-9c1d-2e3f4a5b6c${String(n).padStart(2, "0")}`;
const fileOf = (n: number) => `0190f5a8-3c2f-7d10-a2b3-c4d5e6f708${String(n).padStart(2, "0")}`;

describe("a run", () => {
  function library() {
    const rows = [
      stored({ modelId: model(1), description: BY_RC }), // changed
      stored({ modelId: model(2), description: "Plain" }), // same
      stored({ modelId: model(3), description: "Written by hand" }), // kept, unproven
      stored({
        modelId: model(4),
        description: "Edited",
        sha256: descriptionSha256(BY_010),
        converter: 2,
        fileId: fileOf(4),
      }), // kept, edited
      stored({ modelId: model(5), description: BY_RC }), // unreadable
    ];
    const files = Object.fromEntries(rows.map((_r, i) => [model(i + 1), [file(fileOf(i + 1))]]));
    const texts: Record<string, SourceText | null> = {
      [fileOf(1)]: { html: HTML, note: null },
      [fileOf(2)]: { html: "<p>Plain</p>", note: null },
      [fileOf(3)]: { html: HTML, note: null },
      [fileOf(4)]: { html: HTML, note: null },
      [fileOf(5)]: null,
    };
    return { rows, files, texts };
  }

  test("walks the library in pages, writes what changed, counts each outcome and records the step", async () => {
    const { rows, files, texts } = library();
    const mem = memoryStore(rows, files);
    const lines: string[] = [];
    const reconvert = createDescriptionReconvert({
      store: mem.store,
      readText: reader(texts).readText,
      log: (line) => lines.push(line),
      batchSize: 2,
    });
    expect(await reconvert.pending()).toBe(true);
    const result = await reconvert.run();
    const counts = { checked: 5, changed: 1, unchanged: 1, kept: 2, unreadable: 1 };
    expect(result).toEqual(counts);
    expect(mem.writes).toEqual([
      { modelId: model(1), description: NOW, fileId: fileOf(1) },
      { modelId: model(2), description: "Plain", fileId: fileOf(2) },
    ]);
    expect(mem.pages).toEqual([null, model(2), model(4)]);
    expect(mem.finished.get(RECONVERT_STEP)).toEqual(counts);
    expect(await reconvert.pending()).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("1 changed");
    expect(lines[0]).toContain("1 already right");
    expect(lines[0]).toContain("2 left as they are");
    expect(lines[0]).toContain("1 could not be read");
  });

  test("counts a description changed while it ran as left as it is", async () => {
    const { rows, files, texts } = library();
    const mem = memoryStore(rows, files);
    mem.refuseWrites([model(1)]);
    const reconvert = createDescriptionReconvert({
      store: mem.store,
      readText: reader(texts).readText,
      log: () => {},
    });
    expect(await reconvert.run()).toMatchObject({ changed: 0, unchanged: 1, kept: 3 });
  });

  test("does nothing once the step is recorded, so running it twice reads no file", async () => {
    const { rows, files, texts } = library();
    const mem = memoryStore(rows, files);
    const { readText } = reader(texts);
    const reconvert = createDescriptionReconvert({ store: mem.store, readText, log: () => {} });
    await reconvert.run();
    readText.mockClear();
    expect(await reconvert.run()).toBeNull();
    expect(readText).not.toHaveBeenCalled();
  });

  test("stops, records nothing and rethrows when the store is down", async () => {
    const { rows, files } = library();
    const mem = memoryStore(rows, files);
    const outage = new SourceOutage(new Error("the store is down"));
    const reconvert = createDescriptionReconvert({
      store: mem.store,
      readText: async () => {
        throw outage;
      },
      log: () => {},
    });
    await expect(reconvert.run()).rejects.toBe(outage);
    expect(mem.finished.size).toBe(0);
    expect(await reconvert.pending()).toBe(true);
  });

  // A run cut off part way (a restart, or a store outage) leaves its counts
  // and the last model it counted; the next run goes on after that model and
  // records the totals of the whole conversion, not only of its own part.
  test("records the totals of the whole conversion when a run cut off part way is started again", async () => {
    const { rows, files, texts } = library();
    const mem = memoryStore(rows, files);
    const outage = new SourceOutage(new Error("the store is down"));
    const good = reader(texts).readText;
    const first = createDescriptionReconvert({
      store: mem.store,
      readText: async (f) => {
        if (f.fileId === fileOf(3)) throw outage;
        return good(f);
      },
      log: () => {},
      batchSize: 2,
    });
    await expect(first.run()).rejects.toBe(outage);
    expect(mem.finished.size).toBe(0);
    expect(mem.progress.get(RECONVERT_STEP)).toMatchObject({
      checked: 2,
      changed: 1,
      unchanged: 1,
      after: model(2),
    });

    const { readText, read } = reader(texts);
    const second = createDescriptionReconvert({
      store: mem.store,
      readText,
      log: () => {},
      batchSize: 2,
    });
    const counts = { checked: 5, changed: 1, unchanged: 1, kept: 2, unreadable: 1 };
    expect(await second.run()).toEqual(counts);
    expect(mem.finished.get(RECONVERT_STEP)).toEqual(counts);
    // It goes on after the last model counted, reading neither of the first two
    // again; model 4's edit is decided without a read.
    expect(read).toEqual([fileOf(3), fileOf(5)]);
    expect(mem.progress.size).toBe(0);
  });

  // A run is one maintenance job, and pg-boss fails a job that outlasts its
  // expiry while the handler carries on, holding the maintenance worker. So a
  // run stops when the job tells it to, after the model it is on, leaves its
  // counts, and says it paused; the next job goes on after the last model
  // counted.
  test("stops after the model it is on when told to, records nothing, and the next run goes on", async () => {
    const { rows, files, texts } = library();
    const mem = memoryStore(rows, files);
    const { readText, read } = reader(texts);
    const lines: string[] = [];
    const reconvert = createDescriptionReconvert({
      store: mem.store,
      readText,
      log: (line) => lines.push(line),
      batchSize: 2,
    });
    let asked = 0;
    expect(await reconvert.run(() => ++asked >= 3)).toBe(RECONVERT_PAUSED);
    expect(mem.finished.size).toBe(0);
    expect(mem.progress.get(RECONVERT_STEP)).toMatchObject({ checked: 3, after: model(3) });
    expect(await reconvert.pending()).toBe(true);
    expect(read).toEqual([fileOf(1), fileOf(2), fileOf(3)]);
    expect(lines).toEqual([expect.stringContaining("goes on in a new job")]);

    read.length = 0;
    const counts = { checked: 5, changed: 1, unchanged: 1, kept: 2, unreadable: 1 };
    expect(await reconvert.run(() => false)).toEqual(counts);
    expect(mem.finished.get(RECONVERT_STEP)).toEqual(counts);
    expect(read).toEqual([fileOf(5)]);
  });

  test("marks only a description it found unproven, with the model's newest .3mf", async () => {
    const { rows, files, texts } = library();
    files[model(3)] = [file(fileOf(3)), file(fileOf(13))];
    texts[fileOf(13)] = { html: HTML, note: null };
    const mem = memoryStore(rows, files);
    const reconvert = createDescriptionReconvert({
      store: mem.store,
      readText: reader(texts).readText,
      log: () => {},
    });
    await reconvert.run();
    // Model 3 is unproven; 4 is edited and 5 unreadable, which are not marked.
    expect(mem.unproven).toEqual([{ modelId: model(3), newestFileId: fileOf(13) }]);
  });

  test("checks at least one model before it stops, so every run makes progress", async () => {
    const { rows, files, texts } = library();
    const mem = memoryStore(rows, files);
    const reconvert = createDescriptionReconvert({
      store: mem.store,
      readText: reader(texts).readText,
      log: () => {},
    });
    expect(await reconvert.run(() => true)).toBe(RECONVERT_PAUSED);
    expect(mem.progress.get(RECONVERT_STEP)).toMatchObject({ checked: 1, after: model(1) });
  });

  test("does nothing and records nothing while another run holds the step", async () => {
    const { rows, files, texts } = library();
    const mem = memoryStore(rows, files);
    mem.lock();
    const { readText } = reader(texts);
    const reconvert = createDescriptionReconvert({ store: mem.store, readText, log: () => {} });
    expect(await reconvert.run()).toBeNull();
    expect(readText).not.toHaveBeenCalled();
    expect(mem.finished.size).toBe(0);
    expect(mem.progress.size).toBe(0);
    expect(await reconvert.pending()).toBe(true);
  });

  test("stops after the model it is on when it loses its lease, and goes on from there", async () => {
    const { rows, files, texts } = library();
    const mem = memoryStore(rows, files);
    const lost = new AbortController();
    const store: ReconvertStore = {
      ...mem.store,
      exclusive: (name, fn) => mem.store.exclusive(name, () => fn(lost.signal)),
    };
    const { readText } = reader(texts);
    const logged: string[] = [];
    const reconvert = createDescriptionReconvert({
      store,
      readText: async (file) => {
        lost.abort();
        return readText(file);
      },
      log: (line) => logged.push(line),
    });
    expect(await reconvert.run()).toBe(RECONVERT_PAUSED);
    expect(mem.progress.get(RECONVERT_STEP)).toMatchObject({ checked: 1, after: model(1) });
    expect(logged.join("\n")).toContain("lost its lease; stopping");
    expect(await reconvert.pending()).toBe(true);
  });

  test("records the step with every count at 0 when there is nothing to check", async () => {
    const mem = memoryStore([], {});
    const reconvert = createDescriptionReconvert({
      store: mem.store,
      readText: reader({}).readText,
      log: () => {},
    });
    const counts = { checked: 0, changed: 0, unchanged: 0, kept: 0, unreadable: 0 };
    expect(await reconvert.run()).toEqual(counts);
    expect(mem.finished.get(RECONVERT_STEP)).toEqual(counts);
  });

  test("is named for the converter version, so the next converter fix runs again", () => {
    expect(RECONVERT_STEP).toBe("reconvert-descriptions-4");
  });

  // The 0.1.1-rc.1 live check: converter 3 still ran a Membership box
  // together, and its re-conversion was recorded as finished, under its own
  // version's name. With converter 4 the step is a new one, so it runs again,
  // once: what converter 3 wrote and nobody touched is written again, an
  // edited description stays as it is.
  test("runs again, once, for descriptions an older converter wrote, after the version moves on", async () => {
    const memberHtml =
      "<commercialme><commercialtitle>Membership</commercialtitle><commercialcontent>Sell my models</commercialcontent></commercialme>";
    const byV3 = "MembershipSell my models";
    const now = "Membership\n\nSell my models";
    const rows = [
      stored({
        modelId: model(1),
        description: byV3,
        sha256: descriptionSha256(byV3),
        converter: 3,
        fileId: fileOf(1),
      }), // untouched since converter 3 wrote it
      stored({
        modelId: model(2),
        description: `${byV3}\n\nMy own notes`,
        sha256: descriptionSha256(byV3),
        converter: 3,
        fileId: fileOf(2),
      }), // edited since
    ];
    const files = { [model(1)]: [file(fileOf(1))], [model(2)]: [file(fileOf(2))] };
    const mem = memoryStore(rows, files);
    const v3Counts = { checked: 7, changed: 2, unchanged: 3, kept: 2, unreadable: 0 };
    mem.finished.set("reconvert-descriptions-3", v3Counts);
    const { readText, read } = reader({
      [fileOf(1)]: { html: memberHtml, note: null },
      [fileOf(2)]: { html: memberHtml, note: null },
    });
    const reconvert = createDescriptionReconvert({ store: mem.store, readText, log: () => {} });

    expect(await reconvert.pending()).toBe(true);
    expect(await reconvert.run()).toEqual({
      checked: 2,
      changed: 1,
      unchanged: 0,
      kept: 1,
      unreadable: 0,
    });
    expect(mem.writes).toEqual([{ modelId: model(1), description: now, fileId: fileOf(1) }]);
    // The edit is decided from its hash alone, without reading its file.
    expect(read).toEqual([fileOf(1)]);
    // Converter 3's record stays as it was, beside the new one.
    expect(mem.finished.get("reconvert-descriptions-3")).toEqual(v3Counts);
    expect([...mem.finished.keys()]).toEqual(["reconvert-descriptions-3", RECONVERT_STEP]);

    read.length = 0;
    expect(await reconvert.pending()).toBe(false);
    expect(await reconvert.run()).toBeNull();
    expect(read).toEqual([]);
    expect(mem.writes).toHaveLength(1);
  });
});

describe("storeTextReader", () => {
  /** A store holding one object, served by range, that records the ranges asked for. */
  function rangeStore(bytes: Buffer | null, fail?: Error) {
    const ranges: Array<[number, number]> = [];
    return {
      ranges,
      store: {
        getBlobRange: async (_key: string, start: number, end: number) => {
          ranges.push([start, end]);
          if (fail) throw fail;
          if (bytes === null) throw new BlobNotFound("GetObject");
          return Readable.from([bytes.subarray(start, end)]);
        },
      },
    };
  }

  test("gives the file's MakerWorld HTML and its licence note", async () => {
    const bytes = build3mf({
      plates: 1,
      makerWorld: {
        designer: "Synthetic Designer",
        title: "Synthetic Title",
        descriptionHtml: HTML,
        license: "Standard Digital File License",
      },
    });
    const { store } = rangeStore(bytes);
    expect(await storeTextReader(store)({ fileId: FILE_A, key: "k", size: bytes.length })).toEqual({
      html: HTML,
      note: "License on MakerWorld: Standard Digital File License",
    });
  });

  test("gives no text for a file with no MakerWorld details", async () => {
    const bytes = build3mf({ plates: 1 });
    const { store } = rangeStore(bytes);
    expect(await storeTextReader(store)({ fileId: FILE_A, key: "k", size: bytes.length })).toEqual({
      html: null,
      note: null,
    });
  });

  test("is null for an object that is gone", async () => {
    const { store } = rangeStore(null);
    expect(await storeTextReader(store)({ fileId: FILE_A, key: "k", size: 1000 })).toBeNull();
  });

  test("is null for an object that is not a zip", async () => {
    const { store } = rangeStore(Buffer.alloc(4096, 7));
    expect(await storeTextReader(store)({ fileId: FILE_A, key: "k", size: 4096 })).toBeNull();
  });

  test("throws SourceOutage, with the store's error as its cause, for an outage", async () => {
    const outage = new StoreUnavailable("GetObject", "ECONNREFUSED");
    const bytes = build3mf({ plates: 1 });
    const { store } = rangeStore(bytes, outage);
    const err = await storeTextReader(store)({
      fileId: FILE_A,
      key: "k",
      size: bytes.length,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceOutage);
    expect((err as Error).cause).toBe(outage);
  });

  // Only the store as a whole being unavailable or refusing stops the run;
  // a refusal about the one object is that object being unreadable (#382).
  test.each([
    ["a store that cannot be reached", new StoreUnavailable("GetObject", "ETIMEDOUT"), "outage"],
    ["access denied", new StoreError("GetObject", "AccessDenied", 403), "outage"],
    ["a missing bucket", new StoreError("GetObject", "NoSuchBucket", 404), "outage"],
    ["a range the store refuses", new StoreError("GetObject", "InvalidRange", 416), "null"],
    ["an answer with no body", new StoreError("GetObject", "NoBody"), "null"],
    ["a range the caller got wrong", new RangeError("bad range"), "null"],
    ["any other error", new TypeError("a bug in a reader"), "null"],
  ])("classifies %s", async (_what, error, expected) => {
    const bytes = build3mf({ plates: 1 });
    const { store } = rangeStore(bytes, error);
    const got = await storeTextReader(store)({ fileId: FILE_A, key: "k", size: bytes.length }).then(
      (v) => (v === null ? "null" : "text"),
      (e: unknown) => (e instanceof SourceOutage ? "outage" : `other ${String(e)}`),
    );
    expect(got).toBe(expected);
  });

  test("gives each range read the run's signal, and stops when it aborts", async () => {
    const bytes = build3mf({ plates: 1 });
    const seen: Array<AbortSignal | undefined> = [];
    const controller = new AbortController();
    const store = {
      getBlobRange: async (
        _k: string,
        start: number,
        end: number,
        opts?: { signal?: AbortSignal },
      ) => {
        seen.push(opts?.signal);
        controller.abort();
        const err = new Error("The read was stopped");
        err.name = "AbortError";
        if (opts?.signal?.aborted) throw err;
        return Readable.from([bytes.subarray(start, end)]);
      },
    };
    const err = await storeTextReader(store)(
      { fileId: FILE_A, key: "k", size: bytes.length },
      controller.signal,
    ).catch((e: unknown) => e);
    expect(seen[0]).toBe(controller.signal);
    expect((err as Error).name).toBe("AbortError");
  });
});

// A file that is wrong in any way counts its model as could not be read, and
// the run goes on; a stop part way through a model counts nothing for it.
describe("a run and one bad file", () => {
  test("counts a model whose read fails for a reason other than an outage as could not be read", async () => {
    const rows = [stored({ modelId: model(1), description: BY_RC })];
    const files = { [model(1)]: [file(fileOf(1))] };
    const mem = memoryStore(rows, files);
    const reconvert = createDescriptionReconvert({
      store: mem.store,
      readText: async () => {
        throw new TypeError("a reader bug on a crafted file");
      },
      log: () => {},
    });
    expect(await reconvert.run()).toMatchObject({ checked: 1, unreadable: 1 });
  });

  test("counts a model the converter throws on as could not be read", async () => {
    const rows = [stored({ modelId: model(1), description: BY_RC })];
    const files = { [model(1)]: [file(fileOf(1))] };
    const mem = memoryStore(rows, files);
    // An html getter that throws stands in for the converter failing on it.
    const hostile = {
      get html(): string {
        throw new Error("converter failure");
      },
      note: null,
    } as unknown as SourceText;
    const reconvert = createDescriptionReconvert({
      store: mem.store,
      readText: async () => hostile,
      log: () => {},
    });
    expect(await reconvert.run()).toMatchObject({ checked: 1, unreadable: 1 });
    expect(mem.writes).toEqual([]);
  });

  test("a stop in the middle of a model counts nothing for it, and the next run decides it", async () => {
    const rows = [
      stored({ modelId: model(1), description: BY_RC }),
      stored({ modelId: model(2), description: BY_RC }),
    ];
    const files = { [model(1)]: [file(fileOf(1))], [model(2)]: [file(fileOf(2))] };
    const mem = memoryStore(rows, files);
    const controller = new AbortController();
    const reconvert = createDescriptionReconvert({
      store: mem.store,
      readText: async (f, signal) => {
        if (f.fileId === fileOf(2) && !controller.signal.aborted) {
          controller.abort();
          const err = new Error("The read was stopped");
          err.name = "AbortError";
          if (signal?.aborted) throw err;
        }
        return { html: HTML, note: null };
      },
      log: () => {},
    });
    expect(await reconvert.run(undefined, controller.signal)).toBe(RECONVERT_PAUSED);
    expect(mem.writes.map((w) => w.modelId)).toEqual([model(1)]);
    const result = await reconvert.run();
    expect(result).toMatchObject({ checked: 2, changed: 2 });
    expect(mem.writes.map((w) => w.modelId)).toEqual([model(1), model(2)]);
  });

  test("a signal already aborted ends the run before it reads anything", async () => {
    const rows = [stored({ modelId: model(1), description: BY_RC })];
    const files = { [model(1)]: [file(fileOf(1))] };
    const mem = memoryStore(rows, files);
    const { readText } = reader({ [fileOf(1)]: { html: HTML, note: null } });
    const controller = new AbortController();
    controller.abort();
    const reconvert = createDescriptionReconvert({ store: mem.store, readText, log: () => {} });
    expect(await reconvert.run(undefined, controller.signal)).toBe(RECONVERT_PAUSED);
    expect(readText).not.toHaveBeenCalled();
  });
});
