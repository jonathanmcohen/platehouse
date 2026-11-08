// Behaviour tests for the 3MF reader, ported by behaviour from the Bambu
// Plates parser (parser.rb@136fd61) plus the fields Platehouse adds:
// slicedFor, processName and the MakerWorld model prefix. Every fixture is
// built here; no designer file is used.
import { chmodSync, unlinkSync } from "node:fs";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import yauzl from "yauzl";
import {
  LIMITS,
  NO_PLATE_DATA_MESSAGE,
  type Project,
  ReadUnavailable,
  readProject,
} from "../src/index.js";
import { readProjectFromReader } from "../src/parse.js";
import {
  build3mf,
  buildZip,
  MiB,
  MODEL_XML,
  modelSettingsXml,
  P1S_PROJECT,
  png,
  projectEntries,
  range,
  type SliceSpec,
  writeTmp,
} from "./support/fixture-builder.js";

const read = (buf: Buffer, opts?: Parameters<typeof readProject>[1]): Promise<Project | null> =>
  readProject(writeTmp(buf), opts);

async function mustRead(buf: Buffer): Promise<Project> {
  const project = await read(buf);
  if (project === null) throw new Error("expected a project, got null");
  return project;
}

/** Broken XML that fast-xml-parser 5.12.0 throws on, not just tolerates. */
const MALFORMED_XML = [
  "<config><plate></plate",
  '<config><plate a="1></plate></config>',
  '<config><plate><metadata key="plater_id" value="1"/></plate',
];

const slicedP1S = (index: number, extra: Partial<SliceSpec> = {}): SliceSpec => ({
  index,
  prediction: 5025,
  weight: 41.37,
  printerModelId: "C12",
  nozzle: "0.4",
  filaments: [
    { id: 1, type: "PLA", color: "#00AE42", usedG: 30.1 },
    { id: 2, type: "PETG", color: "#FFFFFF", usedG: 11.27 },
  ],
  ...extra,
});

describe("the contract values", () => {
  it("LIMITS are the Bambu Plates 0.1.1 ceilings, exactly", () => {
    expect(LIMITS).toEqual({
      configBytes: 5 * MiB,
      pngBytes: 10 * MiB,
      plates: 128,
      filaments: 256,
      thumbnailBytesPerFile: 128 * MiB,
      predictionSeconds: 315360000,
    });
    expect(Object.isFrozen(LIMITS)).toBe(true);
  });

  it("the damage message is exact", () => {
    expect(NO_PLATE_DATA_MESSAGE).toBe("No Bambu plate data in this file");
  });
});

describe("the plate list", () => {
  it("comes from model_settings.config in plate order, with names and object counts", async () => {
    const project = await mustRead(
      build3mf({
        plates: [
          { index: 2, name: "Lid", objects: 3 },
          { index: 1, name: "Base", objects: 1 },
        ],
      }),
    );
    expect(project.plates).toEqual([
      { index: 1, name: "Base", objectCount: 1, sliced: false, filaments: [] },
      { index: 2, name: "Lid", objectCount: 3, sliced: false, filaments: [] },
    ]);
  });

  it.each(["", " ", " \t\n "])("gives null for a plate name of %j", async (name) => {
    const project = await mustRead(build3mf({ plates: [{ index: 1, name }] }));
    expect(project.plates[0]?.name).toBeNull();
    expect(project.plates[0]?.index).toBe(1);
  });

  it("keeps a non-blank name exactly as written, spaces included", async () => {
    const project = await mustRead(build3mf({ plates: [{ index: 1, name: " Lid " }] }));
    expect(project.plates[0]?.name).toBe(" Lid ");
  });

  it("keeps a non-ASCII name byte for byte", async () => {
    // "Fensterkeil - Turstopper" with an en dash and a u-umlaut, written as
    // escapes so this source file stays ASCII.
    const name = "Fensterkeil \u2013 T\u00FCrstopper";
    const project = await mustRead(build3mf({ plates: [{ index: 1, name }] }));
    expect(Buffer.from(project.plates[0]?.name ?? "", "utf8")).toEqual(Buffer.from(name, "utf8"));
  });

  it("decodes XML escapes in plate names", async () => {
    const project = await mustRead(build3mf({ plates: [{ index: 1, name: 'Lid & "base" <v2>' }] }));
    expect(project.plates[0]?.name).toBe('Lid & "base" <v2>');
  });

  it("skips plates whose id is not a positive integer, and keeps the first of a duplicate", async () => {
    const project = await mustRead(
      build3mf({
        plates: [
          { index: 0 },
          { index: -1 },
          { index: "x" },
          { index: 3, name: "first" },
          { index: 3, name: "second" },
        ],
      }),
    );
    expect(project.plates.map((p) => [p.index, p.name])).toEqual([[3, "first"]]);
  });

  it("falls back to the plate_N.png names, with _small as the fallback", async () => {
    const project = await mustRead(
      build3mf({ pngs: { 3: png("p3"), 1: png("p1") }, smallPngs: { 2: png("p2s") } }),
    );
    expect(project.plates).toEqual([
      { index: 1, name: null, objectCount: 0, sliced: false, filaments: [] },
      { index: 2, name: null, objectCount: 0, sliced: false, filaments: [] },
      { index: 3, name: null, objectCount: 0, sliced: false, filaments: [] },
    ]);
  });

  it("lists a plate gap as it is, and hands over only the thumbnails there are", async () => {
    const indexes: number[] = [];
    const project = await readProject(
      writeTmp(
        build3mf({
          plates: [
            { index: 1, name: "A" },
            { index: 3, name: "C", objects: 2 },
          ],
          pngs: { 1: png("one"), 3: png("three") },
        }),
      ),
      { onThumbnail: async (i) => void indexes.push(i) },
    );
    expect(project?.plates.map((p) => [p.index, p.name, p.objectCount])).toEqual([
      [1, "A", 1],
      [3, "C", 2],
    ]);
    expect(indexes).toEqual([1, 3]);
  });

  it("falls back to the png names when model_settings.config is not XML", async () => {
    const project = await mustRead(build3mf({ modelSettings: "not xml", pngs: { 1: png("p1") } }));
    expect(project.plates.map((p) => [p.index, p.name])).toEqual([[1, null]]);
  });

  // fast-xml-parser throws on some broken XML (Nokogiri, under parser.rb,
  // recovers from all of it). Either way a broken model_settings.config costs
  // the plate names, never the file (test_garbage_model_settings_returns_nil_or_png_fallback).
  it.each(MALFORMED_XML)(
    "falls back to the png names when model_settings.config is %j",
    async (modelSettings) => {
      const project = await mustRead(build3mf({ modelSettings, pngs: { 1: png("p1") } }));
      expect(project.plates).toEqual([
        { index: 1, name: null, objectCount: 0, sliced: false, filaments: [] },
      ]);
    },
  );

  it("is null when model_settings.config is broken and there is no plate png to fall back to", async () => {
    expect(await read(build3mf({ modelSettings: "<config><plate></plate" }))).toBeNull();
  });

  it("falls back to the png names when model_settings.config names no plate", async () => {
    const project = await mustRead(
      build3mf({ modelSettings: modelSettingsXml([]), pngs: { 1: png("p1") } }),
    );
    expect(project.plates.map((p) => p.index)).toEqual([1]);
  });

  it("is null when the file holds no plate data at all", async () => {
    expect(await read(build3mf({}))).toBeNull();
    expect(await read(build3mf({ modelSettings: modelSettingsXml([]) }))).toBeNull();
  });

  it("reads entries only by their exact name", async () => {
    const lookalikes = buildZip([
      { name: "3D/3dmodel.model", data: MODEL_XML },
      { name: "metadata/model_settings.config", data: modelSettingsXml([{ index: 1 }]) },
      { name: "Metadata/model_settings.config.bak", data: modelSettingsXml([{ index: 2 }]) },
      { name: "x/Metadata/model_settings.config", data: modelSettingsXml([{ index: 3 }]) },
      { name: "Metadata/plate_4.PNG", data: png("p4") },
      { name: "Metadata/plate_05x.png", data: png("p5") },
    ]);
    expect(await read(lookalikes)).toBeNull();
  });
});

describe("embedded slice data", () => {
  it("gives Bambu's numbers and per-filament grams for a sliced plate", async () => {
    const project = await mustRead(
      build3mf({ plates: [{ index: 1 }, { index: 2, objects: 2 }], slices: [slicedP1S(1)] }),
    );
    expect(project.plates[0]).toEqual({
      index: 1,
      name: null,
      objectCount: 1,
      sliced: true,
      predictionSeconds: 5025,
      weightGrams: 41.37,
      filaments: [
        { slot: 1, type: "PLA", colour: "#00AE42", grams: 30.1 },
        { slot: 2, type: "PETG", colour: "#FFFFFF", grams: 11.27 },
      ],
    });
    expect(project.plates[1]).toEqual({
      index: 2,
      name: null,
      objectCount: 2,
      sliced: false,
      filaments: [],
    });
  });

  it("treats a missing, zero or non-numeric prediction as not sliced", async () => {
    const project = await mustRead(
      build3mf({
        plates: range(3).map((index) => ({ index })),
        slices: [
          slicedP1S(1, { prediction: undefined }),
          slicedP1S(2, { prediction: 0 }),
          slicedP1S(3, { prediction: "soon" }),
        ],
      }),
    );
    expect(project.plates.map((p) => p.sliced)).toEqual([false, false, false]);
    expect(project.slicedFor).toBeUndefined();
  });

  it("counts a prediction of exactly ten years as sliced (inclusive ceiling)", async () => {
    const project = await mustRead(
      build3mf({
        plates: [{ index: 1 }],
        slices: [slicedP1S(1, { prediction: LIMITS.predictionSeconds })],
      }),
    );
    expect(project.plates[0]?.sliced).toBe(true);
    expect(project.plates[0]?.predictionSeconds).toBe(LIMITS.predictionSeconds);
  });

  it("gives null weight and grams when slice_info carries none that parse", async () => {
    const project = await mustRead(
      build3mf({
        plates: [{ index: 1 }],
        slices: [
          slicedP1S(1, { weight: "heavy", filaments: [{ id: 1, type: "PLA", usedG: "lots" }] }),
        ],
      }),
    );
    const plate = project.plates[0];
    expect(plate?.sliced).toBe(true);
    expect(plate?.weightGrams).toBeUndefined();
    expect(plate?.filaments).toEqual([{ slot: 1, type: "PLA", colour: "#FFFFFF", grams: null }]);
  });

  it("matches slice data to plates by index, not by position", async () => {
    const project = await mustRead(
      build3mf({
        plates: [{ index: 1 }, { index: 2 }],
        slices: [slicedP1S(2, { prediction: 120 })],
      }),
    );
    expect(project.plates.map((p) => p.sliced)).toEqual([false, true]);
    expect(project.plates[1]?.predictionSeconds).toBe(120);
  });

  it("leaves the plates unsliced when slice_info.config is not well-formed XML", async () => {
    const project = await mustRead(
      build3mf({ plates: [{ index: 1, name: "A" }], sliceInfo: "<config><plate>" }),
    );
    expect(project.plates).toEqual([
      { index: 1, name: "A", objectCount: 1, sliced: false, filaments: [] },
    ]);
    expect(project.slicedFor).toBeUndefined();
  });

  // test_garbage_slice_info_leaves_plates_unsliced, over XML that makes
  // fast-xml-parser throw: broken slice data costs the slice data only.
  it.each(MALFORMED_XML)(
    "leaves the plates unsliced when slice_info.config is %j",
    async (sliceInfo) => {
      const project = await mustRead(build3mf({ plates: [{ index: 1, name: "A" }], sliceInfo }));
      expect(project.plates).toEqual([
        { index: 1, name: "A", objectCount: 1, sliced: false, filaments: [] },
      ]);
      expect(project.slicedFor).toBeUndefined();
    },
  );

  it("ignores slice data for a plate the plate list does not have", async () => {
    const project = await mustRead(build3mf({ plates: [{ index: 1 }], slices: [slicedP1S(2)] }));
    expect(project.plates).toHaveLength(1);
    expect(project.plates[0]?.sliced).toBe(false);
  });

  it("reports the printer and nozzle the file was sliced for", async () => {
    const project = await mustRead(build3mf({ plates: [{ index: 1 }], slices: [slicedP1S(1)] }));
    expect(project.slicedFor).toEqual({ printerModelId: "C12", nozzle: 0.4 });
  });

  it("takes the first nozzle when nozzle_diameters lists several", async () => {
    const project = await mustRead(
      build3mf({ plates: [{ index: 1 }], slices: [slicedP1S(1, { nozzle: "0.4 0.6" })] }),
    );
    expect(project.slicedFor).toEqual({ printerModelId: "C12", nozzle: 0.4 });
  });

  it("leaves slicedFor out when the file is unsliced or the keys are missing", async () => {
    const unsliced = await mustRead(build3mf({ plates: [{ index: 1 }] }));
    expect(unsliced.slicedFor).toBeUndefined();
    const noModel = await mustRead(
      build3mf({ plates: [{ index: 1 }], slices: [slicedP1S(1, { printerModelId: undefined })] }),
    );
    expect(noModel.slicedFor).toBeUndefined();
    const badNozzle = await mustRead(
      build3mf({ plates: [{ index: 1 }], slices: [slicedP1S(1, { nozzle: "wide" })] }),
    );
    expect(badNozzle.slicedFor).toBeUndefined();
  });
});

describe("colours", () => {
  const colourOf = async (color: string): Promise<string | null | undefined> => {
    const project = await mustRead(
      build3mf({
        plates: [{ index: 1 }],
        slices: [slicedP1S(1, { filaments: [{ id: 1, type: "PLA", color, usedG: 1 }] })],
      }),
    );
    return project.plates[0]?.filaments[0]?.colour;
  };

  it.each(["#00ae42", "#00AE42", "#00AE42FF", "#0a0B0c80"])("accepts %s", async (c) => {
    expect(await colourOf(c)).toBe(c);
  });

  it.each([
    "#FFF",
    "red",
    "#GGGGGG",
    "#FFFFFF ",
    " #FFFFFF",
    "#FFFFFFF",
    "FFFFFF",
    "#FFFFFF\n",
    "",
  ])("gives null for %j", async (c) => {
    expect(await colourOf(c)).toBeNull();
  });
});

describe("project settings", () => {
  it("gives the project's filament list with types and colours, slots from 1", async () => {
    const project = await mustRead(build3mf({ plates: [{ index: 1 }], project: P1S_PROJECT }));
    expect(project.projectFilaments).toEqual([
      { slot: 1, type: "PLA", colour: "#00AE42", grams: null },
      { slot: 2, type: "PETG", colour: "#FFFFFF80", grams: null },
    ]);
  });

  it("gives null for a missing or malformed colour", async () => {
    const project = await mustRead(
      build3mf({
        plates: [{ index: 1 }],
        project: { filament_type: ["PLA", "PETG", "ABS"], filament_colour: ["blue", "#123456"] },
      }),
    );
    expect(project.projectFilaments.map((f) => f.colour)).toEqual([null, "#123456", null]);
  });

  it("reports the process name from print_settings_id, as a string or a list", async () => {
    const asString = await mustRead(build3mf({ plates: [{ index: 1 }], project: P1S_PROJECT }));
    expect(asString.processName).toBe("0.20mm Standard @BBL X1C");
    const asList = await mustRead(
      build3mf({ plates: [{ index: 1 }], project: { print_settings_id: ["0.16mm Fine"] } }),
    );
    expect(asList.processName).toBe("0.16mm Fine");
  });

  it("keeps the plates when project_settings.config is not valid JSON", async () => {
    const project = await mustRead(build3mf({ plates: [{ index: 1 }], project: "{not json" }));
    expect(project.plates).toHaveLength(1);
    expect(project.projectFilaments).toEqual([]);
    expect(project.processName).toBeUndefined();
  });

  it("gives an empty filament list when project_settings.config has none of the keys", async () => {
    const project = await mustRead(build3mf({ plates: [{ index: 1 }], project: "{}" }));
    expect(project.projectFilaments).toEqual([]);
    expect(project.processName).toBeUndefined();
  });

  it("gives an empty filament list when the file has no project settings", async () => {
    const project = await mustRead(build3mf({ plates: [{ index: 1 }] }));
    expect(project.projectFilaments).toEqual([]);
    expect(project.processName).toBeUndefined();
  });
});

describe("the MakerWorld model prefix", () => {
  it("is 3D/3dmodel.model up to <resources", async () => {
    const project = await mustRead(build3mf({ plates: [{ index: 1 }] }));
    const prefix = MODEL_XML.slice(0, MODEL_XML.indexOf("<resources"));
    expect(project.makerWorldXml).toBe(prefix);
  });

  it("is capped at 256 KiB when <resources never comes", async () => {
    const head = '<?xml version="1.0"?>\n<model>\n';
    const model = head + " ".repeat(2 * MiB);
    const project = await mustRead(build3mf({ plates: [{ index: 1 }], model }));
    expect(project.makerWorldXml?.length).toBe(256 * 1024);
    expect(project.makerWorldXml?.startsWith(head)).toBe(true);
  });

  it("stops at <resources even when the mesh after it is large", async () => {
    const model = `${MODEL_XML.slice(0, MODEL_XML.indexOf("<resources"))}<resources>${"v".repeat(8 * MiB)}`;
    const project = await mustRead(build3mf({ plates: [{ index: 1 }], model }));
    expect(
      project.makerWorldXml?.endsWith('<metadata name="Title">Synthetic Title</metadata>\n '),
    ).toBe(true);
  });

  it("is left out when the file has no 3D/3dmodel.model", async () => {
    const project = await mustRead(build3mf({ plates: [{ index: 1 }], model: null }));
    expect(project.makerWorldXml).toBeUndefined();
  });
});

describe("XML safety", () => {
  it("refuses a config carrying a DTD with an external entity", async () => {
    const xml =
      '<?xml version="1.0"?>\n<!DOCTYPE config [<!ENTITY ext SYSTEM "file:///etc/passwd">]>\n' +
      '<config><plate><metadata key="plater_id" value="1"/>' +
      '<metadata key="plater_name" value="&ext;"/></plate></config>';
    expect(await read(build3mf({ modelSettings: xml }))).toBeNull();
  });

  it("refuses a config carrying an internal entity expansion", async () => {
    const xml =
      '<?xml version="1.0"?>\n<!DOCTYPE config [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;">]>\n' +
      '<config><plate><metadata key="plater_id" value="1"/>' +
      '<metadata key="plater_name" value="&b;"/></plate></config>';
    expect(await read(build3mf({ modelSettings: xml }))).toBeNull();
  });

  it("refuses a DTD in slice_info.config too", async () => {
    const xml =
      '<?xml version="1.0"?>\n<!DOCTYPE config SYSTEM "http://example.invalid/x.dtd">\n<config/>';
    expect(await read(build3mf({ plates: [{ index: 1 }], sliceInfo: xml }))).toBeNull();
  });
});

describe("thumbnails", () => {
  it("are yielded one at a time in plate order, never two in flight", async () => {
    const file = writeTmp(
      build3mf({
        plates: [{ index: 3 }, { index: 1 }, { index: 2 }],
        pngs: { 3: png("three"), 1: png("one") },
        smallPngs: { 2: png("two-small"), 3: png("three-small") },
      }),
    );
    const seen: Array<[number, string]> = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const project = await readProject(file, {
      onThumbnail: async (index, buf) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 15));
        seen.push([index, buf.subarray(8).toString("latin1")]);
        inFlight--;
      },
    });
    expect(project).not.toBeNull();
    expect(seen).toEqual([
      [1, "one"],
      [2, "two-small"],
      [3, "three"],
    ]);
    expect(maxInFlight).toBe(1);
  });

  it("skip a plate that has no thumbnail, which is still listed", async () => {
    const indexes: number[] = [];
    const project = await readProject(
      writeTmp(build3mf({ plates: [{ index: 1 }, { index: 2 }], pngs: { 2: png("two") } })),
      { onThumbnail: async (i) => void indexes.push(i) },
    );
    expect(project?.plates.map((p) => p.index)).toEqual([1, 2]);
    expect(indexes).toEqual([2]);
  });

  it("fall back to plate_N_small.png when plate_N.png is empty", async () => {
    const seen: Array<[number, string]> = [];
    const project = await readProject(
      writeTmp(
        build3mf({
          plates: [{ index: 1 }],
          pngs: { 1: Buffer.alloc(0) },
          smallPngs: { 1: png("small") },
        }),
      ),
      { onThumbnail: async (i, buf) => void seen.push([i, buf.subarray(8).toString("latin1")]) },
    );
    expect(project).not.toBeNull();
    expect(seen).toEqual([[1, "small"]]);
  });

  it("skip a plate whose only thumbnail is empty", async () => {
    const indexes: number[] = [];
    const project = await readProject(
      writeTmp(build3mf({ plates: [{ index: 1 }], pngs: { 1: Buffer.alloc(0) } })),
      { onThumbnail: async (i) => void indexes.push(i) },
    );
    expect(project?.plates).toHaveLength(1);
    expect(indexes).toEqual([]);
  });

  it("are not handed over at all when the file turns out damaged", async () => {
    const pngs: Record<number, Buffer> = { 1: png("ok"), 2: png("big", LIMITS.pngBytes + 1) };
    const indexes: number[] = [];
    const project = await readProject(
      writeTmp(build3mf({ plates: [{ index: 1 }, { index: 2 }], pngs })),
      { onThumbnail: async (i) => void indexes.push(i) },
    );
    expect(project).toBeNull();
    expect(indexes).toEqual([]);
  });

  it("accept a thumbnail of exactly the 10 MiB ceiling", async () => {
    const sizes: number[] = [];
    const project = await readProject(
      writeTmp(build3mf({ plates: [{ index: 1 }], pngs: { 1: png("max", LIMITS.pngBytes) } })),
      { onThumbnail: async (_i, buf) => void sizes.push(buf.length) },
    );
    expect(project).not.toBeNull();
    expect(sizes).toEqual([LIMITS.pngBytes]);
  });

  it("honour a lower maxThumbnailBytes", async () => {
    const buf = build3mf({ plates: [{ index: 1 }], pngs: { 1: png("p", 2048) } });
    expect(await read(buf, { maxThumbnailBytes: 2048 })).not.toBeNull();
    expect(await read(buf, { maxThumbnailBytes: 2047 })).toBeNull();
  });

  it.each([Number.NaN, 0, -1, Number.POSITIVE_INFINITY])(
    "ignore a maxThumbnailBytes of %s and keep the 10 MiB ceiling",
    async (maxThumbnailBytes) => {
      const over = build3mf({ plates: [{ index: 1 }], pngs: { 1: png("p", LIMITS.pngBytes + 1) } });
      expect(await read(over, { maxThumbnailBytes })).toBeNull();
      const sizes: number[] = [];
      const project = await readProject(
        writeTmp(build3mf({ plates: [{ index: 1 }], pngs: { 1: png("p", 2048) } })),
        { maxThumbnailBytes, onThumbnail: async (_i, buf) => void sizes.push(buf.length) },
      );
      expect(project).not.toBeNull();
      expect(sizes).toEqual([2048]);
    },
  );

  it("cannot have the 10 MiB ceiling raised by maxThumbnailBytes", async () => {
    const buf = build3mf({ plates: [{ index: 1 }], pngs: { 1: png("p", LIMITS.pngBytes + 1) } });
    expect(await read(buf, { maxThumbnailBytes: 64 * MiB })).toBeNull();
  });

  it("accept exactly the 128 MiB per-file budget", async () => {
    const pngs: Record<number, Buffer> = {};
    for (const i of range(12)) pngs[i] = png(`p${i}`, LIMITS.pngBytes);
    pngs[13] = png("p13", 8 * MiB);
    const sizes: number[] = [];
    const project = await readProject(
      writeTmp(build3mf({ plates: range(13).map((index) => ({ index })), pngs })),
      { onThumbnail: async (_i, buf) => void sizes.push(buf.length) },
    );
    expect(project).not.toBeNull();
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(LIMITS.thumbnailBytesPerFile);
  });
});

// A bug in the caller is not a file with no plate data (parser.rb@136fd61,
// test_read_passes_on_an_error_raised_by_the_block): whatever onThumbnail
// throws reaches the caller as the same object, never null and never
// ReadUnavailable, and no further thumbnail is read or handed over.
describe("errors from onThumbnail reach the caller unchanged", () => {
  const twoPlates = build3mf({
    plates: [{ index: 1 }, { index: 2 }],
    pngs: { 1: png("one"), 2: png("two") },
  });

  const systemError = (): NodeJS.ErrnoException => {
    const err: NodeJS.ErrnoException = new Error("connect ECONNREFUSED 127.0.0.1:9000");
    err.code = "ECONNREFUSED";
    err.syscall = "connect";
    return err;
  };

  const thrown: Array<[string, () => unknown]> = [
    ["a plain Error", () => new Error("from the callback")],
    ["a TypeError", () => new TypeError("from the callback")],
    ["a RangeError", () => new RangeError("from the callback")],
    ["an error with a syscall", systemError],
    ["a ReadUnavailable of the caller's own", () => new ReadUnavailable(systemError())],
    ["a value that is not an Error", () => "from the callback"],
  ];

  it.each(thrown)("%s, rejected", async (_label, make) => {
    const error = make();
    const handed: number[] = [];
    const err = await readProject(writeTmp(twoPlates), {
      onThumbnail: async (i) => {
        handed.push(i);
        throw error;
      },
    }).then(
      () => "resolved",
      (e: unknown) => e,
    );
    expect(err).toBe(error);
    expect(handed).toEqual([1]);
  });

  it.each(thrown)("%s, thrown before any promise", async (_label, make) => {
    const error = make();
    const handed: number[] = [];
    const err = await readProject(writeTmp(twoPlates), {
      onThumbnail: (i) => {
        handed.push(i);
        throw error;
      },
    }).then(
      () => "resolved",
      (e: unknown) => e,
    );
    expect(err).toBe(error);
    expect(handed).toEqual([1]);
  });

  it("an error with a syscall, through readProjectFromReader too", async () => {
    const error = systemError();
    const reader = new MemoryReader(twoPlates);
    const err = await readProjectFromReader(reader, twoPlates.length, {
      onThumbnail: async () => {
        throw error;
      },
    }).then(
      () => "resolved",
      (e: unknown) => e,
    );
    expect(err).toBe(error);
  });
});

describe("ceilings are inclusive", () => {
  it("reads 128 plates from model_settings, pngs and slice_info", async () => {
    const plates = range(128).map((index) => ({ index }));
    expect((await mustRead(build3mf({ plates }))).plates).toHaveLength(128);
    const pngs = Object.fromEntries(range(128).map((i) => [i, png(`p${i}`)]));
    expect((await mustRead(build3mf({ pngs }))).plates).toHaveLength(128);
    const slices = range(128).map((i) => slicedP1S(i));
    const sliced = await mustRead(build3mf({ plates, slices }));
    expect(sliced.plates.every((p) => p.sliced)).toBe(true);
  });

  it("reads 256 filaments on a sliced plate and in the project lists", async () => {
    const filaments = range(256).map((id) => ({ id, type: "PLA", usedG: 1 }));
    const sliced = await mustRead(
      build3mf({ plates: [{ index: 1 }], slices: [slicedP1S(1, { filaments })] }),
    );
    expect(sliced.plates[0]?.filaments).toHaveLength(256);
    const project = await mustRead(
      build3mf({
        plates: [{ index: 1 }],
        project: {
          filament_type: range(256).map(() => "PLA"),
          filament_colour: range(256).map(() => "#FFFFFF"),
        },
      }),
    );
    expect(project.projectFilaments).toHaveLength(256);
  });

  it("reads a config entry of exactly 5 MiB", async () => {
    const xml = modelSettingsXml([{ index: 1 }]);
    const padded = xml.replace(
      "<config>",
      `<config>${" ".repeat(LIMITS.configBytes - xml.length)}`,
    );
    expect(Buffer.byteLength(padded)).toBe(LIMITS.configBytes);
    expect((await mustRead(build3mf({ modelSettings: padded }))).plates).toHaveLength(1);
  });
});

// A reader over an in-memory archive that fails like a filesystem would on
// any read touching bytes [from, to). It goes through the same yauzl path as
// a real file, so the error classification under test is the real one.
class FailingReader extends yauzl.RandomAccessReader {
  private readonly data: Buffer;
  private readonly from: number;
  private readonly to: number;
  private readonly code: string;

  constructor(data: Buffer, from: number, to: number, code: string) {
    super();
    this.data = data;
    this.from = from;
    this.to = to;
    this.code = code;
  }

  private hits(start: number, end: number): boolean {
    return start < this.to && end > this.from;
  }

  private fault(): NodeJS.ErrnoException {
    const err: NodeJS.ErrnoException = new Error(`${this.code}: synthetic, read`);
    err.code = this.code;
    err.syscall = "read";
    return err;
  }

  override _readStreamForRange(start: number, end: number): Readable {
    if (this.hits(start, end)) {
      const stream = new Readable({ read() {} });
      setImmediate(() => stream.destroy(this.fault()));
      return stream;
    }
    return Readable.from([this.data.subarray(start, end)]);
  }

  override read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    callback: (err: Error | null, bytesRead?: number) => void,
  ): void {
    if (this.hits(position, position + length)) {
      setImmediate(() => callback(this.fault()));
      return;
    }
    const n = this.data.copy(buffer, offset, position, position + length);
    setImmediate(() => callback(null, n));
  }
}

class MemoryReader extends FailingReader {
  constructor(data: Buffer) {
    super(data, 0, 0, "EIO");
  }
}

describe("filesystem errors reach the caller as ReadUnavailable (#4)", () => {
  const archive = build3mf({
    plates: [{ index: 1 }, { index: 2 }],
    slices: [slicedP1S(1)],
    pngs: { 1: png("one", 4096), 2: png("two", 4096) },
  });
  // The data of model_settings.config starts right after its local header's
  // name (the fixture writes no local extra field).
  const name = "Metadata/model_settings.config";
  const dataStart = archive.indexOf(name) + name.length;
  const cdOffset = archive.readUInt32LE(archive.length - 22 + 16);

  it.each(["EIO", "EACCES", "ENOENT"])("%s while opening the archive", async (code) => {
    const reader = new FailingReader(archive, cdOffset, archive.length, code);
    await expect(readProjectFromReader(reader, archive.length)).rejects.toBeInstanceOf(
      ReadUnavailable,
    );
  });

  it.each(["EIO", "EACCES", "ENOENT"])("%s in the middle of an entry", async (code) => {
    // The archive opens and the entry's header reads; its data does not, as
    // when a file vanishes from a network mount mid-read.
    const reader = new FailingReader(archive, dataStart + 1, dataStart + 2, code);
    await expect(readProjectFromReader(reader, archive.length)).rejects.toBeInstanceOf(
      ReadUnavailable,
    );
  });

  it("EIO in the middle of a thumbnail, with nothing handed over", async () => {
    const png2 = "Metadata/plate_2.png";
    const pngStart = archive.indexOf(png2) + png2.length;
    const reader = new FailingReader(archive, pngStart + 1, pngStart + 2, "EIO");
    const handed: number[] = [];
    const err = await readProjectFromReader(reader, archive.length, {
      onThumbnail: async (i) => void handed.push(i),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReadUnavailable);
    expect((err as ReadUnavailable).code).toBe("EIO");
    expect(handed).toEqual([]);
  });

  it("keeps the cause's code and never reports the error as damage", async () => {
    const reader = new FailingReader(archive, dataStart + 1, dataStart + 2, "EIO");
    const err = await readProjectFromReader(reader, archive.length).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReadUnavailable);
    expect((err as ReadUnavailable).code).toBe("EIO");
  });

  it("ENOENT for a file that is gone before the read", async () => {
    const file = writeTmp(build3mf({ plates: [{ index: 1 }] }));
    unlinkSync(file);
    const err = await readProject(file).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReadUnavailable);
    expect((err as ReadUnavailable).code).toBe("ENOENT");
  });

  // root reads a mode-000 file anyway, so this real-filesystem case cannot
  // hold there; the injected EACCES rows above cover root runs.
  it.skipIf(process.getuid?.() === 0)("EACCES for a file it may not read", async () => {
    const file = writeTmp(build3mf({ plates: [{ index: 1 }] }));
    chmodSync(file, 0o000);
    try {
      const err = await readProject(file).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ReadUnavailable);
      expect((err as ReadUnavailable).code).toBe("EACCES");
    } finally {
      chmodSync(file, 0o600);
    }
  });

  it("a healthy reader over the same bytes reads the project", async () => {
    const reader = new FailingReader(archive, 0, 0, "EIO");
    const project = await readProjectFromReader(reader, archive.length);
    expect(project?.plates.map((p) => p.sliced)).toEqual([true, false]);
  });
});

describe("projectEntries", () => {
  it("builds the entries the parser reads (fixture self-check)", () => {
    const names = projectEntries({
      plates: [{ index: 1 }],
      slices: [slicedP1S(1)],
      project: P1S_PROJECT,
      pngs: { 1: png("a") },
      smallPngs: { 1: png("b") },
    }).map((e) => e.name);
    expect(names).toEqual([
      "3D/3dmodel.model",
      "Metadata/model_settings.config",
      "Metadata/slice_info.config",
      "Metadata/project_settings.config",
      "Metadata/plate_1.png",
      "Metadata/plate_1_small.png",
    ]);
  });
});
