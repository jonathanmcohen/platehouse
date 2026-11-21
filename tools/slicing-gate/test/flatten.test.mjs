import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  flattenPreset,
  genericFilamentFor,
  loadIndex,
  machineModels,
  nozzlePrinters,
  writeRecipe,
} from "../flatten-profiles.mjs";
import { profileTree as tree } from "./support/profiles.mjs";

test("a machine preset is flattened through inherits to the root, child over parent", () => {
  const idx = loadIndex(tree());
  const { profile, chain } = flattenPreset(idx, "machine", "Bambu Lab P1S 0.4 nozzle");
  assert.deepEqual(chain, ["Bambu Lab P1S 0.4 nozzle", "fdm_bbl_3dp_001_common", "fdm_machine_common"]);
  assert.equal(profile.name, "Bambu Lab P1S 0.4 nozzle");
  assert.equal(profile.printable_height, "250");
  assert.equal(profile.gcode_flavor, "marlin");
  assert.equal(profile.instantiation, "true");
  assert.equal(profile.type, "machine");
  assert.equal(profile.from, "system");
  assert.equal("inherits" in profile, false);
  assert.equal(profile.machine_start_gcode, "generic");
});

test("companion templates are merged only when asked, fill unset keys only, and skip identity keys", () => {
  const idx = loadIndex(tree());
  const { profile } = flattenPreset(idx, "machine", "Bambu Lab P1S 0.4 nozzle", { companions: true });
  assert.equal(profile.machine_start_gcode, "real P1S start");
  // a key the preset sets itself is never overwritten by its companion
  assert.equal(profile.printer_model, "Bambu Lab P1S");
  // a companion carries its preset's precedence, above the preset's ancestors
  assert.equal(profile.printable_height, "999");
  assert.equal(profile.name, "Bambu Lab P1S 0.4 nozzle");
  assert.equal(profile.instantiation, "true");
});

test("a vendor filament walks into the filament library and stays there", () => {
  const idx = loadIndex(tree());
  const { profile, chain } = flattenPreset(idx, "filament", "Generic PLA");
  assert.deepEqual(chain, ["Generic PLA", "Generic PLA @base", "fdm_filament_pla", "fdm_filament_common"]);
  assert.equal(profile.library_only, "yes");
  assert.deepEqual(profile.filament_density, ["1.30"]);
  assert.equal(profile.filament_id, "GFL99");
});

test("a dangling inherits is dropped and reported", () => {
  const idx = loadIndex(tree());
  const out = flattenPreset(idx, "filament", "Dangling");
  assert.equal(out.dangling, "No Such Parent");
  assert.equal("inherits" in out.profile, false);
});

test("an inherits loop stops at the depth limit with an error", () => {
  const idx = loadIndex(tree());
  assert.throws(() => flattenPreset(idx, "filament", "Loop A"), /depth/);
});

test("an unknown preset is an error naming it", () => {
  const idx = loadIndex(tree());
  assert.throws(() => flattenPreset(idx, "machine", "Nope"), /Nope/);
});

test("a manifest sub_path that leaves the profile tree is ignored", () => {
  const idx = loadIndex(tree());
  assert.throws(() => flattenPreset(idx, "machine", "Escape"), /Escape/);
});

test("the generic filament for a type prefers the exact Generic name compatible with the printer", () => {
  const idx = loadIndex(tree());
  assert.deepEqual(genericFilamentFor(idx, "Bambu Lab P1S 0.4 nozzle", "PLA").name, "Generic PLA");
  assert.deepEqual(genericFilamentFor(idx, "Bambu Lab A1 0.4 nozzle", "PLA").name, "Generic PLA @BBL A1");
  assert.equal(genericFilamentFor(idx, "Bambu Lab P1S 0.4 nozzle", "PETG").name, "Generic PETG");
  assert.equal(genericFilamentFor(idx, "Bambu Lab A1 0.4 nozzle", "PETG"), null);
  assert.equal(genericFilamentFor(idx, "Bambu Lab P1S 0.4 nozzle", "ASA"), null);
});

test("nozzle printers are the instantiable presets ending in nozzle; model ids come from machine_model files", () => {
  const idx = loadIndex(tree());
  assert.deepEqual(nozzlePrinters(idx), ["Bambu Lab A1 0.4 nozzle", "Bambu Lab P1S 0.4 nozzle"]);
  assert.deepEqual(machineModels(idx), { C12: "Bambu Lab P1S", N2S: "Bambu Lab A1" });
});

test("writeRecipe writes loadable machine and filament files and a recipe naming them", () => {
  const idx = loadIndex(tree());
  const out = mkdtempSync(join(tmpdir(), "gate-recipe-"));
  const recipe = writeRecipe(idx, out, {
    printers: ["Bambu Lab P1S 0.4 nozzle", "Bambu Lab A1 0.4 nozzle"],
    types: ["PLA", "PETG"],
  });
  const p1s = recipe.printers["Bambu Lab P1S 0.4 nozzle"];
  const machine = JSON.parse(readFileSync(join(out, p1s.file), "utf8"));
  assert.equal(machine.name, "Bambu Lab P1S 0.4 nozzle");
  assert.equal(machine.type, "machine");
  const pla = recipe.filaments["Bambu Lab P1S 0.4 nozzle"].PLA;
  assert.equal(pla.name, "Generic PLA");
  assert.equal(JSON.parse(readFileSync(join(out, pla.file), "utf8")).type, "filament");
  assert.equal(recipe.filaments["Bambu Lab A1 0.4 nozzle"].PETG, null);
  assert.deepEqual(recipe.modelIds, { C12: "Bambu Lab P1S", N2S: "Bambu Lab A1" });
  assert.equal(recipe.nozzlePrinterCount, 2);
  assert.equal(recipe.companions, false);
  assert.ok(!p1s.file.includes(" "));
});

// OrcaSlicer 2.5.0's AppImage has no BBL.json and no BBL/machine, process or
// filament JSON: every vendor's presets are packed into <vendor>.opc, a binary
// preset cache, and BBL/ keeps only covers, models and filament maps. Read
// from the pinned AppImage's squashfs listing on 2026-11-08. The index must
// say so, not come back empty and turn every printer into a "no bundled
// machine preset" setup error.
function opcOnlyTree() {
  const root = mkdtempSync(join(tmpdir(), "gate-opc-"));
  mkdirSync(join(root, "BBL", "filament"), { recursive: true });
  writeFileSync(join(root, "BBL.opc"), Buffer.from("ZCRO\u0002\u0000\u0000\u0000", "latin1"));
  writeFileSync(join(root, "OrcaFilamentLibrary.opc"), Buffer.from("ZCRO\u0002\u0000\u0000\u0000", "latin1"));
  writeFileSync(join(root, "BBL", "cli_config.json"), "{}");
  writeFileSync(join(root, "BBL", "filament", "filament_id_map.json"), "{}");
  return root;
}

test("a profile tree that only has BBL.opc is an error naming the packed format", () => {
  assert.throws(() => loadIndex(opcOnlyTree()), /BBL\.opc.*binary preset cache.*cannot read/);
});

test("a profile tree with no BBL presets at all is an error naming the folder", () => {
  const root = mkdtempSync(join(tmpdir(), "gate-empty-"));
  assert.throws(() => loadIndex(root), (err) => err.message.includes(root) && /no BBL presets/.test(err.message));
});
