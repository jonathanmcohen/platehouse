// Profiles (build plan Task 11): the T1 recipe, ported from the slicing gate's
// flatten-profiles.mjs, which Hades run 4 proved. Presets are flattened
// through inherits at image build; only the machine preset is loaded with
// --load-settings, one default filament per type with --load-filaments (Bambu's
// own preset for the printer, else the generic one; filaments.test.ts), and
// Orca's process_full folder gets every instantiable machine's default
// process (without it a printer switch fails with code -3, gate run 3).
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  buildProfiles,
  flattenPreset,
  genericFilamentFor,
  loadIndex,
  loadProfiles,
  machineModels,
  nozzlePrinters,
  writeProcessFull,
} from "../src/profiles.js";
import { profileTree, put, TREE_PRINTERS } from "./support/profiles.js";

const scratch = () => mkdtempSync(join(tmpdir(), "slicer-out-"));
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));

describe("flattening", () => {
  test("a machine preset is flattened through inherits to the root, child over parent", () => {
    const { profile, chain, dangling } = flattenPreset(
      loadIndex(profileTree()),
      "machine",
      "Bambu Lab P1S 0.4 nozzle",
    );
    expect(chain).toEqual([
      "Bambu Lab P1S 0.4 nozzle",
      "fdm_bbl_3dp_001_common",
      "fdm_machine_common",
    ]);
    expect(dangling).toBeNull();
    expect(profile.printable_height).toBe("250");
    expect(profile.gcode_flavor).toBe("marlin");
    expect(profile.machine_start_gcode).toBe("generic");
    expect(profile.inherits).toBeUndefined();
    expect(profile.from).toBe("system");
    expect(profile.type).toBe("machine");
    expect(profile.name).toBe("Bambu Lab P1S 0.4 nozzle");
  });

  test("a vendor filament walks into the filament library and stays there", () => {
    const { profile, chain } = flattenPreset(loadIndex(profileTree()), "filament", "Generic PLA");
    expect(chain).toEqual([
      "Generic PLA",
      "Generic PLA @base",
      "fdm_filament_pla",
      "fdm_filament_common",
    ]);
    // the library's fdm_filament_common, not the vendor's
    expect(profile.library_only).toBe("yes");
    expect(profile.filament_density).toEqual(["1.30"]);
  });

  test("a dangling inherits is dropped and reported", () => {
    const { profile, dangling } = flattenPreset(loadIndex(profileTree()), "filament", "Dangling");
    expect(dangling).toBe("No Such Parent");
    expect(profile.inherits).toBeUndefined();
  });

  test("an inherits loop stops at the depth limit with an error", () => {
    expect(() => flattenPreset(loadIndex(profileTree()), "filament", "Loop A")).toThrow(
      /inheritance depth/,
    );
  });

  test("an unknown preset is an error naming it", () => {
    expect(() => flattenPreset(loadIndex(profileTree()), "machine", "No Such Printer")).toThrow(
      /No Such Printer/,
    );
  });

  test("a manifest sub_path that leaves the profile tree is ignored", () => {
    expect(() => flattenPreset(loadIndex(profileTree()), "machine", "Escape")).toThrow(/Escape/);
  });

  test("a profile tree that only has BBL.opc is an error naming the packed format", () => {
    const root = scratch();
    put(root, "BBL.opc", {});
    expect(() => loadIndex(root)).toThrow(/binary preset cache/);
  });

  test("a profile tree with no BBL presets at all is an error naming the folder", () => {
    const root = scratch();
    expect(() => loadIndex(root)).toThrow(root);
  });
});

describe("printers and filaments", () => {
  test("nozzle printers are the instantiable presets ending in nozzle; model ids come from machine_model files", () => {
    const index = loadIndex(profileTree());
    expect(nozzlePrinters(index)).toEqual(TREE_PRINTERS);
    expect(machineModels(index)).toEqual({ C12: "Bambu Lab P1S", N2S: "Bambu Lab A1" });
  });

  test("the generic filament for a type prefers the exact Generic name compatible with the printer", () => {
    const index = loadIndex(profileTree());
    expect(genericFilamentFor(index, "Bambu Lab P1S 0.4 nozzle", "PLA")?.name).toBe("Generic PLA");
    expect(genericFilamentFor(index, "Bambu Lab A1 0.4 nozzle", "PLA")?.name).toBe(
      "Generic PLA @BBL A1",
    );
    expect(genericFilamentFor(index, "Bambu Lab P1S 0.4 nozzle", "PETG")?.name).toBe(
      "Generic PETG",
    );
    expect(genericFilamentFor(index, "Bambu Lab A1 0.4 nozzle", "PETG")).toBeNull();
  });
});

describe("process_full", () => {
  test("every machine's default process is written flattened, named exactly as Orca builds the path", () => {
    const out = join(scratch(), "process_full");
    const result = writeProcessFull(loadIndex(profileTree()), out);
    expect(result).toEqual({
      files: ["0.20mm Standard @BBL A1", "0.20mm Standard @BBL X1C"],
      machines: 2,
    });
    expect(readdirSync(out).sort()).toEqual([
      "0.20mm Standard @BBL A1.json",
      "0.20mm Standard @BBL X1C.json",
    ]);
    const x1c = readJson(join(out, "0.20mm Standard @BBL X1C.json"));
    expect(x1c.type).toBe("process");
    expect(x1c.from).toBe("system");
    expect(x1c.inherits).toBeUndefined();
    expect(x1c.layer_height).toBe("0.2");
    expect(x1c.print_extruder_variant).toEqual(["Direct Drive Standard", "Direct Drive High Flow"]);
  });

  test("it never overwrites a file already in the folder", () => {
    const out = join(scratch(), "process_full");
    writeProcessFull(loadIndex(profileTree()), out);
    expect(() => writeProcessFull(loadIndex(profileTree()), out)).toThrow(/EEXIST/);
  });

  test("a default process name that would leave the folder is refused and nothing is written", () => {
    const root = profileTree();
    put(root, "BBL/machine/Bambu Lab A1 0.4 nozzle.json", {
      type: "machine",
      name: "Bambu Lab A1 0.4 nozzle",
      inherits: "fdm_bbl_3dp_001_common",
      instantiation: "true",
      default_print_profile: "../evil",
    });
    const out = join(scratch(), "process_full");
    expect(() => writeProcessFull(loadIndex(root), out)).toThrow(/not a plain file name/);
    expect(existsSync(out)).toBe(false);
  });

  test("a default process the bundle does not have fails, naming the machine, and nothing is written", () => {
    const root = profileTree();
    put(root, "BBL/machine/Bambu Lab A1 0.4 nozzle.json", {
      type: "machine",
      name: "Bambu Lab A1 0.4 nozzle",
      inherits: "fdm_bbl_3dp_001_common",
      instantiation: "true",
      default_print_profile: "0.20mm Missing @BBL A1",
    });
    const out = join(scratch(), "process_full");
    expect(() => writeProcessFull(loadIndex(root), out)).toThrow(
      /Bambu Lab A1 0\.4 nozzle[\s\S]*0\.20mm Missing @BBL A1/,
    );
    expect(existsSync(out)).toBe(false);
  });
});

describe("the image's profile folder", () => {
  test("buildProfiles writes a loadable machine file per menu printer and a default filament per type", () => {
    const out = scratch();
    const manifest = buildProfiles(loadIndex(profileTree()), out);
    expect(manifest.printers.map((p) => p.id)).toEqual(TREE_PRINTERS);
    expect(manifest.printers.find((p) => p.id === "Bambu Lab P1S 0.4 nozzle")).toMatchObject({
      model: "Bambu Lab P1S",
      modelId: "C12",
      nozzle: 0.4,
    });
    const profiles = loadProfiles(out);
    const machine = profiles.machineFile("Bambu Lab P1S 0.4 nozzle");
    expect(machine).not.toBeNull();
    const flat = readJson(machine as string);
    expect(flat.name).toBe("Bambu Lab P1S 0.4 nozzle");
    expect(flat.inherits).toBeUndefined();
    expect(flat.printable_height).toBe("250");
    const pla = profiles.filamentFor("Bambu Lab P1S 0.4 nozzle", "PLA");
    expect(pla).toMatchObject({ profile: "Bambu PLA Basic @BBL P1S 0.4 nozzle", source: "bambu" });
    expect(profiles.filamentFor("Bambu Lab P1S 0.4 nozzle", "PETG")).toMatchObject({
      profile: "Generic PETG",
      source: "generic",
    });
    expect(profiles.filamentFor("Bambu Lab A1 0.4 nozzle", "PLA")).toMatchObject({
      profile: "Generic PLA @BBL A1",
      source: "generic",
    });
    expect(profiles.filamentFor("Bambu Lab A1 0.4 nozzle", "PETG")).toBeNull();
    expect(profiles.filamentFor("Bambu Lab A1 0.4 nozzle", "NOPE")).toBeNull();
    expect(profiles.machineFile("Bambu Lab Retired 0.4 nozzle")).toBeNull();
  });

  test("the Bambu preset is written flattened through the filament library", () => {
    const out = scratch();
    buildProfiles(loadIndex(profileTree()), out);
    const pla = loadProfiles(out).filamentFor("Bambu Lab P1S 0.4 nozzle", "PLA");
    const flat = readJson(pla?.file as string);
    expect(flat.name).toBe("Bambu PLA Basic @BBL P1S 0.4 nozzle");
    expect(flat.inherits).toBeUndefined();
    expect(flat.filament_type).toEqual(["PLA"]);
    expect(flat.filament_vendor).toEqual(["Bambu Lab"]);
    expect(flat.library_only).toBe("yes");
  });

  test("the flat filament list names the printer on every entry, sorted by printer then type", () => {
    const out = scratch();
    buildProfiles(loadIndex(profileTree()), out);
    expect(loadProfiles(out).filaments).toEqual([
      { printer: "Bambu Lab A1 0.4 nozzle", type: "PLA", profile: "Generic PLA @BBL A1" },
      { printer: "Bambu Lab P1S 0.4 nozzle", type: "PETG", profile: "Generic PETG" },
      {
        printer: "Bambu Lab P1S 0.4 nozzle",
        type: "PLA",
        profile: "Bambu PLA Basic @BBL P1S 0.4 nozzle",
      },
    ]);
  });

  test("a manifest pick with no source is refused at load", () => {
    const out = scratch();
    buildProfiles(loadIndex(profileTree()), out);
    const manifest = readJson(join(out, "manifest.json"));
    delete manifest.filaments["Bambu Lab P1S 0.4 nozzle"].PLA.source;
    put(out, "manifest.json", manifest);
    expect(() => loadProfiles(out)).toThrow(/manifest/);
  });

  test("a missing or damaged manifest fails loudly at load, not on the first request", () => {
    const out = scratch();
    expect(() => loadProfiles(out)).toThrow(/manifest/);
    put(out, "manifest.json", { printers: "no" });
    expect(() => loadProfiles(out)).toThrow(/manifest/);
  });
});
