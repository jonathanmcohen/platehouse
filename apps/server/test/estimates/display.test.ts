// Build plan Task 12, AC-032: next to each set of numbers the page names the
// filament preset that produced them and where it came from. Slicer contract
// v1 reports each slot's preset name (null where the file's own filament was
// kept) but not its source, so the app reads the source from the name by the
// slicer's own rule (apps/slicer/src/profiles.ts pickFilament): it only ever
// picks a "Bambu ..." preset or a "Generic ..." one.
import { describe, expect, test } from "vitest";
import {
  filePrinterLabel,
  OTHER_PRINTER_LABEL,
  printerForFile,
  printerName,
  profileSourceOf,
} from "../../src/estimates/display.js";
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

// Issue #198: Bambu's own numbers were labelled with the file's raw printer
// code ("Sliced for C12", "Sliced for BL-P001") when no printer in the
// slicer's menu matched the file's printer and nozzle, or the menu was empty
// because the slicer could not be reached. The label is the menu printer's
// name when one matches, else plain words.
describe("filePrinterLabel", () => {
  test("a menu printer that matches the file's printer gives its name", () => {
    const printer = printerForFile({ printerModelId: "BL-P001", nozzle: 0.4 }, STUB_PRINTERS);
    expect(filePrinterLabel(printer)).toBe("Bambu Lab X1 Carbon 0.4 nozzle");
  });

  test("no menu printer, or an empty menu, gives plain words, never the raw code", () => {
    expect(OTHER_PRINTER_LABEL).toBe("another printer");
    const cases: Array<
      [{ printerModelId: string | null; nozzle: number | null }, typeof STUB_PRINTERS]
    > = [
      [{ printerModelId: "C12", nozzle: 0.2 }, STUB_PRINTERS],
      [{ printerModelId: "Q9", nozzle: 0.4 }, STUB_PRINTERS],
      [{ printerModelId: "C12", nozzle: 0.4 }, []],
      [{ printerModelId: null, nozzle: null }, STUB_PRINTERS],
    ];
    for (const [file, menu] of cases) {
      expect(filePrinterLabel(printerForFile(file, menu))).toBe(OTHER_PRINTER_LABEL);
    }
  });
});

// The maintainer, 2026-11-19: the printer menu showed only "0.4 mm nozzle" once closed,
// so the chosen printer could not be told apart. Every place that names a
// printer names it in full: the model and the nozzle.
describe("printerName", () => {
  test("a menu printer is named by its model and nozzle", () => {
    expect(printerName("Bambu Lab P1S 0.4 nozzle", STUB_PRINTERS)).toBe(
      "Bambu Lab P1S, 0.4 mm nozzle",
    );
    expect(printerName("Bambu Lab X1 Carbon 0.4 nozzle", STUB_PRINTERS)).toBe(
      "Bambu Lab X1 Carbon, 0.4 mm nozzle",
    );
  });

  test("without the menu (the slicer is down) the name is read from the preset name", () => {
    expect(printerName("Bambu Lab A1 mini 0.4 nozzle", [])).toBe(
      "Bambu Lab A1 mini, 0.4 mm nozzle",
    );
    expect(printerName("Bambu Lab H2D 0.6 nozzle", STUB_PRINTERS)).toBe(
      "Bambu Lab H2D, 0.6 mm nozzle",
    );
  });

  test("a preset name of any other shape is shown as it is", () => {
    expect(printerName("Some Printer", [])).toBe("Some Printer");
    expect(printerName("nozzle", [])).toBe("nozzle");
  });
});
