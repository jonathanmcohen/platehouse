// The printer menu comes from the image's own profiles (AC-031): every BBL
// machine_list entry ending in "nozzle" that is instantiable, and nothing
// else (56 at Orca v2.5.0: 14 models x 0.2/0.4/0.6/0.8).
import { slicerContract } from "@platehouse/slicer-contract";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type RunningSlicer, startSlicer } from "./support/slicer.js";

let slicer: RunningSlicer;
beforeAll(async () => {
  slicer = await startSlicer();
});
afterAll(() => slicer?.stop());

describe("slicer image profiles", () => {
  test("profiles lists every BBL nozzle machine in the image's BBL.json and nothing else", async () => {
    const cat = slicer.exec(["cat", "/opt/orca-profiles/BBL.json"]);
    expect(cat.code).toBe(0);
    const manifest = JSON.parse(cat.stdout) as { machine_list: Array<{ name: string }> };
    const expected = manifest.machine_list
      .map((m) => m.name)
      .filter((n) => n.endsWith("nozzle") && !n.includes(" template ") && !n.endsWith("_common"))
      .sort();
    const res = await fetch(`${slicer.base}/v1/profiles`);
    expect(res.status).toBe(200);
    const body = slicerContract.profiles.parse(await res.json());
    expect(body.orca).toBe("2.5.0");
    expect(body.printers.map((p) => p.id).sort()).toEqual(expected);
    expect(body.printers.length).toBe(56);
    expect(body.printers).toContainEqual({
      id: "Bambu Lab P1S 0.4 nozzle",
      model: "Bambu Lab P1S",
      modelId: "C12",
      nozzle: 0.4,
    });
    for (const p of body.printers) expect(p.id).toBe(`${p.model} ${p.nozzle} nozzle`);
    expect(body.filaments.some((f) => f.type === "PLA")).toBe(true);
  });
});
