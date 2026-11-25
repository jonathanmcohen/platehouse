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

  // A plate laid out for a bigger printer (#480). The cube's centre is at
  // (220, 220): inside the P1S's 256 mm bed, but off the A1 mini's 180 mm bed.
  // OrcaSlicer answers -50 for it, and the plate has an object, so the slicer
  // says the plate is too big for the bed. (Orca's --arrange 1 does not help:
  // it arranges on the bed saved in the 3MF, not the loaded printer's.
  // Re-centring a plate onto the user's bed is planned for 0.2.0.) The P1S is
  // the control: the cube fits as designed, so it is sliced.
  test("a plate laid out off a smaller printer's bed says it is too big", async () => {
    const overhang = buildSliceable({
      plates: 1,
      filaments: 1,
      cubeSize: 20,
      at: { x: 220, y: 220 },
    });
    const post = (printer: string) =>
      fetch(`${slicer.base}/v1/slice?printer=${encodeURIComponent(printer)}&plate=1`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: overhang,
      });
    const small = await post("Bambu Lab A1 mini 0.4 nozzle");
    expect(small.status).toBe(200);
    const refused = slicerContract.sliceResult.parse(await small.json());
    expect(refused.status).toBe("failed");
    if (refused.status !== "failed") return;
    expect(refused.code).toBe(-50);
    expect(refused.reason).toBe("bed_too_small");
    expect(refused.detail?.startsWith(TOO_BIG_DETAIL)).toBe(true);

    const control = await post(PRINTERS[0]?.printer ?? "");
    expect(control.status).toBe(200);
    const raw = await control.json();
    const body = slicerContract.sliceResult.parse(raw);
    if (body.status !== "ok") throw new Error(`P1S failed: ${JSON.stringify(raw)}`);
    expect(body.timeSeconds).toBeGreaterThan(0);
    expect(body.weightGrams).toBeGreaterThan(0);
  });

  // A plate where only some objects fit. The A1 mini's bed is 180 mm: the
  // 20 mm cube fits it, the 200 mm slab (10 mm high) cannot. The answer must
  // be a refusal, so a plate where only some objects fit is never estimated
  // as if it were whole. OrcaSlicer 2.5.2 may
  // answer -50 or -52 for it; both map to bed_too_small. Only "ok" fails.
  test("a plate where only some objects fit the bed is refused, never estimated", async () => {
    const partly = buildSliceable({
      plates: 1,
      filaments: 2,
      footprints: [20, 200],
      height: 10,
    });
    const res = await fetch(
      `${slicer.base}/v1/slice?printer=${encodeURIComponent("Bambu Lab A1 mini 0.4 nozzle")}&plate=1`,
      { method: "POST", headers: { "content-type": "application/octet-stream" }, body: partly },
    );
    expect(res.status).toBe(200);
    const body = slicerContract.sliceResult.parse(await res.json());
    expect(body.status).toBe("failed");
    if (body.status !== "failed") return;
    expect(body.reason).toBe("bed_too_small");
    expect([-50, -52]).toContain(body.code);
  });

  // Orca's own refusal, which pins a known return code and its mapping, so a
  // renumbered code fails here (#440). The slab is flat on purpose (300 x 300
  // x 10 mm, well under the print height), so the bed is the only thing it
  // does not fit. OrcaSlicer's command line answers -50 ("the plate has
  // nothing to slice") for it, not -52 ("objects partly outside the bed"):
  // CI run 45323577150. The plate has an object, so the slicer answers
  // bed_too_small with its own sentence ahead of Orca's.
  test("an object larger than the bed is bed_too_small", async () => {
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
