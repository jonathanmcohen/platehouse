// The default filament per type for a printer (build plan Task 11 Decisions,
// Jon 2026-11-08: "I use mostly Bambu Filaments"): Bambu's own preset for
// that printer where Orca has one, then the Generic preset for that printer,
// then the file's own filament (no pick). The first block runs over a digest
// of the real Orca 2.5.0 BBL profiles (test/fixtures/orca-filaments.json,
// written by test/support/filament-digest.ts from Orca's source at the
// image's pinned commit); the container tests check the image against it.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { BAMBU_FILAMENTS, type FilamentCandidate, pickFilament } from "../src/profiles.js";
import { digestCandidates, type FilamentDigest } from "./support/filament-digest.js";

const digest = JSON.parse(
  readFileSync(new URL("./fixtures/orca-filaments.json", import.meta.url), "utf8"),
) as FilamentDigest;
const candidates = digestCandidates(digest);
const MAPPED = Object.keys(BAMBU_FILAMENTS);
const baseName = (n: string) => (n.includes(" @") ? n.slice(0, n.indexOf(" @")) : n);

const MODELS = [
  "A1",
  "A1 mini",
  "A2L",
  "H2C",
  "H2D",
  "H2D Pro",
  "H2S",
  "P1P",
  "P1S",
  "P2S",
  "X1",
  "X1 Carbon",
  "X1E",
  "X2D",
];
const NOZZLES = ["0.2", "0.4", "0.6", "0.8"];
const printer = (model: string, nozzle: string) => `Bambu Lab ${model} ${nozzle} nozzle`;

/**
 * The printer x type pairs with neither a Bambu nor a Generic preset in Orca
 * 2.5.0, which keep the file's own filament: no 0.2 mm TPU on any printer,
 * and no ABS or ASA on the A1 mini or the A2L.
 */
const FILE_FALLBACKS = [
  ...MODELS.map((m) => `${printer(m, "0.2")} | TPU`),
  ...["A1 mini", "A2L"].flatMap((m) =>
    NOZZLES.flatMap((n) => [`${printer(m, n)} | ABS`, `${printer(m, n)} | ASA`]),
  ),
].sort();

describe("the mapping table", () => {
  test("is the front office's five types, in one table", () => {
    expect(BAMBU_FILAMENTS).toEqual({
      PLA: "Bambu PLA Basic",
      PETG: "Bambu PETG HF",
      ABS: "Bambu ABS",
      ASA: "Bambu ASA",
      TPU: "Bambu TPU 95A",
    });
  });

  test("every preset it names is in the digest (else the digest needs regenerating)", () => {
    const bases = new Set(Object.keys(digest.filaments).map(baseName));
    for (const name of Object.values(BAMBU_FILAMENTS)) expect(bases, name).toContain(name);
  });
});

describe("over the real Orca 2.5.0 BBL profiles", () => {
  test("the digest is Orca 2.5.0 at the image's pinned source commit, with all 56 menu printers", () => {
    expect(digest.orca).toBe("2.5.0");
    expect(digest.orcaSourceCommit).toBe("40ecc66f78ed72dc368e0c1ebe40d77f00cc8a19");
    const expected = MODELS.flatMap((m) => NOZZLES.map((n) => printer(m, n))).sort();
    expect([...digest.printers].sort()).toEqual(expected);
    expect(digest.printers).toHaveLength(56);
  });

  test("the P1S 0.4 gets Bambu's own preset for all five types", () => {
    const p = printer("P1S", "0.4");
    expect(Object.fromEntries(MAPPED.map((t) => [t, pickFilament(candidates, p, t)]))).toEqual({
      PLA: { profile: "Bambu PLA Basic @BBL P1S 0.4 nozzle", source: "bambu" },
      PETG: { profile: "Bambu PETG HF @BBL P1S 0.4 nozzle", source: "bambu" },
      ABS: { profile: "Bambu ABS @BBL P1S 0.4 nozzle", source: "bambu" },
      ASA: { profile: "Bambu ASA @BBL X1C 0.4 nozzle", source: "bambu" },
      TPU: { profile: "Bambu TPU 95A @BBL X1C", source: "bambu" },
    });
  });

  test("the A1 0.4 gets Bambu's own A1 presets for all five types", () => {
    const p = printer("A1", "0.4");
    expect(Object.fromEntries(MAPPED.map((t) => [t, pickFilament(candidates, p, t)]))).toEqual({
      PLA: { profile: "Bambu PLA Basic @BBL A1", source: "bambu" },
      PETG: { profile: "Bambu PETG HF @BBL A1", source: "bambu" },
      ABS: { profile: "Bambu ABS @BBL A1", source: "bambu" },
      ASA: { profile: "Bambu ASA @BBL A1 0.4 nozzle", source: "bambu" },
      TPU: { profile: "Bambu TPU 95A @BBL A1", source: "bambu" },
    });
  });

  test("every printer resolves every mapped type to its Bambu preset, else a fallback the list names", () => {
    const fileFallbacks: string[] = [];
    const genericFallbacks: string[] = [];
    for (const p of digest.printers) {
      for (const type of MAPPED) {
        const pick = pickFilament(candidates, p, type);
        const bambu = candidates.filter(
          (c) =>
            baseName(c.name) === BAMBU_FILAMENTS[type] &&
            c.type === type &&
            c.compatible.includes(p),
        );
        // Orca 2.5.0 has at most one Bambu preset per printer and type, so
        // the pick never has to break a tie on real data.
        expect(bambu.length, `${p} ${type}`).toBeLessThanOrEqual(1);
        if (bambu[0]) {
          expect(pick, `${p} ${type}`).toEqual({ profile: bambu[0].name, source: "bambu" });
        } else if (pick === null) {
          fileFallbacks.push(`${p} | ${type}`);
        } else {
          genericFallbacks.push(`${p} | ${type} -> ${pick.profile}`);
          expect(pick.source).toBe("generic");
        }
      }
    }
    expect(fileFallbacks.sort()).toEqual(FILE_FALLBACKS);
    // Wherever 2.5.0 lacks the Bambu preset it lacks the Generic one too.
    expect(genericFallbacks).toEqual([]);
  });

  test("every pick for every type in the profiles fits the printer and the type; unmapped types are generic", () => {
    const types = [...new Set(candidates.map((c) => c.type))].sort();
    expect(types.length).toBeGreaterThan(MAPPED.length);
    let picks = 0;
    for (const p of digest.printers) {
      for (const type of types) {
        const pick = pickFilament(candidates, p, type);
        if (pick === null) continue;
        picks += 1;
        const c = candidates.find((x) => x.name === pick.profile);
        expect(c?.type, `${p} ${type}`).toBe(type);
        expect(c?.compatible, `${p} ${type}`).toContain(p);
        if (!MAPPED.includes(type)) {
          expect(pick.source, `${p} ${type}`).toBe("generic");
          expect(pick.profile.startsWith("Generic "), `${p} ${type}`).toBe(true);
        }
      }
    }
    expect(picks).toBeGreaterThan(digest.printers.length * MAPPED.length);
  });

  test("a printer the profiles do not have gets no pick", () => {
    expect(pickFilament(candidates, "Bambu Lab Q9 0.4 nozzle", "PLA")).toBeNull();
  });
});

describe("the pick's rules", () => {
  const P = "Bambu Lab P1S 0.4 nozzle";
  const c = (name: string, type: string, compatible = [P]): FilamentCandidate => ({
    name,
    type,
    compatible,
  });

  test("Bambu's preset wins over the generic one", () => {
    const list = [c("Generic PLA", "PLA"), c("Bambu PLA Basic @BBL X1C", "PLA")];
    expect(pickFilament(list, P, "PLA")).toEqual({
      profile: "Bambu PLA Basic @BBL X1C",
      source: "bambu",
    });
  });

  test("with no Bambu preset for the printer, the generic one for the printer is used", () => {
    const list = [c("Generic PLA", "PLA"), c("Bambu PLA Basic @BBL A1", "PLA", ["Other"])];
    expect(pickFilament(list, P, "PLA")).toEqual({ profile: "Generic PLA", source: "generic" });
  });

  test("with neither, there is no pick and the file keeps its own filament", () => {
    const list = [c("Generic PLA", "PLA", ["Other"]), c("Bambu PLA Basic", "PLA", ["Other"])];
    expect(pickFilament(list, P, "PLA")).toBeNull();
  });

  test("another Bambu preset than the table names is not used", () => {
    const list = [c("Generic PLA", "PLA"), c("Bambu PLA Matte @BBL X1C", "PLA")];
    expect(pickFilament(list, P, "PLA")).toEqual({ profile: "Generic PLA", source: "generic" });
  });

  test("a table preset whose filament type is not the type asked for is not used", () => {
    const list = [c("Generic PETG", "PETG"), c("Bambu PETG HF @BBL X1C", "PETG-HF")];
    expect(pickFilament(list, P, "PETG")).toEqual({ profile: "Generic PETG", source: "generic" });
  });

  test("a type the table does not map goes straight to the generic preset", () => {
    const list = [c("Generic PA", "PA"), c("Bambu PA6-CF @BBL X1C", "PA")];
    expect(pickFilament(list, P, "PA")).toEqual({ profile: "Generic PA", source: "generic" });
  });

  test("two Bambu presets for one printer: the shorter name, then name order", () => {
    const list = [
      c("Bambu ABS @BBL X1C 0.4 nozzle", "ABS"),
      c("Bambu ABS @BBL P1S", "ABS"),
      c("Bambu ABS @BBL A1S", "ABS"),
    ];
    expect(pickFilament(list, P, "ABS")?.profile).toBe("Bambu ABS @BBL A1S");
  });

  test("the generic ranking is the merged one: exact Generic name, then shorter, then name order", () => {
    const list = [c("Generic PLA Silk", "PLA"), c("Generic PLA @BBL X1C", "PLA")];
    expect(pickFilament(list, P, "PLA")?.profile).toBe("Generic PLA @BBL X1C");
  });

  test("the table passed in is the one used", () => {
    const list = [c("Bambu PLA Basic @BBL X1C", "PLA"), c("Bambu PLA Matte @BBL X1C", "PLA")];
    expect(pickFilament(list, P, "PLA", { PLA: "Bambu PLA Matte" })).toEqual({
      profile: "Bambu PLA Matte @BBL X1C",
      source: "bambu",
    });
  });
});
