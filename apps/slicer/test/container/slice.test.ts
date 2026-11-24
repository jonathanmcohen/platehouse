// A real slice in the built image (the printer menu, the container's limits,
// and the release workflow's smoke fixture): buildSliceable's two plates, two PLA filaments each, on the P1S
// and on the A1, each with Bambu's own PLA preset for that printer loaded and
// reported in filamentProfiles (the maintainer, 2026-11-08: Bambu's own filaments first).
import { slicerContract } from "@platehouse/slicer-contract";
import { buildSliceable } from "@platehouse/threemf/test/sliceable";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { TOO_BIG_DETAIL } from "../../src/orca.js";
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

  // A plate designed for a bigger printer (#480). The cube's centre is at
  // (220, 220): inside the P1S's 256 mm bed, but off the A1 mini's 180 mm bed.
  // OrcaSlicer's CLI answers -50 for it on the first run. The slicer then runs
  // it once more with --arrange 1, which re-places the plate's objects on the
  // loaded machine's bed (arranging never rotates without --allow-rotations),
  // and the slice succeeds. The P1S is the control: it fits as designed, so
  // it is sliced the first time with no retry.
  test("a plate that overhangs a smaller bed is re-arranged and sliced", async () => {
    const overhang = buildSliceable({
      plates: 1,
      filaments: 1,
      cubeSize: 20,
      at: { x: 220, y: 220 },
    });
    for (const printer of ["Bambu Lab A1 mini 0.4 nozzle", PRINTERS[0]?.printer ?? ""]) {
      const res = await fetch(
        `${slicer.base}/v1/slice?printer=${encodeURIComponent(printer)}&plate=1`,
        { method: "POST", headers: { "content-type": "application/octet-stream" }, body: overhang },
      );
      expect(res.status).toBe(200);
      const raw = await res.json();
      const body = slicerContract.sliceResult.parse(raw);
      if (body.status !== "ok") throw new Error(`${printer} failed: ${JSON.stringify(raw)}`);
      expect(body.printer).toBe(printer);
      expect(body.timeSeconds).toBeGreaterThan(0);
      expect(body.weightGrams).toBeGreaterThan(0);
    }
  });

  // Orca's own refusal, which pins a known return code and its mapping, so a
  // renumbered code fails here (#440). The slab is flat on purpose (300 x 300
  // x 10 mm, well under the print height), so the bed is the only thing it
  // does not fit. OrcaSlicer's command line answers -50 ("the plate has
  // nothing to slice") for it, not -52 ("objects partly outside the bed"):
  // CI run 45323577150. A slab wider than the bed stays -50 even after the
  // --arrange 1 retry (nothing fits to be placed), and the plate has objects,
  // so the slicer answers bed_too_small with its own sentence ahead of Orca's.
  test("an object larger than the bed is bed_too_small after re-arranging", async () => {
    const tooBig = buildSliceable({ plates: 1, filaments: 1, footprint: 300, height: 10 });
    const res = await fetch(
      `${slicer.base}/v1/slice?printer=${encodeURIComponent(PRINTERS[0]?.printer ?? "")}&plate=1`,
      { method: "POST", headers: { "content-type": "application/octet-stream" }, body: tooBig },
    );
    expect(res.status).toBe(200);
    const body = slicerContract.sliceResult.parse(await res.json());
    expect(body.status).toBe("failed");
    if (body.status !== "failed") return;
    expect(body.code).toBe(-50);
    expect(body.reason).toBe("bed_too_small");
    expect(body.detail?.startsWith(TOO_BIG_DETAIL)).toBe(true);
    // Orca's own sentence follows: "The plate has nothing to slice: it is empty,
    // or no object on it is both printable and fully inside the print volume."
    expect(body.detail).toContain("The plate has nothing to slice");
  });
});
