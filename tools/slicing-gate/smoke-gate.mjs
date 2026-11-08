#!/usr/bin/env node
// CI smoke checks for the two gate-tool bugs of Hades run 3 (2026-11-08), run
// inside the built gate image with the gate's own hardening (no network,
// read-only root, a tmpfs /work, no capabilities). No designer file is used:
// the only model is a 20 mm cube this script writes.
//
//   node smoke-gate.mjs switch --out <file> [--control]
//       Orca writes two crafted two-plate cube projects, one saved for P1S
//       (process 0.20mm Standard @BBL X1C) and one saved for A1, from the
//       pinned presets. The gate then plans and slices them exactly as on
//       Hades (gate.mjs plan and slice, every plate on P1S, X1 Carbon and
//       A1). Passes when every plate gets a time and a weight above zero.
//       With --control (CI hides Orca's process_full folder with a tmpfs,
//       which is the image as it was for run 3), it passes only when the
//       cross-printer slices fail the way run 3 did: code -3 naming
//       process_full, with every own-printer slice fine.
//   node smoke-gate.mjs compare <fixed.json> <control.json>
//       Own-printer slices must give the same time and weight with and
//       without process_full, so the folder changes nothing for them.
//   node smoke-gate.mjs checks
//       Runs gate.mjs checks and judges landrun's report item (g): same-dir
//       import works, outside import blocked, the control without landrun
//       works, and no landrun call fails on its own flags. The T11 --ro form
//       is run and its result printed, not judged.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { flattenPreset, genericFilamentFor, loadIndex } from "./flatten-profiles.mjs";
import { isMain } from "./lib/is-main.mjs";

const ORCA = "/opt/orca/AppRun";
const GATE = "/opt/gate/gate.mjs";
const PROFILES = "/opt/orca-profiles";
const ORCA_SECONDS = 600;

export const SOURCES = Object.freeze([
  Object.freeze({ label: "P1S", machine: "Bambu Lab P1S 0.4 nozzle", file: "cube-saved-for-p1s.3mf" }),
  Object.freeze({ label: "A1", machine: "Bambu Lab A1 0.4 nozzle", file: "cube-saved-for-a1.3mf" }),
]);

/** A closed 20 mm cube as ASCII STL, outward normals, two triangles a face. */
export function cubeStl(size = 20) {
  const s = size;
  const faces = [
    [[0, 0, -1], [[0, 0, 0], [0, s, 0], [s, s, 0], [s, 0, 0]]],
    [[0, 0, 1], [[0, 0, s], [s, 0, s], [s, s, s], [0, s, s]]],
    [[0, -1, 0], [[0, 0, 0], [s, 0, 0], [s, 0, s], [0, 0, s]]],
    [[0, 1, 0], [[0, s, 0], [0, s, s], [s, s, s], [s, s, 0]]],
    [[-1, 0, 0], [[0, 0, 0], [0, 0, s], [0, s, s], [0, s, 0]]],
    [[1, 0, 0], [[s, 0, 0], [s, s, 0], [s, s, s], [s, 0, s]]],
  ];
  const lines = ["solid cube"];
  for (const [n, [a, b, c, d]] of faces) {
    for (const tri of [
      [a, b, c],
      [a, c, d],
    ]) {
      lines.push(`  facet normal ${n.join(" ")}`, "    outer loop");
      for (const v of tri) lines.push(`      vertex ${v.join(" ")}`);
      lines.push("    endloop", "  endfacet");
    }
  }
  lines.push("endsolid cube");
  return `${lines.join("\n")}\n`;
}

/** Orca's --load-assemble-list: one cube on plate 1, two on plate 2. */
export function assembleList(stlPath) {
  const plate = (n, count) => ({
    plate_name: `Plate ${n}`,
    need_arrange: true,
    objects: [{ path: stlPath, count, filaments: [1] }],
  });
  return { plates: [plate(1, 1), plate(2, 2)] };
}

const MISSING_PROCESS_FULL = /can not find setting file: \S*\/process_full\//;

/** One row per planned job, naming the printer its file was saved for. */
export function rowsFrom(plan, results, logs, sources = SOURCES) {
  return plan.jobs.map((job) => {
    const src = sources.find((s) => s.file === job.file);
    const r = results[job.id] ?? null;
    return {
      id: job.id,
      file: job.file,
      savedFor: src ? src.machine : null,
      printer: job.printer,
      plate: job.plate,
      cross: src ? job.printer !== src.machine : null,
      returnCode: r?.returnCode ?? null,
      timeSeconds: r?.timeSeconds ?? null,
      weightGrams: r?.weightGrams ?? null,
      missingProcessFull: MISSING_PROCESS_FULL.test(logs[job.id] ?? ""),
    };
  });
}

const sliced = (r) => r.returnCode === 0 && r.timeSeconds > 0 && r.weightGrams > 0;
const describe = (r) => `${r.file} on ${r.printer}, plate ${r.plate}: code ${r.returnCode}, time ${r.timeSeconds}, weight ${r.weightGrams}`;

function coverage(rows) {
  const problems = [];
  const files = [...new Set(rows.map((r) => r.file))];
  for (const file of files) {
    const mine = rows.filter((r) => r.file === file);
    if (!mine.some((r) => r.cross)) problems.push(`${file}: no cross-printer slice ran`);
    if (!mine.some((r) => r.cross === false)) problems.push(`${file}: no own-printer slice ran`);
    const plates = new Set(mine.map((r) => r.plate));
    if (!plates.has(1) || !plates.has(2)) problems.push(`${file}: plates ${[...plates].join(",")} ran, not 1 and 2`);
  }
  return problems;
}

/** The image as fixed: every plate on every printer sliced, time and weight above zero. */
export function judgeFixed(rows) {
  if (rows.length === 0) return { pass: false, problems: ["no slice ran"] };
  const problems = [...rows.filter((r) => !sliced(r)).map(describe), ...coverage(rows)];
  return { pass: problems.length === 0, problems };
}

/** process_full hidden: must fail as run 3 did, and only that way. */
export function judgeControl(rows) {
  if (rows.length === 0) return { pass: false, problems: ["no slice ran"] };
  const problems = [...coverage(rows)];
  for (const r of rows.filter((x) => !sliced(x))) {
    if (!r.cross) problems.push(`own-printer slice failed: ${describe(r)}`);
    else if (r.returnCode !== -3 || !r.missingProcessFull) problems.push(`failed, but not as run 3 did (code -3 naming process_full): ${describe(r)}`);
  }
  if (!rows.some((r) => r.cross && r.returnCode === -3 && r.missingProcessFull)) {
    problems.push("no cross-printer slice failed with code -3 naming process_full, so the control did not reproduce run 3");
  }
  return { pass: problems.length === 0, problems };
}

/** Own-printer rows must match exactly between the fixed run and the control. */
export function compareOwn(fixedRows, controlRows) {
  const own = fixedRows.filter((r) => r.cross === false);
  if (own.length === 0) return { pass: false, problems: ["no own-printer slice in the fixed run"] };
  const problems = [];
  for (const a of own) {
    const b = controlRows.find((r) => r.file === a.file && r.printer === a.printer && r.plate === a.plate);
    if (!b) problems.push(`${a.file} on ${a.printer}, plate ${a.plate}: no control row`);
    else if (a.timeSeconds !== b.timeSeconds || a.weightGrams !== b.weightGrams) {
      problems.push(
        `${a.file} on ${a.printer}, plate ${a.plate}: time ${a.timeSeconds} vs ${b.timeSeconds}, weight ${a.weightGrams} vs ${b.weightGrams} (with vs without process_full)`,
      );
    }
  }
  return { pass: problems.length === 0, problems };
}

/** Report item (g) as gate.mjs checks writes it. */
export function judgeChecks(checks) {
  const lr = checks?.landrun ?? null;
  if (!lr) return { pass: false, problems: ["checks.json has no landrun result"], notes: [] };
  const problems = [];
  for (const name of ["inside", "escape", "planFormRo"]) {
    const call = lr[name] ?? {};
    const text = `${call.stderrTail ?? ""}\n${call.stdoutTail ?? ""}`;
    if (/flag provided but not defined/.test(text)) problems.push(`landrun ${name}: landrun rejected its arguments (${text.trim().split("\n").at(-1)})`);
  }
  if (!lr.sameDirImportWorks) problems.push("landrun: the same-dir import did not render");
  if (!lr.outsideImportBlocked) problems.push("landrun: the import from outside the job folder was NOT blocked");
  if (!lr.controlProvesSandbox) problems.push("landrun: the same import without landrun failed too, so the control proves nothing");
  const plan = lr.planFormRo ?? {};
  const notes = [
    `kernel ${lr.kernel}; ${(lr.abiLog ?? []).join(" | ") || "no ABI line logged"}`,
    `T11 form (--ro on the OpenSCAD tree): ${plan.producedStl ? "works" : `does not run (exit ${plan.exit})`}`,
  ];
  return { pass: problems.length === 0, problems, notes };
}

// ---------------------------------------------------------------- in the image

function scratchEnv(dir) {
  for (const sub of ["home/.config", "home/.cache", "home/.local/share", "tmp"]) mkdirSync(join(dir, sub), { recursive: true });
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: join(dir, "home"),
    TMPDIR: join(dir, "tmp"),
    XDG_CONFIG_HOME: join(dir, "home", ".config"),
    XDG_CACHE_HOME: join(dir, "home", ".cache"),
    XDG_DATA_HOME: join(dir, "home", ".local", "share"),
    XDG_RUNTIME_DIR: join(dir, "tmp"),
    MESA_SHADER_CACHE_DISABLE: "true",
    LANG: "C.UTF-8",
  };
}

function runOrFail(what, cmd, args, options) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, killSignal: "SIGKILL", ...options });
  if (r.status !== 0) {
    const tail = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim().split("\n").slice(-30).join("\n");
    throw new Error(`${what} failed (exit ${r.status}, signal ${r.signal}${r.error ? `, ${r.error.message}` : ""}):\n${tail}`);
  }
  return r;
}

const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

/** Orca writes one crafted cube project saved for src.machine into sampleDir. */
function exportCube(index, src, root, stl, sampleDir) {
  const dir = join(root, "fixtures", src.label);
  mkdirSync(join(dir, "data"), { recursive: true });
  const machine = flattenPreset(index, "machine", src.machine).profile;
  const processName = machine.default_print_profile;
  const processPreset = flattenPreset(index, "process", processName).profile;
  const pla = genericFilamentFor(index, src.machine, "PLA");
  if (!pla) throw new Error(`no generic PLA preset for ${src.machine}`);
  const filament = flattenPreset(index, "filament", pla.name).profile;
  const files = { machine: join(dir, "machine.json"), process: join(dir, "process.json"), filament: join(dir, "filament.json") };
  writeJson(files.machine, machine);
  writeJson(files.process, processPreset);
  writeJson(files.filament, filament);
  writeJson(join(dir, "assemble.json"), assembleList(stl));
  runOrFail(`Orca export of ${src.file}`, ORCA, [
    "--datadir",
    join(dir, "data"),
    "--load-settings",
    `${files.machine};${files.process}`,
    "--load-filaments",
    files.filament,
    "--load-assemble-list",
    join(dir, "assemble.json"),
    "--export-3mf",
    src.file,
    "--outputdir",
    sampleDir,
  ], { env: scratchEnv(join(dir, "scratch")), cwd: dir, timeout: ORCA_SECONDS * 1000 });
  if (!existsSync(join(sampleDir, src.file))) throw new Error(`Orca exited 0 but wrote no ${src.file}`);
  return { file: src.file, savedFor: src.machine, process: processName, filament: pla.name };
}

function switchCommand(outFile, control) {
  const root = join(process.env.HOME ?? "/work", "smoke-switch");
  const inDir = join(root, "in");
  const sampleDir = join(inDir, "sample");
  const out = join(root, "out");
  const work = join(root, "work");
  for (const d of [sampleDir, out, work, join(root, "fixtures")]) mkdirSync(d, { recursive: true });
  const stl = join(root, "fixtures", "cube.stl");
  writeFileSync(stl, cubeStl());

  const index = loadIndex(PROFILES);
  const exports = SOURCES.map((src) => exportCube(index, src, root, stl, sampleDir));
  writeJson(join(inDir, "selection.json"), {
    sample: SOURCES.map((s) => ({ name: s.file, roles: [`crafted cube saved for ${s.label}`], reasons: ["CI smoke check"] })),
    comparison: [],
    missing: [],
    unknownPrinter: [],
  });

  const env = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: process.env.HOME ?? "/work", GATE_IN: inDir, GATE_OUT: out, GATE_WORK: work };
  process.stdout.write(runOrFail("gate.mjs plan", "node", [GATE, "plan"], { env }).stdout);
  const ids = readFileSync(join(out, "jobs.txt"), "utf8").split("\n").filter(Boolean);
  for (const id of ids) spawnSync("node", [GATE, "slice", id], { env, stdio: "inherit" });

  const plan = JSON.parse(readFileSync(join(out, "plan.json"), "utf8"));
  const results = {};
  const logs = {};
  for (const f of readdirSync(join(out, "jobs"))) {
    if (f.endsWith(".json")) results[f.slice(0, -5)] = JSON.parse(readFileSync(join(out, "jobs", f), "utf8"));
    if (f.endsWith(".log")) logs[f.slice(0, -4)] = readFileSync(join(out, "jobs", f), "utf8");
  }
  const rows = rowsFrom(plan, results, logs);
  const judged = control ? judgeControl(rows) : judgeFixed(rows);
  const mode = control ? "control (process_full hidden)" : "fixed";
  writeJson(outFile, { mode, exports, setupErrors: plan.errors, rows, judged });

  process.stdout.write(`\nsmoke switch, ${mode}: ${rows.length} plate slices\n`);
  for (const e of exports) process.stdout.write(`  ${e.file}: saved for ${e.savedFor}, process ${e.process}, filament ${e.filament}\n`);
  for (const e of plan.errors ?? []) process.stdout.write(`  setup error: ${e}\n`);
  for (const r of rows) {
    const what = sliced(r)
      ? `ok, time ${r.timeSeconds} s, weight ${r.weightGrams} g`
      : `code ${r.returnCode}${r.missingProcessFull ? " (process_full file missing)" : ""}`;
    process.stdout.write(`  ${r.cross ? "cross" : "own  "} ${r.file} -> ${r.printer}, plate ${r.plate}: ${what}\n`);
  }
  for (const p of judged.problems) process.stdout.write(`  PROBLEM: ${p}\n`);
  process.stdout.write(`smoke switch, ${mode}: ${judged.pass ? "PASS" : "FAIL"}\n`);
  return judged.pass;
}

function checksCommand() {
  const root = join(process.env.HOME ?? "/work", "smoke-checks");
  const out = join(root, "out");
  const work = join(root, "work");
  for (const d of [out, work]) mkdirSync(d, { recursive: true });
  const env = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: process.env.HOME ?? "/work", GATE_OUT: out, GATE_WORK: work };
  process.stdout.write(runOrFail("gate.mjs checks", "node", [GATE, "checks"], { env }).stdout);
  const checks = JSON.parse(readFileSync(join(out, "checks.json"), "utf8"));
  const judged = judgeChecks(checks);
  const lr = checks.landrun ?? {};
  for (const name of ["inside", "escape", "controlWithoutSandbox", "planFormRo"]) {
    const c = lr[name];
    if (!c) continue;
    const last = (c.stderrTail ?? "").trim().split("\n").at(-1);
    process.stdout.write(`  landrun ${name}: exit ${c.exit}, STL ${c.producedStl ? "written" : "not written"}${last ? `; stderr: ${last}` : ""}\n`);
  }
  for (const n of judged.notes) process.stdout.write(`  ${n}\n`);
  for (const p of judged.problems) process.stdout.write(`  PROBLEM: ${p}\n`);
  process.stdout.write(`smoke checks, landrun item (g): ${judged.pass ? "PASS" : "FAIL"}\n`);
  return judged.pass;
}

function compareCommand(fixedFile, controlFile) {
  const a = JSON.parse(readFileSync(fixedFile, "utf8")).rows ?? [];
  const b = JSON.parse(readFileSync(controlFile, "utf8")).rows ?? [];
  const judged = compareOwn(a, b);
  for (const r of a.filter((x) => x.cross === false)) {
    process.stdout.write(`  own ${r.file} -> ${r.printer}, plate ${r.plate}: time ${r.timeSeconds} s, weight ${r.weightGrams} g\n`);
  }
  for (const p of judged.problems) process.stdout.write(`  PROBLEM: ${p}\n`);
  process.stdout.write(`smoke compare, own-printer slices with and without process_full: ${judged.pass ? "identical" : "DIFFERENT"}\n`);
  return judged.pass;
}

if (isMain(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    let pass;
    if (cmd === "switch") {
      const at = rest.indexOf("--out");
      if (at === -1 || !rest[at + 1]) throw new Error("usage: smoke-gate.mjs switch --out <file> [--control]");
      pass = switchCommand(rest[at + 1], rest.includes("--control"));
    } else if (cmd === "checks") pass = checksCommand();
    else if (cmd === "compare" && rest.length === 2) pass = compareCommand(rest[0], rest[1]);
    else throw new Error("usage: smoke-gate.mjs switch --out <file> [--control] | checks | compare <fixed.json> <control.json>");
    process.exitCode = pass ? 0 : 1;
  } catch (err) {
    process.stderr.write(`smoke-gate ${cmd ?? ""}: ${err.message}\n`);
    process.exitCode = 2;
  }
}
