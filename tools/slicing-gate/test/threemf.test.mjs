import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LIMITS, readProjectMeta } from "../lib/threemf.mjs";
import { build3mf, P1S_PROJECT, writeTmp } from "./support/fixtures.mjs";

const slicedPlate = (index, extra = {}) => ({
  index,
  sliced: {
    prediction: 5025,
    weight: 41.37,
    modelId: "C12",
    nozzle: "0.4",
    filaments: [
      { id: 1, type: "PLA", usedG: 30.1 },
      { id: 2, type: "PETG", usedG: 11.27 },
    ],
    ...extra,
  },
});

test("a sliced P1S file yields per-plate Bambu numbers and the printer it was sliced for", () => {
  const file = writeTmp(
    "a.3mf",
    build3mf({ plates: [slicedPlate(1), { index: 2, objects: 3 }], project: P1S_PROJECT }),
  );
  const meta = readProjectMeta(file);
  assert.equal(meta.plates.length, 2);
  assert.deepEqual(meta.plates[0], {
    index: 1,
    objectCount: 1,
    sliced: true,
    predictionSeconds: 5025,
    weightGrams: 41.37,
    filaments: [
      { slot: 1, type: "PLA", grams: 30.1 },
      { slot: 2, type: "PETG", grams: 11.27 },
    ],
  });
  assert.equal(meta.plates[1].sliced, false);
  assert.equal(meta.plates[1].objectCount, 3);
  assert.deepEqual(meta.slicedFor, { printerModelId: "C12", nozzle: "0.4" });
  assert.equal(meta.project.printerModel, "Bambu Lab P1S");
  assert.equal(meta.project.printerSettingsId, "Bambu Lab P1S 0.4 nozzle");
  assert.equal(meta.project.nozzleDiameter, "0.4");
  assert.equal(meta.project.printSettingsId, "0.20mm Standard @BBL X1C");
  assert.deepEqual(meta.project.filamentTypes, ["PLA", "PETG"]);
  assert.equal(meta.project.layerHeight, "0.2");
  assert.equal(meta.project.wallLoops, "2");
  assert.equal(meta.project.sparseInfillDensity, "15%");
  assert.deepEqual(meta.keys, {
    sliceInfo: { printer_model_id: true, nozzle_diameters: true },
    projectSettings: {
      printer_model: true,
      printer_settings_id: true,
      nozzle_diameter: true,
      print_settings_id: true,
    },
  });
});

test("an unsliced file has plates but no slicedFor", () => {
  const file = writeTmp("u.3mf", build3mf({ plates: [{ index: 1 }, { index: 2 }], project: P1S_PROJECT }));
  const meta = readProjectMeta(file);
  assert.equal(meta.plates.length, 2);
  assert.ok(meta.plates.every((p) => p.sliced === false && p.predictionSeconds === null));
  assert.equal(meta.slicedFor, null);
});

test("the plate list falls back to the plate_N.png names", () => {
  const file = writeTmp("p.3mf", build3mf({ plates: [{ index: 3 }, { index: 1 }], pngOnly: true }));
  const meta = readProjectMeta(file);
  assert.deepEqual(
    meta.plates.map((p) => p.index),
    [1, 3],
  );
  assert.equal(meta.plates[0].objectCount, null);
  assert.equal(meta.project.printerModel, null);
});

// Issue #25: the plate number in a plate_N.png name used to go through a bare
// Number(), so a name past Number.MAX_SAFE_INTEGER came back as a different,
// rounded plate number (or Infinity). The gate now follows packages/threemf:
// N must match [1-9][0-9]* and be a safe integer, or the name is not a plate.
for (const [label, n] of [
  ["17 digits", "12345678901234567"],
  ["the first unsafe integer, 9007199254740992", "9007199254740992"],
  ["the next one, which a bare Number() rounds down to the one before", "9007199254740993"],
  ["so many digits that Number() gives Infinity", "9".repeat(400)],
  ["a leading zero", "01"],
]) {
  test(`a plate_N.png name with ${label} is not a plate`, () => {
    const file = writeTmp("big.3mf", build3mf({ plates: [{ index: 2 }, { index: n }], pngOnly: true }));
    assert.deepEqual(
      readProjectMeta(file).plates.map((p) => p.index),
      [2],
    );
  });
}

test("a plate_N.png name at Number.MAX_SAFE_INTEGER is still a plate", () => {
  const file = writeTmp("max.3mf", build3mf({ plates: [{ index: 2 }, { index: "9007199254740991" }], pngOnly: true }));
  assert.deepEqual(
    readProjectMeta(file).plates.map((p) => p.index),
    [2, Number.MAX_SAFE_INTEGER],
  );
});

test("a prediction over ten years counts as unsliced", () => {
  const file = writeTmp(
    "t.3mf",
    build3mf({ plates: [slicedPlate(1, { prediction: LIMITS.predictionSeconds + 1 })], project: P1S_PROJECT }),
  );
  const meta = readProjectMeta(file);
  assert.equal(meta.plates[0].sliced, false);
  assert.equal(meta.slicedFor, null);
});

test("ceilings are inclusive: 128 plates read, 129 plates is damage", () => {
  const plates = (n) => Array.from({ length: n }, (_, i) => ({ index: i + 1 }));
  assert.equal(readProjectMeta(writeTmp("a.3mf", build3mf({ plates: plates(128) }))).plates.length, 128);
  assert.equal(readProjectMeta(writeTmp("b.3mf", build3mf({ plates: plates(129) }))), null);
});

test("257 filaments on a sliced plate is damage", () => {
  const filaments = Array.from({ length: 257 }, (_, i) => ({ id: i + 1, type: "PLA", usedG: 1 }));
  const file = writeTmp("f.3mf", build3mf({ plates: [slicedPlate(1, { filaments })] }));
  assert.equal(readProjectMeta(file), null);
});

test("XML escapes in attribute values are decoded", () => {
  const file = writeTmp(
    "e.3mf",
    build3mf({ plates: [slicedPlate(1, { modelId: "A&B" })], project: P1S_PROJECT }),
  );
  assert.equal(readProjectMeta(file).slicedFor.printerModelId, "A&B");
});

test("a non-zip or empty archive is null, a missing file throws", () => {
  assert.equal(readProjectMeta(writeTmp("n.3mf", Buffer.from("nope"))), null);
  assert.equal(readProjectMeta(writeTmp("z.3mf", build3mf({ plates: [] }))), null);
  const missing = join(mkdtempSync(join(tmpdir(), "gate-")), "missing.3mf");
  assert.throws(() => readProjectMeta(missing), { code: "ENOENT" });
});

test("broken project_settings JSON leaves project fields null but keeps plates", () => {
  const file = writeTmp("j.3mf", build3mf({ plates: [{ index: 1 }], project: "{not json" }));
  const meta = readProjectMeta(file);
  assert.equal(meta.plates.length, 1);
  assert.deepEqual(meta.project.filamentTypes, []);
  assert.equal(meta.project.printerModel, null);
  assert.equal(meta.keys.projectSettings.printer_model, false);
});
