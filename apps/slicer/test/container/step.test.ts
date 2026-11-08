// STEP to GLB in the built image (AC-050). The sample is NIST MBE PMI test
// case CTC-01, geometry only, the public file gate item (h) used; CI
// downloads it, checks its sha256 and names it in STEP_SAMPLE. It is public
// NIST test data, not a designer file.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type RunningSlicer, startSlicer } from "./support/slicer.js";

let slicer: RunningSlicer;
beforeAll(async () => {
  slicer = await startSlicer();
});
afterAll(() => slicer?.stop());

describe("STEP in the image", () => {
  test("STEP sample converts to GLB", async () => {
    const sample = process.env.STEP_SAMPLE;
    if (!sample) throw new Error("STEP_SAMPLE must name the NIST CTC-01 STEP file");
    const res = await fetch(`${slicer.base}/v1/step/glb`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: readFileSync(sample),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("model/gltf-binary");
    const glb = Buffer.from(await res.arrayBuffer());
    expect(glb.subarray(0, 4).toString("ascii")).toBe("glTF");
    expect(glb.readUInt32LE(8)).toBe(glb.length);
    expect(glb.length).toBeGreaterThan(10_000);
  });

  test("a file that is not STEP is 422 convert_failed", async () => {
    const res = await fetch(`${slicer.base}/v1/step/glb`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: "not a step file",
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("convert_failed");
  });
});
