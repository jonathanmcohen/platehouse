import { describe, expect, it } from "vitest";
import { mapLicense } from "../src/license.js";

// Ported by behaviour from automation Manyfold/makerworld-metadata
// test/metadata.test.mjs at 1ce8c57 (the licence cases), in the shape the
// build plan's Task 7 interface gives: {spdx?, footer?, unknown?: true}.

// licence table maps exactly (plan Task 7 and requirements AC-022).
const SPDX_ROWS: Array<[string, string]> = [
  ["BY-NC-SA", "CC-BY-NC-SA-4.0"],
  ["BY-NC", "CC-BY-NC-4.0"],
  ["BY-SA", "CC-BY-SA-4.0"],
  ["BY", "CC-BY-4.0"],
  ["BY-NC-ND", "CC-BY-NC-ND-4.0"],
  ["CC0", "CC0-1.0"],
];

const FOOTER_ROWS: Array<[string, string]> = [
  ["Standard Digital File License", "License on MakerWorld: Standard Digital File License"],
  ["MakerWorld Exclusive License", "License on MakerWorld: MakerWorld Exclusive License"],
];

describe("mapLicense", () => {
  it.each(SPDX_ROWS)("licence table maps exactly: mapLicense(%j)", (value, spdx) => {
    expect(mapLicense(value)).toStrictEqual({ spdx });
  });

  it.each(FOOTER_ROWS)("footer licences set no spdx: mapLicense(%j)", (value, footer) => {
    const mapped = mapLicense(value);
    expect(mapped).toStrictEqual({ footer });
    expect(mapped).not.toHaveProperty("spdx");
  });

  it("the table has exactly these six SPDX rows and two footer rows", () => {
    // Every row above maps, and nothing near them does: case, spacing inside
    // the value, a version suffix and the CC- prefix all fall to unknown.
    for (const near of ["by", "By-Nc", "BY NC", "BY-NC-4.0", "CC-BY", "CC0-1.0", "cc0"]) {
      expect(mapLicense(near), near).toStrictEqual({ unknown: true });
    }
  });

  it("mapLicense: empty or missing gives no license, no footer, not unknown", () => {
    expect(mapLicense("")).toStrictEqual({});
    expect(mapLicense(null)).toStrictEqual({});
    expect(mapLicense(undefined)).toStrictEqual({});
    expect(mapLicense("  ")).toStrictEqual({});
  });

  it("mapLicense: anything else is unknown", () => {
    expect(mapLicense("Something Else")).toStrictEqual({ unknown: true });
  });

  it("mapLicense: surrounding whitespace is ignored", () => {
    expect(mapLicense(" BY-NC ")).toStrictEqual({ spdx: "CC-BY-NC-4.0" });
    expect(mapLicense("\tMakerWorld Exclusive License\n")).toStrictEqual({
      footer: "License on MakerWorld: MakerWorld Exclusive License",
    });
  });

  it("a value that names an Object.prototype key is unknown, not a crash", () => {
    expect(mapLicense("constructor")).toStrictEqual({ unknown: true });
    expect(mapLicense("__proto__")).toStrictEqual({ unknown: true });
  });
});
