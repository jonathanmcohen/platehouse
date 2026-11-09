// A real slice in the built image (AC-031, AC-035, and the AC-037 smoke
// fixture): buildSliceable's two plates, two PLA filaments each, on the P1S
// and on the A1, each with Bambu's own PLA preset for that printer loaded and
// reported in filamentProfiles (build plan Task 11 Decisions, "Filaments").
import { slicerContract } from "@platehouse/slicer-contract";
import { buildSliceable } from "@platehouse/threemf/test/sliceable";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type RunningSlicer, startSlicer } from "./support/slicer.js";

let slicer: RunningSlicer;
beforeAll(async () => {
  slicer = await startSlicer();
});
afterAll(() => slicer?.stop());

const PRINTERS = [
  { printer: "Bambu Lab P1S 0.4 nozzle", pla: "Bambu PLA Basic @BBL P1S 0.4 nozzle" },
  { printer: "Bambu Lab A1 0.4 nozzle", pla: "Bambu PLA Basic @BBL A1" },
];

describe("slicing in the image", () => {
  const file = buildSliceable({ plates: 2, filaments: 2 });

  test.each(
    PRINTERS.flatMap(({ printer, pla }) => [1, 2].map((plate) => ({ printer, pla, plate }))),
  )(
    "buildSliceable plate $plate slices on $printer with Bambu's PLA preset and reports it",
    async ({ printer, pla, plate }) => {
      const res = await fetch(
        `${slicer.base}/v1/slice?printer=${encodeURIComponent(printer)}&plate=${plate}`,
        { method: "POST", headers: { "content-type": "application/octet-stream" }, body: file },
      );
      expect(res.status).toBe(200);
      const raw = await res.json();
      const body = slicerContract.sliceResult.parse(raw);
      if (body.status !== "ok") throw new Error(`plate ${plate} failed: ${JSON.stringify(raw)}`);
      expect(body.plate).toBe(plate);
      expect(body.printer).toBe(printer);
      expect(body.process).toBe("0.20mm Standard @BBL X1C");
      expect(body.timeSeconds).toBeGreaterThan(0);
      expect(body.weightGrams).toBeGreaterThan(0);
      expect(body.filaments.map((f) => f.slot)).toEqual([1, 2]);
      for (const f of body.filaments) expect(f.grams).toBeGreaterThan(0);
      expect(body.filamentProfiles).toEqual([pla, pla]);
      expect(body.filaments.map((f) => f.type)).toEqual(["PLA", "PLA"]);
      expect(body.peakRssBytes).toBeGreaterThan(0);
    },
  );
});
