import { describe, expect, it } from "vitest";
import { mapLicense } from "../src/license.js";

// Ported by behaviour from the tests of an earlier Manyfold metadata script
// (the licence cases), in the shape mapLicense returns: {spdx?, footer?, unknown?: true}.

// licence table maps exactly: each CC licence to its CC 4.0 SPDX id, CC0 to CC0-1.0.
const SPDX_ROWS: Array<[string, string]> = [
  ["BY-NC-SA", "CC-BY-NC-SA-4.0"],
  ["BY-NC", "CC-BY-NC-4.0"],
  ["BY-SA", "CC-BY-SA-4.0"],
  ["BY", "CC-BY-4.0"],
  ["BY-NC-ND", "CC-BY-NC-ND-4.0"],
  ["BY-ND", "CC-BY-ND-4.0"],
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

  it("the table has exactly these seven SPDX rows and two footer rows", () => {
    // Every row above maps, and nothing near them does: case, spacing inside
    // the value, a version suffix and the CC- prefix all fall to unknown.
    for (const near of ["by", "By-Nc", "BY NC", "BY-NC-4.0", "CC-BY", "CC0-1.0", "cc0"]) {
      expect(mapLicense(near), near).toStrictEqual({
        footer: `License on MakerWorld: ${near}`,
        unknown: true,
      });
    }
  });

  it("mapLicense: empty or missing gives no license, no footer, not unknown", () => {
    expect(mapLicense("")).toStrictEqual({});
    expect(mapLicense(null)).toStrictEqual({});
    expect(mapLicense(undefined)).toStrictEqual({});
    expect(mapLicense("  ")).toStrictEqual({});
  });

  it("mapLicense: anything else is unknown but kept as a footer", () => {
    expect(mapLicense("Some New Licence")).toStrictEqual({
      footer: "License on MakerWorld: Some New Licence",
      unknown: true,
    });
  });

  it("an unknown value has control and format characters removed and whitespace collapsed", () => {
    expect(mapLicense("A\u0007\u200b  B")).toStrictEqual({
      footer: "License on MakerWorld: A B",
      unknown: true,
    });
  });

  it("an unknown value of only control characters is empty", () => {
    expect(mapLicense("\u0007\u200b")).toStrictEqual({});
  });

  it("an unknown value is capped at 120 code points without splitting a surrogate pair", () => {
    const plain = mapLicense("x".repeat(500));
    expect(plain.footer).toBe(`License on MakerWorld: ${"x".repeat(120)}`);
    const emoji = mapLicense("\u{1F600}".repeat(500));
    const value = (emoji.footer ?? "").slice("License on MakerWorld: ".length);
    expect(Array.from(value)).toHaveLength(120);
    expect(value).toBe("\u{1F600}".repeat(120));
  });

  it("mapLicense: surrounding whitespace is ignored", () => {
    expect(mapLicense(" BY-NC ")).toStrictEqual({ spdx: "CC-BY-NC-4.0" });
    expect(mapLicense("\tMakerWorld Exclusive License\n")).toStrictEqual({
      footer: "License on MakerWorld: MakerWorld Exclusive License",
    });
  });

  it("a value that names an Object.prototype key is unknown, not a crash", () => {
    expect(mapLicense("constructor")).toStrictEqual({
      footer: "License on MakerWorld: constructor",
      unknown: true,
    });
    expect(mapLicense("__proto__")).toStrictEqual({
      footer: "License on MakerWorld: __proto__",
      unknown: true,
    });
  });
});
