// AC-023: a crafted or damaged file must not tie up the app. Every row is a
// hostile file built by this suite. Each must come back as null (shown as
// "No Bambu plate data in this file") without throwing, except the
// over-long print time, which only makes the plate count as unsliced.
//
// Each row cites the Bambu Plates issue it carries over:
//   #5  a crafted archive (Zip64 offset, truncation, bad sizes) gave a 500
//   #6  no plate limit
//   #7  no project filament limit
//   #11 thumbnails held in memory without a budget
//   #12 no limit on a sliced plate's filaments, and slice_info claims
import { describe, expect, it } from "vitest";
import { LIMITS, type Project, readProject } from "../src/index.js";
import {
  build3mf,
  buildZip,
  MiB,
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

const filaments = (n: number) => range(n).map((id) => ({ id, type: "PLA", usedG: 1 }));

interface Row {
  name: string;
  issue: "#5" | "#6" | "#7" | "#11" | "#12";
  file: () => Buffer;
  expect: "null" | "unsliced";
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
    name: "a config entry over 5 MiB",
    issue: "#5",
    file: () => build3mf({ modelSettings: overConfig() }),
    expect: "null",
  },
  {
    name: "a declared-size lie: declares 1 KiB, inflates past 5 MiB",
    issue: "#5",
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
    file: () => build3mf({ plates: range(129).map((index) => ({ index })) }),
    expect: "null",
  },
  {
    name: "129 plate pngs",
    issue: "#6",
    file: () => build3mf({ pngs: Object.fromEntries(range(129).map((i) => [i, png(`p${i}`)])) }),
    expect: "null",
  },
  {
    name: "129 plates in slice_info.config",
    issue: "#6",
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
    file: () => build3mf({ ...onePlate, project: { filament_type: range(257).map(() => "PLA") } }),
    expect: "null",
  },
  {
    name: "257 filament colours in the project",
    issue: "#7",
    file: () =>
      build3mf({ ...onePlate, project: { filament_colour: range(257).map(() => "#FFFFFF") } }),
    expect: "null",
  },
  {
    name: "a thumbnail over 10 MiB",
    issue: "#11",
    file: () => build3mf({ ...onePlate, pngs: { 1: png("big", LIMITS.pngBytes + 1) } }),
    expect: "null",
  },
  {
    name: "thumbnails over the 128 MiB per-file budget",
    issue: "#11",
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
];

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

  it("every LIMITS ceiling has a hostile row", () => {
    const names = rows.map((r) => r.name).join("\n");
    expect(names).toMatch(/over 5 MiB/);
    expect(names).toMatch(/over 10 MiB/);
    expect(names).toMatch(/129 plates/);
    expect(names).toMatch(/257 filament/);
    expect(names).toMatch(/128 MiB/);
    expect(names).toMatch(/over ten years/);
    expect(Object.keys(LIMITS)).toHaveLength(6);
  });
});
