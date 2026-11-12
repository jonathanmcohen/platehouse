// AC-023: a crafted or damaged file must not tie up the app. Every row is a
// hostile file built by this suite. Each must come back as null (shown as
// "No Bambu plate data in this file") without throwing, except three kinds:
// an over-long print time only makes the plate count as unsliced, a
// thumbnail over 10 MiB is passed over (for plate_N_small.png when there is
// one, as parser.rb@136fd61 does) while its bytes still count against the
// per-file budget, and a NUL in a text value is dropped from that value, so
// the file reads with clean text.
//
// Each row cites the Bambu Plates issue it carries over:
//   #5  a crafted archive (Zip64 offset, truncation, bad sizes) gave a 500
//   #6  no plate limit
//   #7  no project filament limit
//   #11 thumbnails held in memory without a budget
//   #12 no limit on a sliced plate's filaments, and slice_info claims
// or, for "platehouse #78", this repo's issue: a value the database cannot
// store (a NUL in text, a plate index or filament slot past the 32-bit
// integer columns) failed the save instead of reading as hostile input.
import { describe, expect, it } from "vitest";
import { LIMITS, type Project, readProject } from "../src/index.js";
import {
  build3mf,
  buildZip,
  MiB,
  MODEL_XML,
  modelSettingsXml,
  png,
  projectEntries,
  range,
  seededBytes,
  sliceInfoXml,
  writeTmp,
} from "./support/fixture-builder.js";

const onePlate = { plates: [{ index: 1 }] };
const good = (): Buffer => build3mf({ ...onePlate, pngs: { 1: png("one") } });

/** A config entry whose inflated bytes pass the 5 MiB ceiling by one. */
const overConfig = (): string => {
  const xml = modelSettingsXml([{ index: 1 }]);
  return xml.replace("<config>", `<config>${" ".repeat(LIMITS.configBytes - xml.length + 1)}`);
};

/**
 * One entry's central record says its local header offset is in a Zip64
 * extra field (0xFFFFFFFF), and that field holds offset: 8 bytes for a full
 * offset, fewer for a truncated one.
 */
const zip64Offset = (name: string, offset: Buffer): Buffer =>
  buildZip(
    projectEntries({ ...onePlate, pngs: { 1: png("one") } }).map((e) =>
      e.name === name
        ? {
            ...e,
            localOffset: 0xffffffff,
            centralExtra: Buffer.concat([Buffer.from([0x01, 0x00, offset.length, 0x00]), offset]),
          }
        : e,
    ),
  );

const filaments = (n: number) => range(n).map((id) => ({ id, type: "PLA", usedG: 1 }));

/** The largest value plates.index and the filament slot columns hold (Postgres integer). */
const INT32_MAX = 2147483647;

/** A healthy plate 1, sliced on a P1S. */
const sliced1 = { index: 1, prediction: 60, weight: 1, printerModelId: "C12", nozzle: "0.4" };

interface Row {
  name: string;
  issue: "#5" | "#6" | "#7" | "#11" | "#12" | "platehouse #78";
  /** The LIMITS ceiling this row's file breaks, for a ceiling row. */
  breaks?: keyof typeof LIMITS;
  file: () => Buffer;
  expect: "null" | "unsliced" | "no thumbnail" | "clean";
}

const rows: Row[] = [
  { name: "random bytes", issue: "#5", file: () => seededBytes(64 * 1024), expect: "null" },
  { name: "an empty file", issue: "#5", file: () => Buffer.alloc(0), expect: "null" },
  {
    name: "a truncated zip",
    issue: "#5",
    file: () => {
      const buf = good();
      return buf.subarray(0, Math.floor(buf.length / 2));
    },
    expect: "null",
  },
  {
    name: "an impossible Zip64 end-record offset",
    issue: "#5",
    file: () => build3mf(onePlate, { zip64EndAt: 2n ** 62n }),
    expect: "null",
  },
  {
    name: "a Zip64 end-record offset past the end of the file",
    issue: "#5",
    file: () => build3mf(onePlate, { zip64EndAt: 0xffffffn }),
    expect: "null",
  },
  {
    name: "a truncated Zip64 extra field",
    issue: "#5",
    file: () =>
      buildZip(
        projectEntries(onePlate).map((e) =>
          e.name === "Metadata/model_settings.config"
            ? {
                ...e,
                zip64Size: true,
                centralExtra: Buffer.from([0x01, 0x00, 0x04, 0x00, 0, 0, 0, 0]),
              }
            : e,
        ),
      ),
    expect: "null",
  },
  {
    // parser_test.rb test_impossible_zip64_offset_is_a_damaged_file
    name: "an impossible Zip64 local header offset on an entry",
    issue: "#5",
    file: () => zip64Offset("Metadata/model_settings.config", Buffer.alloc(8, 0xff)),
    expect: "null",
  },
  {
    // parser_test.rb test_truncated_zip64_offset_field_is_a_damaged_file
    name: "a truncated Zip64 local header offset field on an entry",
    issue: "#5",
    file: () => zip64Offset("Metadata/model_settings.config", Buffer.from([0xff, 0xff, 0, 0])),
    expect: "null",
  },
  {
    // parser_test.rb test_impossible_zip64_offset_on_a_thumbnail_gives_nil
    name: "an impossible Zip64 local header offset on a thumbnail",
    issue: "#5",
    file: () => zip64Offset("Metadata/plate_1.png", Buffer.alloc(8, 0xff)),
    expect: "null",
  },
  {
    name: "a central directory past the end of the file",
    issue: "#5",
    file: () => build3mf(onePlate, { cdOffset: 0x7fffffff }),
    expect: "null",
  },
  {
    name: "a local header past the end of the file",
    issue: "#5",
    file: () =>
      buildZip(
        projectEntries(onePlate).map((e) =>
          e.name === "Metadata/model_settings.config" ? { ...e, localOffset: 0x7ffffff0 } : e,
        ),
      ),
    expect: "null",
  },
  {
    name: "a thumbnail's local header past the end of the file",
    issue: "#5",
    file: () =>
      buildZip(
        projectEntries({ ...onePlate, pngs: { 1: png("one") } }).map((e) =>
          e.name === "Metadata/plate_1.png" ? { ...e, localOffset: 0x7ffffff0 } : e,
        ),
      ),
    expect: "null",
  },
  {
    name: "a config entry over 5 MiB",
    issue: "#5",
    breaks: "configBytes",
    file: () => build3mf({ modelSettings: overConfig() }),
    expect: "null",
  },
  {
    // parser_test.rb test_oversized_slice_info_is_ignored keeps the plates;
    // the plan's hostile table makes any config over 5 MiB a damaged file.
    name: "a slice_info.config over 5 MiB",
    issue: "#5",
    breaks: "configBytes",
    file: () =>
      build3mf({
        ...onePlate,
        sliceInfo: sliceInfoXml([]).replace(
          "<config>",
          `<config>${" ".repeat(LIMITS.configBytes + 1)}`,
        ),
      }),
    expect: "null",
  },
  {
    name: "a declared-size lie: declares 1 KiB, inflates past 5 MiB",
    issue: "#5",
    breaks: "configBytes",
    file: () =>
      buildZip(
        projectEntries({ modelSettings: overConfig() }).map((e) =>
          e.name === "Metadata/model_settings.config" ? { ...e, declaredSize: 1024 } : e,
        ),
      ),
    expect: "null",
  },
  {
    name: "a declared-size lie: declares more than it holds",
    issue: "#5",
    file: () =>
      buildZip(
        projectEntries(onePlate).map((e) =>
          e.name === "Metadata/model_settings.config" ? { ...e, declaredSize: 4 * MiB } : e,
        ),
      ),
    expect: "null",
  },
  {
    name: "a stored entry whose sizes disagree",
    issue: "#5",
    file: () =>
      buildZip(
        projectEntries(onePlate).map((e) =>
          e.name === "Metadata/model_settings.config" ? { ...e, method: 0, declaredSize: 10 } : e,
        ),
      ),
    expect: "null",
  },
  {
    name: "129 plates in model_settings.config",
    issue: "#6",
    breaks: "plates",
    file: () => build3mf({ plates: range(129).map((index) => ({ index })) }),
    expect: "null",
  },
  {
    name: "129 plate pngs",
    issue: "#6",
    breaks: "plates",
    file: () => build3mf({ pngs: Object.fromEntries(range(129).map((i) => [i, png(`p${i}`)])) }),
    expect: "null",
  },
  {
    // A 400-digit N is Infinity as a Number; it must not become a plate.
    name: "a plate png name too long to be a safe integer (400 digits)",
    issue: "#6",
    file: () =>
      build3mf({ extra: [{ name: `Metadata/plate_${"9".repeat(400)}.png`, data: png("n") }] }),
    expect: "null",
  },
  {
    // Distinct 400-digit names must not collapse into one plate and slip
    // under the 128-plate ceiling: none of them is a plate at all.
    name: "129 plate png names too long to be safe integers",
    issue: "#6",
    file: () =>
      build3mf({
        extra: range(129).map((i) => ({
          name: `Metadata/plate_${String(i).padStart(400, "9")}.png`,
          data: png(`p${i}`),
        })),
      }),
    expect: "null",
  },
  {
    name: "129 plates in slice_info.config",
    issue: "#6",
    breaks: "plates",
    file: () =>
      build3mf({
        ...onePlate,
        slices: range(129).map((index) => ({ index, prediction: 60, weight: 1 })),
      }),
    expect: "null",
  },
  {
    name: "257 filaments on a sliced plate",
    issue: "#12",
    breaks: "filaments",
    file: () =>
      build3mf({
        ...onePlate,
        slices: [{ index: 1, prediction: 60, weight: 1, filaments: filaments(257) }],
      }),
    expect: "null",
  },
  {
    name: "257 filament types in the project",
    issue: "#7",
    breaks: "filaments",
    file: () => build3mf({ ...onePlate, project: { filament_type: range(257).map(() => "PLA") } }),
    expect: "null",
  },
  {
    name: "257 filament colours in the project",
    issue: "#7",
    breaks: "filaments",
    file: () =>
      build3mf({ ...onePlate, project: { filament_colour: range(257).map(() => "#FFFFFF") } }),
    expect: "null",
  },
  {
    name: "a thumbnail over 10 MiB, with no small one to fall back to",
    issue: "#11",
    breaks: "pngBytes",
    file: () => build3mf({ ...onePlate, pngs: { 1: png("big", LIMITS.pngBytes + 1) } }),
    expect: "no thumbnail",
  },
  {
    name: "thumbnails over the 128 MiB per-file budget",
    issue: "#11",
    breaks: "thumbnailBytesPerFile",
    file: () =>
      build3mf({
        plates: range(13).map((index) => ({ index })),
        pngs: Object.fromEntries(range(13).map((i) => [i, png(`p${i}`, LIMITS.pngBytes)])),
      }),
    expect: "null",
  },
  {
    name: "a print time over ten years",
    issue: "#12",
    breaks: "predictionSeconds",
    file: () =>
      build3mf({
        ...onePlate,
        sliceInfo: sliceInfoXml([
          {
            index: 1,
            prediction: LIMITS.predictionSeconds + 1,
            weight: 1,
            filaments: filaments(1),
          },
        ]),
      }),
    expect: "unsliced",
  },
  {
    name: "a plater_id past the 32-bit range in model_settings.config",
    issue: "platehouse #78",
    file: () => build3mf({ plates: [{ index: 1 }, { index: INT32_MAX + 1 }] }),
    expect: "null",
  },
  {
    name: "a plater_id of 3000000000 in model_settings.config",
    issue: "platehouse #78",
    file: () => build3mf({ plates: [{ index: 3000000000 }] }),
    expect: "null",
  },
  {
    // Past Number.MAX_SAFE_INTEGER too: still a whole number the columns
    // cannot hold, so it is damage like any other, never a skipped plate.
    name: "a plater_id too long to be a safe integer (400 digits)",
    issue: "platehouse #78",
    file: () => build3mf({ plates: [{ index: 1 }, { index: "9".repeat(400) }] }),
    expect: "null",
  },
  {
    name: "a plate png name past the 32-bit range",
    issue: "platehouse #78",
    file: () => build3mf({ pngs: { 1: png("one"), [INT32_MAX + 1]: png("big") } }),
    expect: "null",
  },
  {
    name: "a plate index past the 32-bit range in slice_info.config",
    issue: "platehouse #78",
    file: () => build3mf({ ...onePlate, slices: [sliced1, { ...sliced1, index: INT32_MAX + 1 }] }),
    expect: "null",
  },
  {
    name: "a filament slot past the 32-bit range on a sliced plate",
    issue: "platehouse #78",
    file: () =>
      build3mf({
        ...onePlate,
        slices: [{ ...sliced1, filaments: [{ id: INT32_MAX + 1, type: "PLA", usedG: 1 }] }],
      }),
    expect: "null",
  },
  {
    name: "a filament slot of 3000000000 on a sliced plate",
    issue: "platehouse #78",
    file: () =>
      build3mf({
        ...onePlate,
        slices: [{ ...sliced1, filaments: [{ id: 3000000000, type: "PLA", usedG: 1 }] }],
      }),
    expect: "null",
  },
  {
    name: "a NUL in a plate name",
    issue: "platehouse #78",
    file: () =>
      build3mf({
        plates: [
          { index: 1, name: "Ba\u0000se" },
          { index: 2, name: "\u0000" },
        ],
      }),
    expect: "clean",
  },
  {
    // The same NUL written as character references: whatever the XML
    // parser makes of them, no NUL may come out.
    name: "a NUL in a plate name as &#0; and &#x0;",
    issue: "platehouse #78",
    file: () =>
      build3mf({
        modelSettings: modelSettingsXml([
          { index: 1, name: "Ba(DEC)se" },
          { index: 2, name: "(HEX)" },
        ])
          .replace("(DEC)", "&#0;")
          .replace("(HEX)", "&#x0;"),
      }),
    expect: "clean",
  },
  {
    name: "a NUL in a sliced filament type and the printer model id",
    issue: "platehouse #78",
    file: () =>
      build3mf({
        ...onePlate,
        slices: [
          {
            ...sliced1,
            printerModelId: "C1\u00002",
            filaments: [{ id: 1, type: "P\u0000LA", usedG: 1 }],
          },
        ],
      }),
    expect: "clean",
  },
  {
    name: "a NUL in the project filament types and process name",
    issue: "platehouse #78",
    file: () =>
      build3mf({
        ...onePlate,
        project: {
          filament_type: ["PL\u0000A", "\u0000"],
          print_settings_id: ["0.20mm\u0000 Standard"],
        },
      }),
    expect: "clean",
  },
  {
    name: "a NUL in the MakerWorld fields of 3D/3dmodel.model",
    issue: "platehouse #78",
    file: () =>
      build3mf({
        ...onePlate,
        model: MODEL_XML.replace("Synthetic Designer", "Synthetic\u0000 Designer"),
      }),
    expect: "clean",
  },
];

/** Every string anywhere in a value, so a test can look for a NUL in all of them. */
function allStrings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(allStrings);
  if (typeof v === "object" && v !== null) return Object.values(v).flatMap(allStrings);
  return [];
}

describe("hostile files (AC-023)", () => {
  it.each(rows)("$name ($issue)", async (row) => {
    const file = writeTmp(row.file());
    const handed: number[] = [];
    let result: Project | null | undefined;
    await expect(
      (async () => {
        result = await readProject(file, { onThumbnail: async (i) => void handed.push(i) });
      })(),
    ).resolves.toBeUndefined();
    if (row.expect === "null") {
      expect(result).toBeNull();
      expect(handed).toEqual([]);
    } else if (row.expect === "clean") {
      expect(result).not.toBeNull();
      expect(result?.plates.length).toBeGreaterThan(0);
      expect(allStrings(result).filter((s) => s.includes("\u0000"))).toEqual([]);
    } else if (row.expect === "no thumbnail") {
      expect(result?.plates.map((p) => p.index)).toEqual([1]);
      expect(handed).toEqual([]);
    } else {
      expect(result).not.toBeNull();
      expect(result?.plates[0]?.sliced).toBe(false);
      expect(result?.plates[0]?.predictionSeconds).toBeUndefined();
      expect(result?.slicedFor).toBeUndefined();
    }
  });

  it("the healthy control file for the rows above reads", async () => {
    const project = await readProject(writeTmp(good()));
    expect(project?.plates).toHaveLength(1);
  });

  // Each ceiling row names the LIMITS key it breaks, and the set of those
  // keys must equal the keys of LIMITS: a ceiling added, renamed or dropped
  // without a hostile row that names it fails here (#19). The row's own case
  // above is what shows its file is refused, and the inclusive-ceiling tests
  // in parse.test.ts show a file at each ceiling still reads.
  it("every LIMITS ceiling has a hostile row", () => {
    const broken = new Set(rows.flatMap((r) => (r.breaks === undefined ? [] : [r.breaks])));
    expect([...broken].sort()).toEqual(Object.keys(LIMITS).sort());
  });
});
