import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { orcaPrinterName, printerOf } from "../lib/printers.mjs";
import { scanFolder, selectSample } from "../select-sample.mjs";
import { build3mf, P1S_PROJECT, writeTmp } from "./support/fixtures.mjs";

const meta = (modelId, nozzle = "0.4", slicedPlates = 1, totalPlates = 2) => ({
  plates: Array.from({ length: totalPlates }, (_, i) => ({ index: i + 1, sliced: i < slicedPlates })),
  slicedFor: modelId === null ? null : { printerModelId: modelId, nozzle },
  project: { printerModel: null, nozzleDiameter: null, filamentTypes: ["PLA"] },
});

test("printerOf maps the slice_info model id to the Orca printer name", () => {
  assert.deepEqual(printerOf(meta("C12")), {
    model: "Bambu Lab P1S",
    nozzle: "0.4",
    orcaName: "Bambu Lab P1S 0.4 nozzle",
    source: "slice_info printer_model_id C12",
  });
  assert.equal(printerOf(meta("BL-P001")).model, "Bambu Lab X1 Carbon");
  assert.equal(printerOf(meta("N1")).model, "Bambu Lab A1 mini");
});

test("printerOf falls back to project_settings printer_model when the id is unknown", () => {
  const m = meta("ZZ9");
  m.project.printerModel = "Bambu Lab A1";
  m.project.nozzleDiameter = "0.4";
  assert.equal(printerOf(m).model, "Bambu Lab A1");
  assert.match(printerOf(m).source, /project_settings printer_model/);
});

test("printerOf is null for an unsliced file", () => {
  assert.equal(printerOf(meta(null, null, 0)), null);
});

test("orcaPrinterName normalises nozzle text", () => {
  assert.equal(orcaPrinterName("Bambu Lab P1S", "0.40"), "Bambu Lab P1S 0.4 nozzle");
  assert.equal(orcaPrinterName("Bambu Lab H2D", "0.4;0.4"), "Bambu Lab H2D 0.4 nozzle");
});

test("selectSample picks 5 P1S, 5 unsliced, one per foreign printer, Air Dry, and lists every sliced file", () => {
  const files = [];
  for (let i = 1; i <= 7; i++) files.push({ name: `p1s-${i}.3mf`, meta: meta("C12") });
  for (let i = 1; i <= 6; i++) files.push({ name: `u-${i}.3mf`, meta: meta(null, null, 0) });
  for (const [id, n] of [
    ["BL-P001", "x1c"],
    ["N2S", "a1"],
    ["N1", "a1m"],
    ["C11", "p1p"],
    ["N7", "p2s"],
  ]) {
    files.push({ name: `${n}-b.3mf`, meta: meta(id) }, { name: `${n}-a.3mf`, meta: meta(id) });
  }
  files.push({ name: "Air Dry - AMS.3mf", meta: meta(null, null, 0, 4) });
  files.push({ name: "broken.3mf", meta: null });
  const odd = meta("ZZ9");
  files.push({ name: "odd.3mf", meta: odd });

  const sel = selectSample(files);
  const byRole = (role) => sel.sample.filter((s) => s.roles.includes(role)).map((s) => s.name);
  assert.deepEqual(byRole("p1s-sliced"), ["p1s-1.3mf", "p1s-2.3mf", "p1s-3.3mf", "p1s-4.3mf", "p1s-5.3mf"]);
  // Air Dry is its own item, never one of the 5 unsliced files, even though it
  // sorts among them.
  assert.deepEqual(byRole("unsliced"), ["u-1.3mf", "u-2.3mf", "u-3.3mf", "u-4.3mf", "u-5.3mf"]);
  assert.deepEqual(byRole("foreign-X1C"), ["x1c-a.3mf"]);
  assert.deepEqual(byRole("foreign-A1 mini"), ["a1m-a.3mf"]);
  assert.deepEqual(byRole("air-dry"), ["Air Dry - AMS.3mf"]);
  assert.deepEqual(sel.missing, ["foreign-X2D"]);
  assert.equal(sel.counts.savedForByPrinter["(not named)"], files.length - 1);
  assert.equal(sel.comparison.length, 7 + 10);
  assert.equal(sel.counts.unreadable, 1);
  assert.deepEqual(sel.unknownPrinter, ["odd.3mf"]);
  assert.equal(sel.counts.slicedFiles, 17);
  assert.equal(sel.counts.slicedPlates, 17);
  // one entry per file
  assert.equal(new Set(sel.sample.map((s) => s.name)).size, sel.sample.length);
  const air = sel.sample.find((s) => s.name === "Air Dry - AMS.3mf");
  assert.deepEqual(air.roles, ["air-dry"]);
  // 5 P1S + 5 unsliced + 5 foreign (no X2D here) + Air Dry
  assert.equal(sel.sample.length, 16);
  assert.equal(sel.counts.unslicedFiles, 7);
});

test("Air Dry does not count toward the 5 unsliced files when fewer than 5 others exist", () => {
  const files = [{ name: "Air Dry - AMS.3mf", meta: meta(null, null, 0, 4) }];
  for (let i = 1; i <= 4; i++) files.push({ name: `u-${i}.3mf`, meta: meta(null, null, 0) });
  const sel = selectSample(files);
  const unsliced = sel.sample.filter((s) => s.roles.includes("unsliced")).map((s) => s.name);
  assert.deepEqual(unsliced, ["u-1.3mf", "u-2.3mf", "u-3.3mf", "u-4.3mf"]);
  assert.ok(sel.missing.includes("unsliced (found 4 of 5)"));
});

test("scanFolder reads .3mf files recursively and read-only, and names are relative", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-scan-"));
  mkdirSync(join(dir, "sub"));
  writeTmp("one.3mf", build3mf({ plates: [{ index: 1 }], project: P1S_PROJECT }), dir);
  writeTmp("two.3MF", build3mf({ plates: [{ index: 1 }] }), join(dir, "sub"));
  writeTmp("notes.txt", Buffer.from("x"), dir);
  const files = scanFolder(dir);
  assert.deepEqual(
    files.map((f) => f.name),
    ["one.3mf", "sub/two.3MF"],
  );
  assert.ok(files.every((f) => f.meta !== null));
});

test("a foreign printer with no sliced file falls back to an unsliced file saved for it, labelled", () => {
  const savedX2d = meta(null, null, 0);
  savedX2d.project.printerModel = "Bambu Lab X2D";
  const sel = selectSample([
    { name: "plain.3mf", meta: meta(null, null, 0) },
    { name: "x2d-saved.3mf", meta: savedX2d },
  ]);
  const entry = sel.sample.find((s) => s.name === "x2d-saved.3mf");
  assert.ok(entry.roles.includes("foreign-X2D"));
  assert.match(entry.reasons[entry.roles.indexOf("foreign-X2D")], /saved for Bambu Lab X2D .*not sliced/);
  assert.ok(sel.missing.some((m) => m.startsWith("foreign-X2D sliced")));
  assert.equal(sel.counts.savedForByPrinter["Bambu Lab X2D"], 1);
});
