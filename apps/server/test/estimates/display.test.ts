// Build plan Task 12, AC-032: next to each set of numbers the page names the
// filament preset that produced them and where it came from. Slicer contract
// v1 reports each slot's preset name (null where the file's own filament was
// kept) but not its source, so the app reads the source from the name by the
// slicer's own rule (apps/slicer/src/profiles.ts pickFilament): it only ever
// picks a "Bambu ..." preset or a "Generic ..." one.
import { describe, expect, test } from "vitest";
import { printerForFile, profileSourceOf } from "../../src/estimates/display.js";
import { STUB_PRINTERS } from "../support/slicer-stub.js";

describe("profileSourceOf", () => {
  test.each([
    ["Bambu PLA Basic @BBL P1S", "bambu"],
    ["Bambu PETG HF @BBL X1C", "bambu"],
    ["Bambu TPU 95A @BBL A1", "bambu"],
    ["Generic PLA @BBL A1", "generic"],
    ["Generic PETG", "generic"],
  ] as const)("%s is %s", (profile, source) => {
    expect(profileSourceOf(profile)).toBe(source);
  });

  test("no preset means the file's own filament was kept", () => {
    expect(profileSourceOf(null)).toBe("file");
    expect(profileSourceOf("")).toBe("file");
  });

  test("a name the slicer would never pick is not claimed for Bambu or Generic", () => {
    expect(profileSourceOf("Bambuddy PLA")).toBe("file");
    expect(profileSourceOf("generic pla")).toBe("file");
    expect(profileSourceOf("Polymaker PLA @BBL P1S")).toBe("file");
  });
});

describe("printerForFile", () => {
  test("a file's printer is the menu printer with its model id and nozzle", () => {
    expect(printerForFile({ printerModelId: "BL-P001", nozzle: 0.4 }, STUB_PRINTERS)?.id).toBe(
      "Bambu Lab X1 Carbon 0.4 nozzle",
    );
    expect(printerForFile({ printerModelId: "C12", nozzle: 0.4 }, STUB_PRINTERS)?.id).toBe(
      "Bambu Lab P1S 0.4 nozzle",
    );
  });

  test("another nozzle, an unknown model or a missing field matches nothing", () => {
    expect(printerForFile({ printerModelId: "C12", nozzle: 0.6 }, STUB_PRINTERS)).toBeUndefined();
    expect(printerForFile({ printerModelId: "Q9", nozzle: 0.4 }, STUB_PRINTERS)).toBeUndefined();
    expect(printerForFile({ printerModelId: null, nozzle: 0.4 }, STUB_PRINTERS)).toBeUndefined();
    expect(printerForFile({ printerModelId: "C12", nozzle: null }, STUB_PRINTERS)).toBeUndefined();
  });

  test("a nozzle read as 0.40000001 from a file still matches 0.4", () => {
    expect(printerForFile({ printerModelId: "C12", nozzle: 0.4000000001 }, STUB_PRINTERS)?.id).toBe(
      "Bambu Lab P1S 0.4 nozzle",
    );
  });
});
