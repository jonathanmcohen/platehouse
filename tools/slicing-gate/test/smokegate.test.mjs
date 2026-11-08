// The CI smoke checks that prove, before Hades, the two run 3 gate bugs are
// fixed: a crafted cube 3MF saved for one printer and sliced on another
// (report item a, Orca code -3), and the landrun checks (item g). These
// tests cover the smoke script's own logic; CI runs it in the built image.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(HERE, "smoke-gate.mjs");
const load = () => import(SCRIPT);

const P1S = "Bambu Lab P1S 0.4 nozzle";
const X1C = "Bambu Lab X1 Carbon 0.4 nozzle";
const A1 = "Bambu Lab A1 0.4 nozzle";

test("the smoke files are saved for P1S and for A1, and sliced on every selected printer", async () => {
  const s = await load();
  assert.deepEqual(
    s.SOURCES.map((x) => x.machine),
    [P1S, A1],
  );
  for (const x of s.SOURCES) assert.match(x.file, /^cube-saved-for-[a-z0-9]+\.3mf$/);
});

test("the cube is a closed 20 mm ASCII STL of 12 facets and no designer content", async () => {
  const { cubeStl } = await load();
  const stl = cubeStl();
  assert.match(stl, /^solid cube\n/);
  assert.match(stl, /endsolid cube\n$/);
  assert.equal((stl.match(/facet normal/g) ?? []).length, 12);
  const vertices = [...stl.matchAll(/vertex (\S+) (\S+) (\S+)/g)].map((m) => m.slice(1).map(Number));
  assert.equal(vertices.length, 36);
  for (const v of vertices) for (const c of v) assert.ok(c === 0 || c === 20, `corner value ${c}`);
  // Closed: every edge is shared by exactly two triangles.
  const edges = new Map();
  for (let t = 0; t < 36; t += 3) {
    for (const [a, b] of [
      [0, 1],
      [1, 2],
      [2, 0],
    ]) {
      const key = [vertices[t + a].join(","), vertices[t + b].join(",")].sort().join("|");
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  for (const [edge, n] of edges) assert.equal(n, 2, edge);
});

test("the assemble list puts one cube on plate 1 and two on plate 2, arranged by Orca", async () => {
  const { assembleList } = await load();
  const list = assembleList("/work/smoke/fixtures/cube.stl");
  assert.equal(list.plates.length, 2);
  assert.deepEqual(
    list.plates.map((p) => p.objects.map((o) => o.count)),
    [[1], [2]],
  );
  for (const p of list.plates) {
    assert.equal(p.need_arrange, true);
    assert.equal(typeof p.plate_name, "string");
    for (const o of p.objects) {
      assert.equal(o.path, "/work/smoke/fixtures/cube.stl");
      assert.deepEqual(o.filaments, [1]);
    }
  }
});

const SOURCES = [
  { label: "P1S", machine: P1S, file: "cube-saved-for-p1s.3mf" },
  { label: "A1", machine: A1, file: "cube-saved-for-a1.3mf" },
];

function planAndResults(outcome) {
  const jobs = [];
  const results = {};
  const logs = {};
  let n = 0;
  for (const src of SOURCES) {
    for (const printer of [P1S, X1C, A1]) {
      for (const plate of [1, 2]) {
        const id = `j${String(++n).padStart(4, "0")}`;
        jobs.push({ id, file: src.file, printer, plate });
        const r = outcome(src.machine, printer, plate);
        results[id] = r.result;
        logs[id] = r.log ?? "";
      }
    }
  }
  return { plan: { jobs }, results, logs };
}

const ok = (time = 600, weight = 3.2) => ({ result: { returnCode: 0, timeSeconds: time, weightGrams: weight } });
const missing = (name) => ({
  result: { returnCode: -3, timeSeconds: null, weightGrams: null },
  log: `load_config_file: can not find setting file: /opt/orca/resources/profiles/BBL/process_full/${name}.json`,
});

test("rows name the printer each file was saved for and mark the cross-printer slices", async () => {
  const { rowsFrom } = await load();
  const { plan, results, logs } = planAndResults(() => ok());
  const rows = rowsFrom(plan, results, logs, SOURCES);
  assert.equal(rows.length, 12);
  const crossPairs = rows.filter((r) => r.cross).map((r) => `${r.savedFor} -> ${r.printer}`);
  assert.equal(crossPairs.length, 8);
  assert.ok(crossPairs.includes(`${P1S} -> ${A1}`));
  assert.ok(crossPairs.includes(`${A1} -> ${X1C}`));
  assert.equal(rows.filter((r) => !r.cross).length, 4);
});

test("the fixed image passes only when every plate on every printer has a time and a weight above zero", async () => {
  const { rowsFrom, judgeFixed } = await load();
  const good = planAndResults(() => ok());
  assert.deepEqual(judgeFixed(rowsFrom(good.plan, good.results, good.logs, SOURCES)), { pass: true, problems: [] });

  const bug = planAndResults((saved, printer) => (saved === P1S && printer === A1 ? missing("0.20mm Standard @BBL A1") : ok()));
  const judged = judgeFixed(rowsFrom(bug.plan, bug.results, bug.logs, SOURCES));
  assert.equal(judged.pass, false);
  assert.equal(judged.problems.length, 2, judged.problems.join("\n"));
  assert.match(judged.problems[0], /cube-saved-for-p1s\.3mf on Bambu Lab A1 0\.4 nozzle, plate 1: code -3/);

  const zero = planAndResults((saved, printer, plate) => (plate === 2 && printer === X1C ? ok(600, 0) : ok()));
  assert.equal(judgeFixed(rowsFrom(zero.plan, zero.results, zero.logs, SOURCES)).pass, false);

  const crashed = planAndResults((saved, printer) => (printer === P1S ? { result: undefined } : ok()));
  assert.equal(judgeFixed(rowsFrom(crashed.plan, crashed.results, crashed.logs, SOURCES)).pass, false);

  assert.equal(judgeFixed([]).pass, false, "no slice at all is a failure");
});

test("the control run (process_full hidden) must reproduce run 3: cross-printer -3 naming process_full, own printer fine", async () => {
  const { rowsFrom, judgeControl } = await load();
  const run3 = planAndResults((saved, printer) => {
    if (saved === P1S && printer === A1) return missing("0.20mm Standard @BBL A1");
    if (saved === A1 && printer !== A1) return missing("0.20mm Standard @BBL X1C");
    return ok();
  });
  assert.deepEqual(judgeControl(rowsFrom(run3.plan, run3.results, run3.logs, SOURCES)), { pass: true, problems: [] });

  // Nothing failed: the control did not reproduce the bug, so it proves nothing.
  const none = planAndResults(() => ok());
  assert.equal(judgeControl(rowsFrom(none.plan, none.results, none.logs, SOURCES)).pass, false);

  // An own-printer failure, or a failure for another reason, is not run 3.
  const own = planAndResults((saved, printer) => (saved === printer ? missing("x") : ok()));
  assert.equal(judgeControl(rowsFrom(own.plan, own.results, own.logs, SOURCES)).pass, false);
  const other = planAndResults((saved, printer) =>
    saved === P1S && printer === A1 ? { result: { returnCode: -50, timeSeconds: null, weightGrams: null } } : ok(),
  );
  assert.equal(judgeControl(rowsFrom(other.plan, other.results, other.logs, SOURCES)).pass, false);
});

test("own-printer slices must come out the same with and without the process_full folder", async () => {
  const { rowsFrom, compareOwn } = await load();
  const fixed = planAndResults(() => ok(600, 3.2));
  const control = planAndResults((saved, printer) => (saved !== printer ? missing("y") : ok(600, 3.2)));
  const a = rowsFrom(fixed.plan, fixed.results, fixed.logs, SOURCES);
  const b = rowsFrom(control.plan, control.results, control.logs, SOURCES);
  assert.deepEqual(compareOwn(a, b), { pass: true, problems: [] });
  const drift = planAndResults((saved, printer) => (saved === printer ? ok(601, 3.2) : missing("y")));
  const c = rowsFrom(drift.plan, drift.results, drift.logs, SOURCES);
  const judged = compareOwn(a, c);
  assert.equal(judged.pass, false);
  assert.equal(judged.problems.length, 4);
  assert.equal(compareOwn(a, []).pass, false, "a missing control row is a failure");
});

const landrunResult = (overrides = {}) => ({
  kernel: "6.11.0",
  abiLog: [],
  inside: { exit: 0, stderrTail: "", producedStl: true },
  escape: { exit: 1, stderrTail: "Can't open import file", producedStl: false },
  controlWithoutSandbox: { exit: 0, stderrTail: "", producedStl: true },
  planFormRo: { exit: 1, stderrTail: "permission denied", producedStl: false },
  sameDirImportWorks: true,
  outsideImportBlocked: true,
  controlProvesSandbox: true,
  pass: true,
  ...overrides,
});

test("the landrun smoke passes on item (g) as the report reads it, with the T11 form run and recorded", async () => {
  const { judgeChecks } = await load();
  const judged = judgeChecks({ landrun: landrunResult() });
  assert.equal(judged.pass, true, judged.problems.join("\n"));
  assert.match(judged.notes.join("\n"), /T11 form .*--ro.*: does not run \(exit 1\)/);
});

test("the landrun smoke fails on run 3's flag error, an import that is not blocked, or a control that proves nothing", async () => {
  const { judgeChecks } = await load();
  const flagError = { exit: 1, stderrTail: "flag provided but not defined: -o", producedStl: false };
  for (const bad of [
    { inside: flagError, sameDirImportWorks: false, pass: false },
    { escape: { ...flagError } },
    { planFormRo: { ...flagError } },
    { outsideImportBlocked: false, escape: { exit: 0, stderrTail: "", producedStl: true }, pass: false },
    { controlProvesSandbox: false, pass: false },
  ]) {
    assert.equal(judgeChecks({ landrun: landrunResult(bad) }).pass, false, JSON.stringify(bad));
  }
  assert.equal(judgeChecks({ landrun: null }).pass, false);
});

test("compare on the command line exits 0 on matching own-printer rows and 1 on a difference", async () => {
  const { rowsFrom } = await load();
  const dir = mkdtempSync(join(tmpdir(), "gate-smoke-"));
  const fixed = planAndResults(() => ok());
  const control = planAndResults((saved, printer) => (saved !== printer ? missing("z") : ok()));
  const drift = planAndResults((saved, printer) => (saved !== printer ? missing("z") : ok(999)));
  const write = (name, x) => {
    const file = join(dir, name);
    writeFileSync(file, JSON.stringify({ rows: rowsFrom(x.plan, x.results, x.logs, SOURCES) }));
    return file;
  };
  const a = write("fixed.json", fixed);
  const same = spawnSync(process.execPath, [SCRIPT, "compare", a, write("control.json", control)], { encoding: "utf8" });
  assert.equal(same.status, 0, same.stdout + same.stderr);
  const differs = spawnSync(process.execPath, [SCRIPT, "compare", a, write("drift.json", drift)], { encoding: "utf8" });
  assert.equal(differs.status, 1, differs.stdout + differs.stderr);
});
