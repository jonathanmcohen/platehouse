// A real slice in the built image (AC-031, AC-035, and the AC-037 smoke
// fixture): buildSliceable's two plates, two filaments each, on the P1S.
import { slicerContract } from "@platehouse/slicer-contract";
import { buildSliceable } from "@platehouse/threemf/test/sliceable";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type RunningSlicer, startSlicer } from "./support/slicer.js";

let slicer: RunningSlicer;
beforeAll(async () => {
  slicer = await startSlicer();
});
afterAll(() => slicer?.stop());

const P1S = "Bambu Lab P1S 0.4 nozzle";

describe("slicing in the image", () => {
  const file = buildSliceable({ plates: 2, filaments: 2 });

  test.each([1, 2])(
    "buildSliceable plate %i slices on P1S with time and weight above zero",
    async (plate) => {
      const res = await fetch(
        `${slicer.base}/v1/slice?printer=${encodeURIComponent(P1S)}&plate=${plate}`,
        { method: "POST", headers: { "content-type": "application/octet-stream" }, body: file },
      );
      expect(res.status).toBe(200);
      const raw = await res.json();
      const body = slicerContract.sliceResult.parse(raw);
      if (body.status !== "ok") throw new Error(`plate ${plate} failed: ${JSON.stringify(raw)}`);
      expect(body.plate).toBe(plate);
      expect(body.printer).toBe(P1S);
      expect(body.process).toBe("0.20mm Standard @BBL X1C");
      expect(body.timeSeconds).toBeGreaterThan(0);
      expect(body.weightGrams).toBeGreaterThan(0);
      expect(body.filaments.map((f) => f.slot)).toEqual([1, 2]);
      for (const f of body.filaments) expect(f.grams).toBeGreaterThan(0);
      expect(body.filamentProfiles.every((p) => typeof p === "string")).toBe(true);
      expect(body.peakRssBytes).toBeGreaterThan(0);
    },
  );
});
