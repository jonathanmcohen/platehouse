// A model's name at ingest: the .3mf's title when it has one, else a cleaned
// file name, cut at the API's 500-character name limit. Every name here is
// made up for the test.
import { describe, expect, test } from "vitest";
import {
  cutName,
  fileStems,
  MAX_MODEL_NAME_LENGTH,
  nameFromFile,
  newModelName,
} from "../../src/ingest/names.js";

/** Non-ASCII from code points, so this file stays ASCII. */
const U_UMLAUT = String.fromCodePoint(0xdc);
const E_ACUTE = String.fromCodePoint(0xe9);
const NIHON = String.fromCodePoint(0x65e5, 0x672c);
/** U+1F529, two UTF-16 code units. */
const NUT_BOLT = String.fromCodePoint(0x1f529);

describe("nameFromFile", () => {
  test.each([
    ["Desk_cable_clip_PETG.3mf", "Desk cable clip PETG"],
    ["Spool_Holder_[Wall].3mf", "Spool Holder [Wall]"],
    ["Bambu_A1_Purge_Bucket_V2.1_for_PLA.3mf", "Bambu A1 Purge Bucket V2.1 for PLA"],
    ["Hook--large.stl", "Hook large"],
    ["Box---lid--v3.step", "Box lid v3"],
    ["T-Rex skull.scad", "T-Rex skull"],
    ["Drawer - Divider.3mf", "Drawer - Divider"],
    ["folder/sub\\Knob__round.STP", "Knob round"],
    ["  spaced__out .3mf", "spaced out"],
    ["MiXeD_CaSe.STL", "MiXeD CaSe"],
  ])("%s -> %s", (file, name) => {
    expect(nameFromFile(file)).toBe(name);
  });

  test("keeps a dot that is not a supported extension", () => {
    expect(nameFromFile("Clip_v1.4")).toBe("Clip v1.4");
    expect(nameFromFile("Clip_v1.4.gcode.3mf")).toBe("Clip v1.4.gcode");
  });

  test("a name of only underscores and dashes falls back to the raw stem", () => {
    expect(nameFromFile("___.3mf")).toBe("___");
    expect(nameFromFile("--.stl")).toBe("--");
  });

  test("a file name with no stem keeps the whole name", () => {
    expect(nameFromFile(".3mf")).toBe(".3mf");
  });

  test("a very long file name is cut at the limit", () => {
    const name = nameFromFile(`${"a_".repeat(400)}.3mf`);
    expect(name.length).toBeLessThanOrEqual(MAX_MODEL_NAME_LENGTH);
    expect(name.startsWith("a a a")).toBe(true);
  });
});

describe("cutName", () => {
  test("collapses whitespace and trims", () => {
    expect(cutName("  Kit \t one\n two  ")).toBe("Kit one two");
  });

  test("keeps odd characters as they are", () => {
    const title = `Clip | v2 & "Pro" <M3> / 50% - ${U_UMLAUT} caf${E_ACUTE} ${NIHON} ${NUT_BOLT}`;
    expect(cutName(title)).toBe(title);
  });

  test("blank is null", () => {
    expect(cutName("   ")).toBeNull();
    expect(cutName("")).toBeNull();
    expect(cutName(null)).toBeNull();
    expect(cutName(undefined)).toBeNull();
  });

  test("the API limit is the rename route's 500", () => {
    expect(MAX_MODEL_NAME_LENGTH).toBe(500);
  });

  test("a title over the limit is cut to exactly the limit, trailing space trimmed", () => {
    const cut = cutName(`${"x".repeat(499)} yyyy`);
    expect(cut).toBe("x".repeat(499));
    expect(cutName("z".repeat(2000))).toBe("z".repeat(500));
  });

  test("a cut never splits a character made of two UTF-16 units", () => {
    const cut = cutName(`${"x".repeat(499)}${NUT_BOLT}${NUT_BOLT}`);
    expect(cut).toBe("x".repeat(499));
    expect(cut?.length).toBe(499);
  });
});

describe("newModelName", () => {
  test("a title wins over the file name", () => {
    expect(newModelName("Desk_clip.3mf", "Desk Clip | Snap Fit")).toEqual({
      name: "Desk Clip | Snap Fit",
      source: "title",
    });
  });

  test("no title, or a blank one, uses the cleaned file name", () => {
    expect(newModelName("Desk_clip.3mf", null)).toEqual({ name: "Desk clip", source: "file" });
    expect(newModelName("Desk_clip.3mf", "   ")).toEqual({ name: "Desk clip", source: "file" });
  });

  test("a very long title is cut at the limit", () => {
    const { name, source } = newModelName("a.3mf", "T".repeat(800));
    expect(source).toBe("title");
    expect(name).toBe("T".repeat(500));
  });
});

describe("fileStems", () => {
  test("holds the raw stem and the cleaned name of every file", () => {
    expect(fileStems(["Desk_clip.3mf", "Desk_clip_base.stl"])).toEqual(
      new Set(["Desk_clip", "Desk clip", "Desk_clip_base", "Desk clip base"]),
    );
  });
});
