import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LIMITS, readProjectMeta } from "../lib/threemf.mjs";
import { build3mf, P1S_PROJECT, writeTmp } from "./support/fixtures.mjs";
import { buildZip } from "./support/zipwriter.mjs";

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
// rounded plate number (or Infinity). Issue #137: the gate now follows the
// packages/threemf rule (parse.ts storedIndex) in full. N must match
// [1-9][0-9]*, or the name is not a plate, and a whole number past
// 2147483647, the largest plate index Postgres stores, of any length, makes
// the file damaged (null), as the app then stores it with no plate data.
test("a plate_N.png name with a leading zero is not a plate", () => {
  const file = writeTmp("zero.3mf", build3mf({ plates: [{ index: 2 }, { index: "01" }], pngOnly: true }));
  assert.deepEqual(
    readProjectMeta(file).plates.map((p) => p.index),
    [2],
  );
});

const PAST_32_BIT = [
  ["2147483648, one past the 32-bit range", "2147483648"],
  ["17 digits", "12345678901234567"],
  ["the first unsafe integer, 9007199254740992", "9007199254740992"],
  ["the next one, which a bare Number() rounds down to the one before", "9007199254740993"],
  ["so many digits that Number() gives Infinity", "9".repeat(400)],
];

// A model_settings plate list holding plate 1 only, and a slice_info plate
// whose index and filament id are the given strings, so a slice_info number
// is checked on its own, never through a plater_id of the same value.
function sliceInfoOnly(index, filamentId) {
  return buildZip([
    { name: "3D/3dmodel.model", data: "<model/>" },
    {
      name: "Metadata/model_settings.config",
      data: '<config>\n  <plate>\n    <metadata key="plater_id" value="1"/>\n  </plate>\n</config>\n',
    },
    {
      name: "Metadata/slice_info.config",
      data:
        "<config>\n  <plate>\n" +
        `    <metadata key="index" value="${index}"/>\n` +
        '    <metadata key="prediction" value="60"/>\n' +
        `    <filament id="${filamentId}" type="PLA" used_g="1"/>\n` +
        "  </plate>\n</config>\n",
    },
  ]);
}

for (const [label, n] of PAST_32_BIT) {
  test(`a plate_N.png name with ${label} makes the file damaged`, () => {
    const file = writeTmp("big.3mf", build3mf({ plates: [{ index: 2 }, { index: n }], pngOnly: true }));
    assert.equal(readProjectMeta(file), null);
  });

  // Issue #129 found the bare parseInt that rounded these; #137 makes each
  // one damage past the 32-bit range instead of a skipped value.
  test(`a plater_id with ${label} makes the file damaged`, () => {
    const file = writeTmp("id.3mf", build3mf({ plates: [{ index: 2 }, { index: n }] }));
    assert.equal(readProjectMeta(file), null);
  });

  // The index check runs on every slice_info plate, matched to a listed
  // plate or not, as packages/threemf runs it before it looks for the plate.
  // The filament id check runs only on a plate numbered from 1 with a usable
  // prediction, the plates both readers keep (see the index 0 test below).
  test(`a slice_info plate index with ${label} makes the file damaged`, () => {
    assert.equal(readProjectMeta(writeTmp("si.3mf", sliceInfoOnly(n, 1))), null);
  });

  test(`a slice_info filament id with ${label} makes the file damaged`, () => {
    assert.equal(readProjectMeta(writeTmp("fid.3mf", sliceInfoOnly(1, n))), null);
  });
}

test("a plate_N.png name at 2147483647 is still a plate", () => {
  const file = writeTmp("max.3mf", build3mf({ plates: [{ index: 2 }, { index: "2147483647" }], pngOnly: true }));
  assert.deepEqual(
    readProjectMeta(file).plates.map((p) => p.index),
    [2, 2147483647],
  );
});

test("a plater_id at 2147483647 is still a plate", () => {
  const file = writeTmp("maxid.3mf", build3mf({ plates: [{ index: 2 }, { index: "2147483647" }] }));
  assert.deepEqual(
    readProjectMeta(file).plates.map((p) => p.index),
    [2, 2147483647],
  );
});

test("a slice_info plate index and filament id at 2147483647 are still read", () => {
  const sliced = readProjectMeta(writeTmp("maxsi.3mf", sliceInfoOnly(1, "2147483647")));
  assert.deepEqual(sliced.plates[0].filaments, [{ slot: 2147483647, type: "PLA", grams: 1 }]);
  const unmatched = readProjectMeta(writeTmp("maxsi2.3mf", sliceInfoOnly("2147483647", 1)));
  assert.deepEqual(
    unmatched.plates.map((p) => [p.index, p.sliced]),
    [[1, false]],
  );
});

// packages/threemf skips a slice_info plate numbered below 1 before it reads
// its filaments, so an over-range filament id there costs nothing: the file
// is stored with its plates. The gate skips that plate first too (PR #154
// review), so the two agree.
for (const index of ["0", "-1"]) {
  test(`a slice_info plate with index ${index} is skipped before its filament ids are checked`, () => {
    const meta = readProjectMeta(writeTmp("low.3mf", sliceInfoOnly(index, "2147483648")));
    assert.notEqual(meta, null);
    assert.deepEqual(
      meta.plates.map((p) => [p.index, p.sliced]),
      [[1, false]],
    );
  });
}

test("a filament id that is not a whole number gives no slot", () => {
  const filaments = [{ id: "x1", type: "PLA", usedG: 3 }];
  const file = writeTmp("fid.3mf", build3mf({ plates: [slicedPlate(1, { filaments })] }));
  assert.deepEqual(readProjectMeta(file).plates[0].filaments, [{ slot: null, type: "PLA", grams: 3 }]);
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
