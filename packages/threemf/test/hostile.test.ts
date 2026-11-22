// A crafted or damaged file must not tie up the app. Every row is a
// hostile file built by this suite. Each must come back as null (shown as
// "No Bambu plate data in this file") without throwing, except three kinds:
// an over-long print time only makes the plate count as unsliced, a
// thumbnail over 10 MiB is passed over (for plate_N_small.png when there is
// one, as the earlier parser did) while its bytes still count against the
// per-file budget, and a NUL in a text value is dropped from that value, so
// the file reads with clean text.
//
// Each row names the kind of hostile file it covers, each a hole found in the
// earlier parser this one was ported from:
//   crafted archive       a Zip64 offset, a truncation or bad sizes gave a 500
//   plate count           no plate limit
//   project filaments     no project filament limit
//   thumbnail bytes       thumbnails held in memory without a budget
//   slice data            no limit on a sliced plate's filaments, and slice_info claims
// or, for "database value (#78)", this repo's issue #78: a value the database cannot
// store (a NUL in text, a plate index or filament slot past the 32-bit
// integer columns) failed the save instead of reading as hostile input.
import { describe, expect, it } from "vitest";
import { LIMITS, type Project, readProject } from "../src/index.js";
import { MAX_ZIP_ENTRIES } from "../src/limits.js";
import {
  build3mf,
  build3mfWithEntries,
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

/**
 * Every ceiling that refuses a file: the LIMITS keys, and MAX_ZIP_ENTRIES,
 * which lives beside LIMITS rather than in it. The completeness check below
 * reads this list, so a standalone ceiling is covered too.
 */
const CEILINGS = [...Object.keys(LIMITS), "MAX_ZIP_ENTRIES"] as const;
type Ceiling = keyof typeof LIMITS | "MAX_ZIP_ENTRIES";

interface Row {
  name: string;
  kind:
    | "crafted archive"
    | "plate count"
    | "project filaments"
    | "thumbnail bytes"
    | "slice data"
    | "database value (#78)";
  /** The ceiling this row's file breaks, for a ceiling row: a LIMITS key or a standalone one. */
  breaks?: Ceiling;
  file: () => Buffer;
  expect: "null" | "unsliced" | "no thumbnail" | "clean";
  /** A file that takes seconds to build and list; see SLOW_ROW_MS. */
  slow?: boolean;
}

const rows: Row[] = [
  {
    name: "random bytes",
    kind: "crafted archive",
    file: () => seededBytes(64 * 1024),
    expect: "null",
  },
  { name: "an empty file", kind: "crafted archive", file: () => Buffer.alloc(0), expect: "null" },
  {
    name: "a truncated zip",
    kind: "crafted archive",
    file: () => {
      const buf = good();
      return buf.subarray(0, Math.floor(buf.length / 2));
    },
    expect: "null",
  },
  {
    name: "an impossible Zip64 end-record offset",
    kind: "crafted archive",
    file: () => build3mf(onePlate, { zip64EndAt: 2n ** 62n }),
    expect: "null",
  },
  {
    name: "a Zip64 end-record offset past the end of the file",
    kind: "crafted archive",
    file: () => build3mf(onePlate, { zip64EndAt: 0xffffffn }),
    expect: "null",
  },
  {
    // A central directory listing more entries than any Bambu project has.
    // Every entry is otherwise sound and the project in it reads, so only
    // the entry ceiling refuses it (parse.test.ts reads one at the ceiling).
    name: "one entry past the 100000-entry ceiling",
    kind: "crafted archive",
    breaks: "MAX_ZIP_ENTRIES",
    slow: true,
    file: () => build3mfWithEntries({ ...onePlate, pngs: { 1: png("one") } }, MAX_ZIP_ENTRIES + 1),
    expect: "null",
  },
  {
    name: "a truncated Zip64 extra field",
    kind: "crafted archive",
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
    name: "an impossible Zip64 local header offset on an entry",
    kind: "crafted archive",
    file: () => zip64Offset("Metadata/model_settings.config", Buffer.alloc(8, 0xff)),
    expect: "null",
  },
  {
    name: "a truncated Zip64 local header offset field on an entry",
    kind: "crafted archive",
    file: () => zip64Offset("Metadata/model_settings.config", Buffer.from([0xff, 0xff, 0, 0])),
    expect: "null",
  },
  {
    name: "an impossible Zip64 local header offset on a thumbnail",
    kind: "crafted archive",
    file: () => zip64Offset("Metadata/plate_1.png", Buffer.alloc(8, 0xff)),
    expect: "null",
  },
  {
    name: "a central directory past the end of the file",
    kind: "crafted archive",
    file: () => build3mf(onePlate, { cdOffset: 0x7fffffff }),
    expect: "null",
  },
  {
    name: "a local header past the end of the file",
    kind: "crafted archive",
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
    kind: "crafted archive",
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
    kind: "crafted archive",
    breaks: "configBytes",
    file: () => build3mf({ modelSettings: overConfig() }),
    expect: "null",
  },
  {
    // The earlier parser kept the plates here; Platehouse makes any config
    // entry over 5 MiB a damaged file.
    name: "a slice_info.config over 5 MiB",
    kind: "crafted archive",
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
    kind: "crafted archive",
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
    kind: "crafted archive",
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
    kind: "crafted archive",
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
    kind: "plate count",
    breaks: "plates",
    file: () => build3mf({ plates: range(129).map((index) => ({ index })) }),
    expect: "null",
  },
  {
    name: "129 plate pngs",
    kind: "plate count",
    breaks: "plates",
    file: () => build3mf({ pngs: Object.fromEntries(range(129).map((i) => [i, png(`p${i}`)])) }),
    expect: "null",
  },
  {
    // A 400-digit N is Infinity as a Number; it must not become a plate.
    name: "a plate png name too long to be a safe integer (400 digits)",
    kind: "plate count",
    file: () =>
      build3mf({ extra: [{ name: `Metadata/plate_${"9".repeat(400)}.png`, data: png("n") }] }),
    expect: "null",
  },
  {
    // Distinct 400-digit names must not collapse into one plate and slip
    // under the 128-plate ceiling: none of them is a plate at all.
    name: "129 plate png names too long to be safe integers",
    kind: "plate count",
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
    kind: "plate count",
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
    kind: "slice data",
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
    kind: "project filaments",
    breaks: "filaments",
    file: () => build3mf({ ...onePlate, project: { filament_type: range(257).map(() => "PLA") } }),
    expect: "null",
  },
  {
    name: "257 filament colours in the project",
    kind: "project filaments",
    breaks: "filaments",
    file: () =>
      build3mf({ ...onePlate, project: { filament_colour: range(257).map(() => "#FFFFFF") } }),
    expect: "null",
  },
  {
    name: "a thumbnail over 10 MiB, with no small one to fall back to",
    kind: "thumbnail bytes",
    breaks: "pngBytes",
    file: () => build3mf({ ...onePlate, pngs: { 1: png("big", LIMITS.pngBytes + 1) } }),
    expect: "no thumbnail",
  },
  {
    name: "thumbnails over the 128 MiB per-file budget",
    kind: "thumbnail bytes",
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
    kind: "slice data",
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
    kind: "database value (#78)",
    file: () => build3mf({ plates: [{ index: 1 }, { index: INT32_MAX + 1 }] }),
    expect: "null",
  },
  {
    name: "a plater_id of 3000000000 in model_settings.config",
    kind: "database value (#78)",
    file: () => build3mf({ plates: [{ index: 3000000000 }] }),
    expect: "null",
  },
  {
    // Past Number.MAX_SAFE_INTEGER too: still a whole number the columns
    // cannot hold, so it is damage like any other, never a skipped plate.
    name: "a plater_id too long to be a safe integer (400 digits)",
    kind: "database value (#78)",
    file: () => build3mf({ plates: [{ index: 1 }, { index: "9".repeat(400) }] }),
    expect: "null",
  },
  {
    name: "a plate png name past the 32-bit range",
    kind: "database value (#78)",
    file: () => build3mf({ pngs: { 1: png("one"), [INT32_MAX + 1]: png("big") } }),
    expect: "null",
  },
  {
    name: "a plate index past the 32-bit range in slice_info.config",
    kind: "database value (#78)",
    file: () => build3mf({ ...onePlate, slices: [sliced1, { ...sliced1, index: INT32_MAX + 1 }] }),
    expect: "null",
  },
  {
    name: "a filament slot past the 32-bit range on a sliced plate",
    kind: "database value (#78)",
    file: () =>
      build3mf({
        ...onePlate,
        slices: [{ ...sliced1, filaments: [{ id: INT32_MAX + 1, type: "PLA", usedG: 1 }] }],
      }),
    expect: "null",
  },
  {
    name: "a filament slot of 3000000000 on a sliced plate",
    kind: "database value (#78)",
    file: () =>
      build3mf({
        ...onePlate,
        slices: [{ ...sliced1, filaments: [{ id: 3000000000, type: "PLA", usedG: 1 }] }],
      }),
    expect: "null",
  },
  {
    name: "a NUL in a plate name",
    kind: "database value (#78)",
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
    kind: "database value (#78)",
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
    kind: "database value (#78)",
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
    kind: "database value (#78)",
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
    kind: "database value (#78)",
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

// A row whose file is large to build and list (the 100001-entry archive takes
// about 2 s alone) gets a longer timeout, so it does not time out when the
// whole suite runs in parallel; every other row keeps the default, so a row
// that ties up the reader still fails there.
const SLOW_ROW_MS = 60_000;

async function checkRow(row: Row): Promise<void> {
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
}

describe("hostile files", () => {
  it.each(rows.filter((r) => !r.slow))("$name ($kind)", checkRow);
  it.each(rows.filter((r) => r.slow))("$name ($kind)", checkRow, SLOW_ROW_MS);

  it("the healthy control file for the rows above reads", async () => {
    const project = await readProject(writeTmp(good()));
    expect(project?.plates).toHaveLength(1);
  });

  // Each ceiling row names the ceiling it breaks, and the set of those names
  // must equal CEILINGS, the keys of LIMITS plus the standalone
  // MAX_ZIP_ENTRIES: a LIMITS ceiling added, renamed or dropped
  // without a hostile row that names it fails here (#19). The row's own case
  // above is what shows its file is refused, and the inclusive-ceiling tests
  // in parse.test.ts show a file at each ceiling still reads.
  it("every ceiling, LIMITS and MAX_ZIP_ENTRIES, has a hostile row", () => {
    const broken = new Set(rows.flatMap((r) => (r.breaks === undefined ? [] : [r.breaks])));
    expect([...broken].sort()).toEqual([...CEILINGS].sort());
  });
});
