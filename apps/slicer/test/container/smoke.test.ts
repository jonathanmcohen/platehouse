// The smoke slice the slicer-image workflow runs before it publishes: every plate of
// buildSliceable({plates: 2, filaments: 2}) and buildSliceable({plates: 3,
// filaments: 4}) on the P1S 0.4 must slice with status ok and a time and a
// weight above zero. .github/workflows/slicer-image.yml runs this file, with
// SLICER_IMAGE_PREBUILT=1, against the image it built for a new Orca version,
// and pushes nothing unless it passes. In CI it runs with the other container
// tests against the image built from the Dockerfile's pinned version. The
// fixtures are generated here, so no designer file is involved.
import { slicerContract } from "@platehouse/slicer-contract";
import { buildSliceable, SLICEABLE_PRINTER } from "@platehouse/threemf/test/sliceable";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type RunningSlicer, startSlicer } from "./support/slicer.js";

let slicer: RunningSlicer;
beforeAll(async () => {
  slicer = await startSlicer();
});
afterAll(() => slicer?.stop());

const FIXTURES = [
  { plates: 2, filaments: 2 },
  { plates: 3, filaments: 4 },
];

describe("smoke slice", () => {
  test("the printer is the P1S 0.4", () => {
    expect(SLICEABLE_PRINTER).toBe("Bambu Lab P1S 0.4 nozzle");
  });

  test.each(
    FIXTURES.flatMap(({ plates, filaments }) =>
      Array.from({ length: plates }, (_, i) => ({ plates, filaments, plate: i + 1 })),
    ),
  )(
    "plate $plate of $plates plates with $filaments filaments slices ok with time and weight",
    async ({ plates, filaments, plate }) => {
      const file = buildSliceable({ plates, filaments });
      const res = await fetch(
        `${slicer.base}/v1/slice?printer=${encodeURIComponent(SLICEABLE_PRINTER)}&plate=${plate}`,
        { method: "POST", headers: { "content-type": "application/octet-stream" }, body: file },
      );
      expect(res.status).toBe(200);
      const raw = await res.json();
      const body = slicerContract.sliceResult.parse(raw);
      if (body.status !== "ok") throw new Error(`plate ${plate} failed: ${JSON.stringify(raw)}`);
      expect(body.plate).toBe(plate);
      expect(body.printer).toBe(SLICEABLE_PRINTER);
      expect(body.timeSeconds).toBeGreaterThan(0);
      expect(body.weightGrams).toBeGreaterThan(0);
    },
  );
});
