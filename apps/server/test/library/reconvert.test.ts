// The description re-conversion (#357), without a database: what it decides
// for one model, and how a run walks the library, counts and records itself.
// The database side (repos/descriptions.ts) and the run against a real
// Postgres and object store are in test/integration/library/reconvert.test.ts.
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import {
  composeDescription,
  createDescriptionReconvert,
  type Decision,
  decide,
  descriptionSha256,
  RECONVERT_STEP,
  type ReconvertStore,
  type SourceFile,
  type SourceText,
  type StoredDescription,
  storeTextReader,
} from "../../src/library/reconvert.js";
import { BlobNotFound, StoreUnavailable } from "../../src/storage/s3.js";
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

/** An in-memory ReconvertStore over a list of stored descriptions. */
function memoryStore(rows: StoredDescription[], files: Record<string, SourceFile[]>) {
  const finished = new Map<string, unknown>();
  const writes: Array<{ modelId: string; description: string; fileId: string }> = [];
  const pages: Array<string | null> = [];
  let refuse = new Set<string>();
  const store: ReconvertStore = {
    stepFinished: async (name) => finished.has(name),
    finishStep: async (name, result) => {
      finished.set(name, result);
    },
    candidates: async (after, limit) => {
      pages.push(after);
      return rows
        .filter((r) => after === null || r.modelId > after)
        .sort((a, b) => (a.modelId < b.modelId ? -1 : 1))
        .slice(0, limit);
    },
    sourceFiles: async (modelId) => files[modelId] ?? [],
    write: async (row, next) => {
      if (refuse.has(row.modelId)) return false;
      writes.push({ modelId: row.modelId, ...next });
      return true;
    },
  };
  return {
    store,
    finished,
    writes,
    pages,
    refuseWrites: (ids: string[]) => {
      refuse = new Set(ids);
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

  test("stops, records nothing and rethrows when a file read fails for a reason other than the file", async () => {
    const { rows, files } = library();
    const mem = memoryStore(rows, files);
    const outage = new Error("the store is down");
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

  test("is named for the converter version, so the next converter fix runs again", () => {
    expect(RECONVERT_STEP).toBe("reconvert-descriptions-3");
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

  test("throws the store's own error for an outage, so the run stops", async () => {
    const outage = new StoreUnavailable("GetObject", "ECONNREFUSED");
    const bytes = build3mf({ plates: 1 });
    const { store } = rangeStore(bytes, outage);
    await expect(
      storeTextReader(store)({ fileId: FILE_A, key: "k", size: bytes.length }),
    ).rejects.toBe(outage);
  });
});
