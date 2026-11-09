// The printer menu comes from the image's own profiles (AC-031): every BBL
// machine_list entry ending in "nozzle" that is instantiable, and nothing
// else (56 at Orca v2.5.0: 14 models x 0.2/0.4/0.6/0.8). Every filament
// entry names its printer, and the image's default filament per printer and
// type equals the pick the unit tests check over the real-profile digest
// (test/fixtures/orca-filaments.json), so the digest cannot drift from the
// image unnoticed.
import { readFileSync } from "node:fs";
import { slicerContract } from "@platehouse/slicer-contract";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { pickFilament } from "../../src/profiles.js";
import { digestCandidates, type FilamentDigest } from "../support/filament-digest.js";
import { type RunningSlicer, startSlicer } from "./support/slicer.js";

let slicer: RunningSlicer;
beforeAll(async () => {
  slicer = await startSlicer();
});
afterAll(() => slicer?.stop());

async function profiles() {
  const res = await fetch(`${slicer.base}/v1/profiles`);
  expect(res.status).toBe(200);
  return slicerContract.profiles.parse(await res.json());
}

describe("slicer image profiles", () => {
  test("profiles lists every BBL nozzle machine in the image's BBL.json and nothing else", async () => {
    const cat = slicer.exec(["cat", "/opt/orca-profiles/BBL.json"]);
    expect(cat.code).toBe(0);
    const manifest = JSON.parse(cat.stdout) as { machine_list: Array<{ name: string }> };
    const expected = manifest.machine_list
      .map((m) => m.name)
      .filter((n) => n.endsWith("nozzle") && !n.includes(" template ") && !n.endsWith("_common"))
      .sort();
    const body = await profiles();
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

  test("every filament entry names a menu printer, and each printer and type appears once", async () => {
    const body = await profiles();
    const menu = new Set(body.printers.map((p) => p.id));
    const seen = new Set<string>();
    for (const f of body.filaments) {
      expect(menu.has(f.printer), JSON.stringify(f)).toBe(true);
      const key = `${f.printer} | ${f.type}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
    }
  });

  test("the image's default filaments equal the pick over the real-profile digest, for every printer and type", async () => {
    const digest = JSON.parse(
      readFileSync(new URL("../fixtures/orca-filaments.json", import.meta.url), "utf8"),
    ) as FilamentDigest;
    const body = await profiles();
    expect(body.orca).toBe(digest.orca);
    expect(body.printers.map((p) => p.id).sort()).toEqual([...digest.printers].sort());
    const candidates = digestCandidates(digest);
    const types = [...new Set(candidates.map((c) => c.type))].sort();
    const expected: typeof body.filaments = [];
    for (const printer of [...digest.printers].sort()) {
      for (const type of types) {
        const pick = pickFilament(candidates, printer, type);
        if (pick) expected.push({ printer, type, profile: pick.profile, source: pick.source });
      }
    }
    type Entry = (typeof body.filaments)[number];
    const key = (f: Entry) => `${f.printer}\u0000${f.type}`;
    const order = (a: Entry, b: Entry) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
    expect([...body.filaments].sort(order)).toEqual(expected.sort(order));
  });
});
