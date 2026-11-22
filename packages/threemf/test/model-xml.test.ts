import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { type RangeSource, ReadUnavailable, readMakerWorldXml, readProject } from "../src/index.js";
import {
  build3mf,
  buildZip,
  MiB,
  MODEL_XML,
  png,
  projectEntries,
  seededBytes,
  writeTmp,
} from "./support/fixture-builder.js";

// readMakerWorldXml reads only what the MakerWorld details need, 3D/3dmodel.model
// up to <resources, through ranged reads, so the description re-conversion
// (#357) can read a stored .3mf without downloading all of it.

/**
 * A range source over bytes in memory that records every range asked for. It
 * refuses an empty or backwards range, as the object store's getBlobRange
 * does, so a read past the end of the file shows here as it would in the server.
 */
function memorySource(bytes: Buffer): { source: RangeSource; read: () => number } {
  let read = 0;
  return {
    source: async (start, end) => {
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) {
        throw new RangeError("the range must be whole byte offsets with start < end");
      }
      read += end - start;
      return Readable.from([bytes.subarray(start, end)]);
    },
    read: () => read,
  };
}

const prefixOf = (xml: string): string => xml.slice(0, xml.indexOf("<resources"));

describe("readMakerWorldXml", () => {
  it("gives the same text readProject gives as makerWorldXml", async () => {
    const bytes = build3mf({ plates: [{ index: 1 }] });
    const project = await readProject(writeTmp(bytes));
    const { source } = memorySource(bytes);
    const xml = await readMakerWorldXml(source, bytes.length);
    expect(xml).toBe(prefixOf(MODEL_XML));
    expect(xml).toBe(project?.makerWorldXml);
  });

  it("reads a few kilobytes of a large file, not its thumbnails or mesh", async () => {
    // Stored, not deflated, so the thumbnails and the mesh take their full
    // size in the archive.
    const model = `${prefixOf(MODEL_XML)}<resources>${"v".repeat(4 * MiB)}</resources></model>`;
    const bytes = build3mf({
      plates: [{ index: 1 }, { index: 2 }],
      model,
      extra: [
        { name: "Metadata/plate_1.png", data: png("one", 4 * MiB), method: 0 },
        { name: "Metadata/plate_2.png", data: png("two", 4 * MiB), method: 0 },
        { name: "Metadata/big.bin", data: seededBytes(4 * MiB), method: 0 },
      ],
    });
    expect(bytes.length).toBeGreaterThan(8 * MiB);
    const { source, read } = memorySource(bytes);
    expect(await readMakerWorldXml(source, bytes.length)).toBe(prefixOf(MODEL_XML));
    expect(read()).toBeLessThan(256 * 1024);
  });

  it("caps the text at 256 KiB, as readProject does", async () => {
    const head = '<?xml version="1.0"?>\n<model>\n';
    const bytes = build3mf({ plates: [{ index: 1 }], model: head + " ".repeat(2 * MiB) });
    const { source } = memorySource(bytes);
    const xml = await readMakerWorldXml(source, bytes.length);
    expect(xml?.length).toBe(256 * 1024);
    expect(xml?.startsWith(head)).toBe(true);
  });

  it("needs no plate data, since the text is all it reads", async () => {
    const bytes = build3mf({ modelSettings: null });
    const { source } = memorySource(bytes);
    expect(await readMakerWorldXml(source, bytes.length)).toBe(prefixOf(MODEL_XML));
  });

  it("is null when the file has no 3D/3dmodel.model", async () => {
    const bytes = build3mf({ plates: [{ index: 1 }], model: null });
    const { source } = memorySource(bytes);
    expect(await readMakerWorldXml(source, bytes.length)).toBeNull();
  });

  it("is null for bytes that are not a zip", async () => {
    const bytes = seededBytes(64 * 1024);
    const { source } = memorySource(bytes);
    expect(await readMakerWorldXml(source, bytes.length)).toBeNull();
  });

  it("is ReadUnavailable, with the source's error as its cause, when the source fails", async () => {
    const bytes = build3mf({ plates: [{ index: 1 }] });
    const outage = new Error("the store is down");
    const err = await readMakerWorldXml(async () => {
      throw outage;
    }, bytes.length).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReadUnavailable);
    expect((err as Error).cause).toBe(outage);
  });

  it("is ReadUnavailable when a range stream fails part way", async () => {
    const bytes = build3mf({ plates: [{ index: 1 }] });
    const dropped = new Error("connection reset");
    const source: RangeSource = async (start, end) =>
      new Readable({
        read() {
          this.push(bytes.subarray(start, Math.min(end, start + 4)));
          this.destroy(dropped);
        },
      });
    const err = await readMakerWorldXml(source, bytes.length).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReadUnavailable);
    expect((err as Error).cause).toBe(dropped);
  });

  // A damaged or crafted file whose offsets point at or past its end must read
  // as damaged (null), as readProject reads it, and never ask the store for an
  // empty range, which the store refuses as an error.
  describe("an offset at or past the end of the file is damage, not a failed read", () => {
    const onePlate = { plates: [{ index: 1 }] };
    const cases: { name: string; file: () => Buffer }[] = [
      {
        name: "a central directory offset at the end of the file",
        file: () => {
          const size = build3mf(onePlate).length;
          return build3mf(onePlate, { cdOffset: size });
        },
      },
      {
        name: "a central directory offset past the end of the file",
        file: () => build3mf(onePlate, { cdOffset: 0x7fffffff }),
      },
      {
        name: "a model local header offset past the end of the file",
        file: () =>
          buildZip(
            projectEntries(onePlate).map((e) =>
              e.name === "3D/3dmodel.model" ? { ...e, localOffset: 0x7fffffff } : e,
            ),
          ),
      },
      {
        name: "a Zip64 end-record offset past the end of the file",
        file: () => build3mf(onePlate, { zip64EndAt: 0xffffffn }),
      },
      {
        name: "an impossible Zip64 end-record offset",
        file: () => build3mf(onePlate, { zip64EndAt: 2n ** 62n }),
      },
    ];
    for (const { name, file } of cases) {
      it(`is null for ${name}`, async () => {
        const bytes = file();
        const { source } = memorySource(bytes);
        expect(await readMakerWorldXml(source, bytes.length)).toBeNull();
      });
    }
  });
});
