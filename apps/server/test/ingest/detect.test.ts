// Build plan Task 8, AC-020 and AC-024: which uploads are a supported file.
// The name picks the kind; the first bytes must agree with it.
import { describe, expect, test } from "vitest";
import { detectKind, FIRST_BYTES } from "../../src/ingest/detect.js";

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
const asciiStl = Buffer.from("solid cube\n facet normal 0 0 1\n", "ascii");
const binaryStl = (() => {
  const b = Buffer.alloc(84 + 50);
  b.write("solid looking header of a binary stl", 0, "ascii");
  b.writeUInt32LE(1, 80);
  return b;
})();
const step = Buffer.from("ISO-10303-21;\nHEADER;\n", "ascii");
const scad = Buffer.from("cube([10, 10, 10]);\n", "utf8");

describe("detectKind", () => {
  test.each([
    ["Model.3mf", ZIP, "3mf"],
    ["MODEL.3MF", ZIP, "3mf"],
    ["part.stl", asciiStl, "stl"],
    ["part.STL", binaryStl, "stl"],
    ["bracket.step", step, "step"],
    ["bracket.stp", step, "step"],
    ["bracket.STP", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), step]), "step"],
    ["box.scad", scad, "scad"],
    ["box.scad", Buffer.from("// caf\u00e9 \u2013 a comment\ncube(1);\n", "utf8"), "scad"],
    ["dir/sub dir/Plate one.3mf", ZIP, "3mf"],
  ])("%s is %s", (name, bytes, kind) => {
    expect(detectKind(name, bytes)).toBe(kind);
  });

  test.each([
    ["an unsupported extension", "model.obj", ZIP],
    ["G-code", "plate.gcode", Buffer.from("; G-code\n")],
    ["no extension", "model", ZIP],
    ["a dotfile named like an extension", ".3mf", ZIP],
    ["an extension only in the middle", "model.3mf.zip", ZIP],
    ["a .3mf that is not a zip", "model.3mf", Buffer.from("not a zip at all")],
    ["an empty .3mf", "model.3mf", Buffer.alloc(0)],
    ["a .scad with a NUL byte", "box.scad", Buffer.from([0x63, 0x00, 0x75])],
    ["a .scad that is not UTF-8", "box.scad", Buffer.from([0x63, 0xff, 0xfe, 0x75])],
    ["an empty .stl", "part.stl", Buffer.alloc(0)],
    ["a binary .stl shorter than its header and count", "part.stl", Buffer.alloc(83)],
    ["a .step without the ISO-10303-21 header", "part.step", Buffer.from("HEADER;\n")],
    ["a .stp that is a zip", "part.stp", ZIP],
  ])("refuses %s", (_label, name, bytes) => {
    expect(detectKind(name, bytes)).toBeNull();
  });

  test("a .scad cut mid-character at the end of the sample is still text", () => {
    const text = Buffer.from(`${"x".repeat(FIRST_BYTES - 1)}\u00e9`, "utf8");
    expect(detectKind("box.scad", text.subarray(0, FIRST_BYTES))).toBe("scad");
  });
});
