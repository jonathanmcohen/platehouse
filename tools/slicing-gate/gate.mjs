#!/usr/bin/env node
// The slicing gate's in-container driver. run.sh calls it once per step, each
// time in a fresh network-less, read-only container:
//
//   node gate.mjs plan          read the sample, flatten profiles, write the job list
//   node gate.mjs slice <id>    one Orca call for one plate, under /usr/bin/time -v
//   node gate.mjs checks        OpenSCAD (f), landrun (g) and STEP (h)
//   node gate.mjs report        result.json and summary.txt, with the pass rule
//
// Mounts it expects: /in (read-only: selection.json and sample/), /out
// (read-write, small result files only), /work (tmpfs scratch).
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { classifyPlate, gateVerdict, parseTimeV, pctDiff, proposeLimits, summarise } from "./lib/classify.mjs";
import { loadIndex, writeRecipe } from "./flatten-profiles.mjs";
import { meshesToGlb } from "./lib/glb.mjs";
import { isMain } from "./lib/is-main.mjs";
import { MODEL_IDS, SELECTED_PRINTERS } from "./lib/printers.mjs";
import { readProjectMeta } from "./lib/threemf.mjs";

// GATE_IN, GATE_OUT, GATE_WORK and GATE_ORCA_PROFILES exist so the test
// suite can run plan and report outside the image; run.sh never sets them.
const env = process.env;
export const PATHS = Object.freeze({
  in: env.GATE_IN ?? "/in",
  sample: join(env.GATE_IN ?? "/in", "sample"),
  out: env.GATE_OUT ?? "/out",
  work: env.GATE_WORK ?? "/work",
  orca: "/opt/orca/AppRun",
  // Orca's BBL profile JSON from its source at v2.5.0 (see the Dockerfile);
  // the AppImage itself ships the presets only as binary .opc caches.
  orcaProfiles: env.GATE_ORCA_PROFILES ?? "/opt/orca-profiles",
  openscad: "/opt/openscad/AppRun",
  openscadDir: "/opt/openscad",
  landrun: "/usr/local/bin/landrun",
  gateSamples: "/opt/gate/samples",
  occt: "/opt/gate/node_modules/occt-import-js",
});
export const MSTPP = 600;
export const KILL_SECONDS = 900;

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

// ---------------------------------------------------------------- plan

/**
 * Jobs from the selection: every sample file x each selected printer x every
 * plate, plus every sliced plate of every comparison file on its own printer.
 * A job that is both is run once and carries both kinds.
 */
export function buildJobs(selection, metas, recipe) {
  const jobs = [];
  const byKey = new Map();
  const errors = [];
  const add = (file, printer, plate, kind, bambu) => {
    const key = `${file}\u0000${printer}\u0000${plate}`;
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.kinds.includes(kind)) existing.kinds.push(kind);
      if (bambu && !existing.bambu) existing.bambu = bambu;
      return;
    }
    const meta = metas[file];
    const types = meta.project?.filamentTypes ?? [];
    const machine = recipe.printers[printer] ?? null;
    if (!machine && !errors.some((e) => e.includes(printer))) {
      errors.push(`no flattened machine preset for ${printer}; its jobs cannot run`);
    }
    const mapping = recipe.filaments[printer] ?? {};
    const job = {
      id: `j${String(jobs.length + 1).padStart(4, "0")}`,
      file,
      plate,
      printer,
      kinds: [kind],
      machineFile: machine ? machine.file : null,
      filamentFiles: types.map((t) => mapping[t]?.file ?? ""),
      filamentProfiles: types.map((t) => mapping[t]?.name ?? null),
      unmappedTypes: [...new Set(types.filter((t) => !mapping[t]))],
      bambu: bambu ?? null,
      inputBytes: meta.inputBytes ?? null,
    };
    jobs.push(job);
    byKey.set(key, job);
  };
  for (const s of selection.sample) {
    for (const printer of SELECTED_PRINTERS) {
      for (const p of metas[s.name].plates) add(s.name, printer, p.index, "selected", null);
    }
  }
  for (const c of selection.comparison) {
    const meta = metas[c.name];
    for (const index of c.slicedPlates) {
      const p = meta.plates.find((x) => x.index === index);
      if (!p) continue;
      add(c.name, c.printer, index, "own", {
        timeSeconds: p.predictionSeconds,
        weightGrams: p.weightGrams,
        filaments: p.filaments,
      });
    }
  }
  return { jobs, errors };
}

function planCommand() {
  const selection = readJson(join(PATHS.in, "selection.json"));
  const names = [...new Set([...selection.sample.map((s) => s.name), ...selection.comparison.map((c) => c.name)])];
  const metas = {};
  const inspect = [];
  const missing = [];
  for (const name of names) {
    const file = join(PATHS.sample, name);
    if (!existsSync(file)) {
      missing.push(name);
      continue;
    }
    const meta = readProjectMeta(file);
    if (!meta) {
      missing.push(`${name} (no Bambu plate data)`);
      continue;
    }
    meta.inputBytes = statSync(file).size;
    metas[name] = meta;
    inspect.push({
      name,
      plates: meta.plates.length,
      slicedPlates: meta.plates.filter((p) => p.sliced).length,
      slicedFor: meta.slicedFor,
      project: meta.project,
      keys: meta.keys,
      inputBytes: meta.inputBytes,
    });
  }
  if (missing.length) {
    process.stderr.write(`gate plan: these selected files are not in /in/sample: ${missing.join("; ")}\n`);
    process.exit(2);
  }
  const types = [...new Set(Object.values(metas).flatMap((m) => m.project.filamentTypes))].sort();
  const printers = [...new Set([...SELECTED_PRINTERS, ...selection.comparison.map((c) => c.printer)])];
  const index = loadIndex(PATHS.orcaProfiles);
  const known = [];
  const errors = [];
  for (const p of printers) {
    if (index.vendor.machine.has(p)) known.push(p);
    else errors.push(`no bundled machine preset named ${p}`);
  }
  const recipe = writeRecipe(index, join(PATHS.out, "profiles"), {
    printers: known,
    types,
    companions: process.env.GATE_COMPANIONS === "1",
  });
  const built = buildJobs(selection, metas, recipe);
  // Where the sample falls short of the plan's rule, and why each file was
  // picked, so the report says it and not only selection.json.
  const picked = {
    sample: selection.sample.map((s) => ({ name: s.name, roles: s.roles ?? [], reasons: s.reasons ?? [] })),
    missing: selection.missing ?? [],
    unknownPrinter: selection.unknownPrinter ?? [],
  };
  const plan = {
    createdAt: new Date().toISOString(),
    jobs: built.jobs,
    errors: [...errors, ...built.errors],
    inspect,
    recipe,
    selection: picked,
  };
  writeJson(join(PATHS.out, "plan.json"), plan);
  writeFileSync(join(PATHS.out, "jobs.txt"), `${built.jobs.map((j) => j.id).join("\n")}\n`);
  mkdirSync(join(PATHS.out, "jobs"), { recursive: true });
  process.stdout.write(`gate plan: ${names.length} files, ${built.jobs.length} plate slices, ${plan.errors.length} setup errors\n`);
}

// ---------------------------------------------------------------- slice

/** Orca's arguments for one job: one plate, statistics on, --mstpp 600. */
export function orcaArgs(job, { profiles, sample, outDir, dataDir }) {
  const args = [
    "--datadir",
    dataDir,
    "--slice",
    String(job.plate),
    "--export-statistics",
    "--mstpp",
    String(MSTPP),
    "--allow-newer-file",
    "--outputdir",
    outDir,
  ];
  if (job.machineFile) args.push("--load-settings", join(profiles, job.machineFile));
  if (job.filamentFiles.some((f) => f !== "")) {
    args.push("--load-filaments", job.filamentFiles.map((f) => (f === "" ? "" : join(profiles, f))).join(";"));
  }
  args.push(join(sample, job.file));
  return args;
}

function scratchEnv(dir) {
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

function makeScratch(dir) {
  for (const sub of ["home/.config", "home/.cache", "home/.local/share", "tmp", "out", "data"]) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
}

function dirBytes(dir) {
  let total = 0;
  if (!existsSync(dir)) return 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) total += dirBytes(p);
    else if (entry.isFile()) total += statSync(p).size;
  }
  return total;
}

function tail(file, lines = 20) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .slice(-lines)
    .map((l) => l.slice(0, 300));
}

function numberOrNull(v) {
  const n = typeof v === "number" ? v : Number.parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : null;
}

function sliceCommand(id) {
  const plan = readJson(join(PATHS.out, "plan.json"));
  const job = plan.jobs.find((j) => j.id === id);
  if (!job) throw new Error(`no job ${id}`);
  const dir = join(PATHS.work, id);
  makeScratch(dir);
  const outDir = join(dir, "out");
  const timeFile = join(dir, "time.txt");
  const logFile = join(dir, "orca.log");
  const record = { id, ranAt: new Date().toISOString() };
  if (!job.machineFile) {
    writeJson(join(PATHS.out, "jobs", `${id}.json`), { ...record, setupError: "no machine preset" });
    return;
  }
  const args = orcaArgs(job, { profiles: join(PATHS.out, "profiles"), sample: PATHS.sample, outDir, dataDir: join(dir, "data") });
  const fd = openSync(logFile, "w");
  spawnSync(
    "/usr/bin/time",
    ["-v", "-o", timeFile, "timeout", "--verbose", "-s", "KILL", String(KILL_SECONDS), PATHS.orca, ...args],
    { env: scratchEnv(dir), stdio: ["ignore", fd, fd], cwd: dir },
  );
  closeSync(fd);
  const time = parseTimeVFile(timeFile);
  const log = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
  const resultFile = join(outDir, "result.json");
  let result = null;
  try {
    result = existsSync(resultFile) ? readJson(resultFile) : null;
  } catch {
    result = null;
  }
  const statsFile = join(outDir, `plate_${job.plate}.statistics.json`);
  let stats = null;
  try {
    stats = existsSync(statsFile) ? readJson(statsFile) : null;
  } catch {
    stats = null;
  }
  const out = {
    ...record,
    returnCode: result ? numberOrNull(result.return_code) : null,
    errorString: result ? String(result.error_string ?? "").slice(0, 2000) : null,
    timeSeconds: stats ? numberOrNull(stats.summary?.time) : null,
    weightGrams: stats ? numberOrNull(stats.summary?.weight) : null,
    filamentGrams: stats ? (stats.summary?.filaments ?? []).map((f) => ({ slot: f.id, grams: numberOrNull(f.weight) })) : [],
    prepareSeconds: stats ? numberOrNull(stats.summary?.prepare_time) : null,
    wallSeconds: time.wallSeconds,
    peakRssBytes: time.peakRssBytes,
    exitStatus: time.exitStatus,
    signal: time.signal,
    timedOut: /timeout: sending signal/.test(log),
    workBytes: dirBytes(dir),
    result: result
      ? {
          layerHeight: numberOrNull(result.layer_height),
          wallLoops: numberOrNull(result.wall_loops),
          sparseInfillDensity: numberOrNull(result.sparse_infill_density),
          warnings: Array.isArray(result.warnings) ? result.warnings.length : null,
          slicedTime: numberOrNull(result.sliced_plates?.[0]?.sliced_time),
        }
      : null,
  };
  writeJson(join(PATHS.out, "jobs", `${id}.json`), out);
  // the log can name objects in the file; it stays in the scratch out dir only
  writeFileSync(join(PATHS.out, "jobs", `${id}.log`), `${tail(logFile, 40).join("\n")}\n`);
  rmSync(dir, { recursive: true, force: true });
}

function parseTimeVFile(file) {
  return parseTimeV(existsSync(file) ? readFileSync(file, "utf8") : "");
}

// ---------------------------------------------------------------- checks

function run(cmd, args, { cwd, env, seconds = 120 } = {}) {
  const started = process.hrtime.bigint();
  const r = spawnSync("timeout", ["-s", "KILL", String(seconds), cmd, ...args], {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    command: [cmd, ...args].join(" "),
    exit: r.status,
    signal: r.signal,
    ms: Number((process.hrtime.bigint() - started) / 1000000n),
    stdoutTail: (r.stdout ?? "").split("\n").slice(-25).join("\n"),
    stderrTail: (r.stderr ?? "").split("\n").slice(-25).join("\n"),
    error: r.error ? r.error.message : null,
  };
}

const fileSize = (p) => (existsSync(p) ? statSync(p).size : 0);

function openscadCheck(dir, env) {
  writeFileSync(join(dir, "cube.scad"), "cube([10, 10, 10]);\n");
  const info = run(PATHS.openscad, ["--info"], { cwd: dir, env });
  const stl = run(PATHS.openscad, ["-o", "cube.stl", "cube.scad"], { cwd: dir, env });
  const manifoldStl = run(PATHS.openscad, ["--backend=manifold", "-o", "cube-manifold.stl", "cube.scad"], { cwd: dir, env });
  const png = run(PATHS.openscad, ["--imgsize=256,256", "-o", "cube.png", "cube.scad"], { cwd: dir, env });
  const text = `${info.stdoutTail}\n${info.stderrTail}`;
  return {
    info: { exit: info.exit, ms: info.ms, glLines: text.split("\n").filter((l) => /GL|EGL|GLX|Manifold|manifold/.test(l)) },
    stl: { ...stl, bytes: fileSize(join(dir, "cube.stl")) },
    manifoldStl: { ...manifoldStl, bytes: fileSize(join(dir, "cube-manifold.stl")) },
    png: { ...png, bytes: fileSize(join(dir, "cube.png")) },
    rendersStl: stl.exit === 0 && fileSize(join(dir, "cube.stl")) > 0,
    rendersPng: png.exit === 0 && fileSize(join(dir, "cube.png")) > 0,
    mentionsManifold: /manifold/i.test(text),
    mentionsEgl: /EGL/.test(text),
  };
}

/**
 * The four landrun calls of report item (g), each as { name, args, command }:
 * args is landrun's whole argument list, command what landrun must run.
 *
 * landrun's flags end with "--" (Hades run 3, 2026-11-08: all three calls
 * failed with "flag provided but not defined: -o"). landrun v0.1.17 parses
 * with urfave/cli v3.6.2, which keeps reading flags after the command until
 * it meets "--" (command_parse.go), so OpenSCAD's own -o was taken as a
 * landrun flag. landrun's README writes every example as
 * landrun [flags] -- <command> [args].
 */
export function landrunInvocations(dir) {
  const sandboxEnv = [
    "--env",
    `HOME=${dir}`,
    "--env",
    `TMPDIR=${dir}`,
    "--env",
    "LANG=C.UTF-8",
    "--env",
    "PATH=/usr/bin:/bin",
  ];
  // --rox where something is executed or mapped (the OpenSCAD tree, the
  // loader and shared libraries, /bin for an AppRun script), --ro for fonts,
  // --rw only for this job's own directory.
  const sandbox = [
    "--best-effort",
    "--ignore-missing",
    "--rox",
    `${PATHS.openscadDir},/usr/lib,/lib,/lib64,/usr/lib64,/usr/bin,/bin`,
    "--ro",
    "/usr/share/fonts,/etc/fonts,/usr/share/fontconfig",
    "--rw",
    dir,
    ...sandboxEnv,
  ];
  // The form the plan wrote for T11 (--ro on the OpenSCAD tree), as evidence.
  const planForm = [
    "--best-effort",
    "--ro",
    `${PATHS.openscadDir},/usr/lib,/lib,/usr/share/fonts,/etc/fonts`,
    "--rw",
    dir,
    ...sandboxEnv,
  ];
  const scad = (file, out) => [PATHS.openscad, "-o", out, file];
  const call = (name, flags, command) => ({ name, args: [...flags, "--", ...command], command });
  return [
    call("inside", sandbox, scad("inside.scad", "inside.stl")),
    call("escape", sandbox, scad("escape.scad", "escape.stl")),
    call("planFormRo", planForm, scad("inside.scad", "planform.stl")),
    call("abi", ["--log-level", "debug", "--best-effort", "--rox", "/usr,/lib,/lib64"], ["/usr/bin/true"]),
  ];
}

function landrunCheck(env) {
  const dir = join(PATHS.work, `scad-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  const outside = join(PATHS.gateSamples, "outside.stl");
  copyFileSync(outside, join(dir, "inner.stl"));
  writeFileSync(join(dir, "inside.scad"), 'import("inner.stl");\n');
  writeFileSync(join(dir, "escape.scad"), `import("${outside}");\n`);
  const ran = {};
  for (const { name, args } of landrunInvocations(dir)) {
    ran[name] = run(PATHS.landrun, args, name === "abi" ? { env } : { cwd: dir, env });
  }
  const { inside, escape, planFormRo: planForm, abi } = ran;
  const control = run(PATHS.openscad, ["-o", "control.stl", "escape.scad"], { cwd: dir, env });
  const ok = (name) => fileSize(join(dir, name)) > 0;
  const result = {
    kernel: run("uname", ["-r"], { env }).stdoutTail.trim(),
    abiLog: abi.stderrTail.split("\n").filter((l) => /abi|ABI|landlock|Landlock/.test(l)),
    inside: { ...inside, producedStl: ok("inside.stl") },
    escape: { ...escape, producedStl: ok("escape.stl") },
    controlWithoutSandbox: { ...control, producedStl: ok("control.stl") },
    planFormRo: { ...planForm, producedStl: ok("planform.stl") },
  };
  result.sameDirImportWorks = result.inside.exit === 0 && result.inside.producedStl;
  result.outsideImportBlocked = !result.escape.producedStl;
  result.controlProvesSandbox = result.controlWithoutSandbox.producedStl;
  result.pass = result.sameDirImportWorks && result.outsideImportBlocked && result.controlProvesSandbox;
  rmSync(dir, { recursive: true, force: true });
  return result;
}

async function stepCheck(dir) {
  const sample = join(PATHS.gateSamples, "nist_ctc_01_asme1_rd.stp");
  const out = { sample: "NIST CTC-01 geometry only (nist_ctc_01_asme1_rd.stp)", inputBytes: fileSize(sample) };
  try {
    const require = createRequire(import.meta.url);
    const occt = await require(PATHS.occt)();
    const started = process.hrtime.bigint();
    const parsed = occt.ReadStepFile(new Uint8Array(readFileSync(sample)), null);
    const readMs = Number((process.hrtime.bigint() - started) / 1000000n);
    out.success = parsed.success === true;
    out.meshes = parsed.meshes?.length ?? 0;
    out.triangles = (parsed.meshes ?? []).reduce((n, m) => n + (m.index?.array?.length ?? 0) / 3, 0);
    const glb = meshesToGlb(parsed.meshes ?? []);
    out.totalMs = Number((process.hrtime.bigint() - started) / 1000000n);
    out.readMs = readMs;
    writeFileSync(join(dir, "nist.glb"), glb);
    out.glbBytes = glb.length;
    out.peakRssBytes = process.resourceUsage().maxRSS * 1024;
    out.pass = out.success && out.glbBytes > 0;
  } catch (err) {
    out.pass = false;
    out.error = String(err?.message ?? err).slice(0, 2000);
  }
  return out;
}

async function checksCommand() {
  const dir = join(PATHS.work, "checks");
  makeScratch(dir);
  const env = scratchEnv(dir);
  const checks = { ranAt: new Date().toISOString() };
  checks.openscad = openscadCheck(dir, env);
  checks.landrun = landrunCheck(env);
  checks.step = await stepCheck(dir);
  writeJson(join(PATHS.out, "checks.json"), checks);
  rmSync(dir, { recursive: true, force: true });
  process.stdout.write(
    `gate checks: openscad stl=${checks.openscad.rendersStl} png=${checks.openscad.rendersPng}; landrun=${checks.landrun.pass}; step=${checks.step.pass}\n`,
  );
}

// ---------------------------------------------------------------- report

function parsePercent(v) {
  const n = Number.parseFloat(String(v ?? "").replace("%", ""));
  return Number.isFinite(n) ? n : null;
}

const close = (a, b) => a !== null && b !== null && Math.abs(a - b) < 1e-6;

/** Builds the machine-readable report (items a to h) and the gate verdict. */
export function buildReport({ plan, results, hostExits, checks }) {
  const plates = plan.jobs.map((job) => {
    const r = results[job.id] ?? null;
    const host = hostExits[job.id];
    let c;
    if (r?.setupError) c = { verdict: "fail", reason: "setup", planReason: null, meaning: r.setupError };
    else if (!r) {
      c =
        host === 124 || host === 137
          ? classifyPlate({ hostKilled: true })
          : { verdict: "fail", reason: "crash", planReason: null, meaning: `no result recorded (container exit ${host ?? "unknown"})` };
    } else c = classifyPlate(r);
    return {
      id: job.id,
      file: job.file,
      printer: job.printer,
      plate: job.plate,
      kinds: job.kinds,
      filamentProfiles: job.filamentProfiles,
      unmappedTypes: job.unmappedTypes,
      returnCode: r?.returnCode ?? null,
      errorString: r?.errorString ?? null,
      timeSeconds: r?.timeSeconds ?? null,
      weightGrams: r?.weightGrams ?? null,
      filamentGrams: r?.filamentGrams ?? [],
      wallSeconds: r?.wallSeconds ?? null,
      peakRssBytes: r?.peakRssBytes ?? null,
      exitStatus: r?.exitStatus ?? null,
      bambu: job.bambu,
      ...c,
    };
  });

  const gapRows = plates
    .filter((p) => p.kinds.includes("own") && p.bambu && p.verdict === "ok")
    .map((p) => ({
      id: p.id,
      file: p.file,
      printer: p.printer,
      plate: p.plate,
      timePct: pctDiff(p.timeSeconds, p.bambu.timeSeconds),
      weightPct: pctDiff(p.weightGrams, p.bambu.weightGrams),
    }));
  const ownPlates = plates.filter((p) => p.kinds.includes("own"));

  const selectedFinished = plan.jobs.filter((j) => j.kinds.includes("selected") && results[j.id] && results[j.id].returnCode === 0);
  const survival = { kept: 0, changed: 0, unknown: 0, refusedProcessNotCompatible: 0 };
  const inspectByName = Object.fromEntries((plan.inspect ?? []).map((i) => [i.name, i]));
  for (const j of selectedFinished) {
    const r = results[j.id].result;
    const proj = inspectByName[j.file]?.project ?? null;
    if (!r || !proj) {
      survival.unknown++;
      continue;
    }
    const pairs = [
      [r.layerHeight, parsePercent(proj.layerHeight)],
      [r.wallLoops, parsePercent(proj.wallLoops)],
      [r.sparseInfillDensity, parsePercent(proj.sparseInfillDensity)],
    ];
    // A key missing on either side (result.json or project_settings) says
    // nothing about the process, so it is unknown, never a change.
    if (pairs.some(([a, b]) => a === null || a === undefined || b === null)) survival.unknown++;
    else if (pairs.every(([a, b]) => close(a, b))) survival.kept++;
    else survival.changed++;
  }
  survival.refusedProcessNotCompatible = plates.filter((p) => p.kinds.includes("selected") && p.returnCode === -17).length;

  const usedTypes = new Set(plan.jobs.flatMap((j) => (plan.inspect ?? []).find((i) => i.name === j.file)?.project.filamentTypes ?? []));
  const filamentMap = {};
  for (const [printer, map] of Object.entries(plan.recipe.filaments ?? {})) {
    filamentMap[printer] = {};
    for (const [type, pick] of Object.entries(map)) {
      if (usedTypes.size === 0 || usedTypes.has(type)) filamentMap[printer][type] = pick ? pick.name : null;
    }
  }

  const keyCounts = { sliceInfo: {}, projectSettings: {} };
  let agree = 0;
  let disagree = 0;
  for (const i of plan.inspect ?? []) {
    for (const group of ["sliceInfo", "projectSettings"]) {
      for (const [k, present] of Object.entries(i.keys?.[group] ?? {})) {
        keyCounts[group][k] = (keyCounts[group][k] ?? 0) + (present ? 1 : 0);
      }
    }
    const id = i.slicedFor?.printerModelId;
    if (id && i.project?.printerModel) {
      if ((plan.recipe.modelIds?.[id] ?? MODEL_IDS[id]) === i.project.printerModel) agree++;
      else disagree++;
    }
  }
  const imageIds = plan.recipe.modelIds ?? {};
  const tableDrift = Object.keys({ ...imageIds, ...MODEL_IDS }).filter((k) => imageIds[k] !== MODEL_IDS[k]);

  const counts = { ok: 0, refused: 0, "needs-decision": 0, fail: 0 };
  for (const p of plates) counts[p.verdict]++;
  let verdict = gateVerdict(plates);
  // gate.mjs checks writes checks.json only once all three checks are done,
  // so no file means items (f) to (h) are missing.
  const incomplete = [];
  if (!checks) incomplete.push("the checks step wrote no checks.json, so items (f), (g) and (h) are missing");
  if (plates.length === 0) incomplete.push("no plate was planned, so nothing was sliced");
  // A setup error (a missing machine preset) or missing checks means the run
  // is incomplete, so the gate could not run (exit 2) - but only when nothing
  // failed. A crash, a timeout or an unexplained error on a plate that did run
  // fails the gate whatever else is missing. A plate that never ran for a
  // setup error is not such a failure.
  const plateFailed = plates.some((p) => p.verdict === "fail" && p.reason !== "setup");
  if ((plan.errors?.length || incomplete.length) && !plateFailed) verdict = "COULD-NOT-RUN";

  const measured = plan.jobs.map((j) => ({ ...(results[j.id] ?? {}), inputBytes: j.inputBytes }));
  return {
    verdict,
    passRule:
      "Every plate gets a time and a weight above zero, or is refused for a reason AC-034 treats as legitimate (process not compatible, machine not supported, bed too small, nozzle or extruder mismatch), which is reported. A crash, a timeout or an unexplained slicer error on any plate fails the gate. Codes that the plan's reason map and Orca's own meaning disagree on are reported as needs-decision.",
    counts,
    setupErrors: plan.errors ?? [],
    incomplete,
    selection: plan.selection ?? null,
    plates,
    bambuGap: {
      platesCompared: gapRows.length,
      ownPrinterPlates: ownPlates.length,
      time: summarise(gapRows.map((g) => g.timePct)),
      weight: summarise(gapRows.map((g) => g.weightPct)),
      rows: gapRows,
    },
    recipe: {
      method: plan.recipe.method,
      companions: plan.recipe.companions,
      printers: Object.fromEntries(Object.entries(plan.recipe.printers ?? {}).map(([k, v]) => [k, { chain: v.chain, dangling: v.dangling ?? null }])),
      filamentByType: filamentMap,
      processSurvival: survival,
    },
    limits: proposeLimits(measured),
    printerKeys: {
      filesInspected: (plan.inspect ?? []).length,
      presentIn: keyCounts,
      sliceInfoIdMatchesProjectPrinter: { agree, disagree },
      modelIds: imageIds,
      tableDriftAgainstRepoCopy: tableDrift,
      nozzlePrinterCount: plan.recipe.nozzlePrinterCount ?? null,
    },
    openscad: checks?.openscad ?? null,
    landrun: checks?.landrun ?? null,
    step: checks?.step ?? null,
  };
}

const fmtPct = (v) => (v === null || v === undefined ? "n/a" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`);
const fmtBytes = (b) => (b ? `${(b / 2 ** 20).toFixed(0)} MiB` : "n/a");

export function summaryText(report) {
  const L = [];
  L.push(`Platehouse slicing gate: ${report.verdict}`);
  L.push("");
  L.push(`Pass rule: ${report.passRule}`);
  L.push("");
  L.push(
    `(a) Plates sliced: ${report.plates.length}. ok ${report.counts.ok}, refused for a legitimate reason ${report.counts.refused}, needs Jon's decision ${report.counts["needs-decision"]}, failed ${report.counts.fail}.`,
  );
  for (const e of report.setupErrors) L.push(`    setup error: ${e}`);
  for (const e of report.incomplete ?? []) L.push(`    incomplete: ${e}`);
  const sel = report.selection;
  if (sel) {
    if (sel.missing.length === 0) L.push("    The sample covers every role the plan's sample rule names.");
    for (const m of sel.missing) L.push(`    not covered: ${m}`);
    for (const u of sel.unknownPrinter) L.push(`    left out, printer not named: ${u}`);
    L.push(`    Sample, ${sel.sample.length} files, each with the role it was picked for:`);
    for (const s of sel.sample) {
      L.push(`      ${s.name}: ${s.roles.map((r, i) => `${r}${s.reasons[i] ? ` (${s.reasons[i]})` : ""}`).join("; ")}`);
    }
  } else L.push("    sample selection: not recorded in plan.json, so gaps in the sample are unknown.");
  const notOk = report.plates.filter((p) => p.verdict !== "ok");
  for (const p of notOk) {
    L.push(`    ${p.verdict}: ${p.file} on ${p.printer}, plate ${p.plate}: ${p.reason}${p.returnCode !== null ? ` (code ${p.returnCode}: ${p.meaning})` : p.meaning ? ` (${p.meaning})` : ""}`);
  }
  L.push("    Per-plate return code, error string, time, weight, grams per filament, wall time and peak RSS are in result.json under plates.");
  L.push("");
  const g = report.bambuGap;
  L.push(`(b) Gap against Bambu's own numbers, already-sliced files on their own printer: ${g.platesCompared} of ${g.ownPrinterPlates} plates compared.`);
  L.push(`    time: median ${fmtPct(g.time.median)}, worst ${fmtPct(g.time.worst)}; weight: median ${fmtPct(g.weight.median)}, worst ${fmtPct(g.weight.worst)}. No threshold.`);
  L.push("");
  L.push(`(c) Profile recipe: ${report.recipe.method}`);
  L.push(`    Start G-code companions merged: ${report.recipe.companions ? "yes" : "no"}.`);
  for (const [printer, v] of Object.entries(report.recipe.printers)) L.push(`    ${printer}: ${v.chain.join(" > ")}${v.dangling ? ` (dangling ${v.dangling})` : ""}`);
  for (const [printer, map] of Object.entries(report.recipe.filamentByType)) {
    L.push(`    ${printer} filaments: ${Object.entries(map).map(([t, n]) => `${t} -> ${n ?? "none (file's own kept)"}`).join(", ")}`);
  }
  const s = report.recipe.processSurvival;
  L.push(`    File's own process after the printer switch: kept on ${s.kept} finished slices, changed on ${s.changed}, unknown on ${s.unknown}; refused as process not compatible on ${s.refusedProcessNotCompatible} plates.`);
  L.push("");
  const lim = report.limits;
  L.push(`(d) Proposed AC-035 limits: cpus ${lim.cpus}, memory ${lim.memory}, SLICE_PLATE_SECONDS ${lim.slicePlateSeconds}, tmpfs ${lim.tmpfs}.`);
  L.push(`    Measured worst case: peak RSS ${fmtBytes(lim.measured.worstPeakRssBytes)}, wall ${lim.measured.worstWallSeconds} s, input plus scratch ${fmtBytes(lim.measured.worstInputPlusScratchBytes)}.`);
  L.push("");
  const k = report.printerKeys;
  L.push(`(e) Printer keys over ${k.filesInspected} files. slice_info.config: ${JSON.stringify(k.presentIn.sliceInfo)}; project_settings.config: ${JSON.stringify(k.presentIn.projectSettings)}.`);
  L.push(`    slice_info printer_model_id agrees with project_settings printer_model on ${k.sliceInfoIdMatchesProjectPrinter.agree} files, disagrees on ${k.sliceInfoIdMatchesProjectPrinter.disagree}.`);
  L.push(`    BBL model_id map (from the image): ${Object.entries(k.modelIds).map(([id, m]) => `${id}=${m}`).join(", ")}. ${k.nozzlePrinterCount} nozzle printers.`);
  if (k.tableDriftAgainstRepoCopy.length) L.push(`    The repo's copy of the table differs for: ${k.tableDriftAgainstRepoCopy.join(", ")}.`);
  L.push("");
  const o = report.openscad;
  if (o) {
    L.push(`(f) OpenSCAD: STL ${o.rendersStl ? "renders" : "FAILS"}; PNG ${o.rendersPng ? "renders" : "FAILS"} headless with no Xvfb; --info mentions Manifold: ${o.mentionsManifold ? "yes" : "no"}, EGL: ${o.mentionsEgl ? "yes" : "no"}.`);
    if (!o.rendersPng) L.push(`    PNG stderr tail: ${o.png.stderrTail.split("\n").slice(-3).join(" | ")}`);
  } else L.push("(f) OpenSCAD: not run.");
  const lr = report.landrun;
  if (lr) {
    L.push(`(g) landrun on kernel ${lr.kernel}: same-dir import ${lr.sameDirImportWorks ? "works" : "FAILS"}; import of /opt/gate/samples/outside.stl ${lr.outsideImportBlocked ? "is blocked" : "is NOT blocked"}; the same import without landrun ${lr.controlProvesSandbox ? "works (so landrun is what blocks it)" : "also fails (the control does not prove the sandbox)"}. Overall: ${lr.pass ? "pass" : "FAIL"}.`);
    L.push(`    The plan's T11 form with --ro on the OpenSCAD tree: ${lr.planFormRo.producedStl ? "works" : `does not run (exit ${lr.planFormRo.exit})`}.`);
  } else L.push("(g) landrun: not run.");
  const st = report.step;
  if (st) {
    L.push(`(h) STEP to GLB with occt-import-js 0.0.23 on ${st.sample}: ${st.pass ? `ok, ${st.totalMs} ms, ${st.glbBytes} bytes GLB from ${st.inputBytes} bytes STEP, ${st.meshes} meshes, ${st.triangles} triangles` : `FAILED${st.error ? `: ${st.error}` : ""}`}.`);
  } else L.push("(h) STEP: not run.");
  L.push("");
  L.push("Delete afterwards: rm -rf /tmp/platehouse-gate and docker image rm platehouse-gate:t1.");
  return `${L.join("\n")}\n`;
}

function reportCommand() {
  const plan = readJson(join(PATHS.out, "plan.json"));
  const results = {};
  const jobsDir = join(PATHS.out, "jobs");
  for (const f of existsSync(jobsDir) ? readdirSync(jobsDir) : []) {
    if (f.endsWith(".json")) results[f.slice(0, -5)] = readJson(join(jobsDir, f));
  }
  const hostExits = {};
  const hostFile = join(PATHS.out, "host-exit.tsv");
  if (existsSync(hostFile)) {
    for (const line of readFileSync(hostFile, "utf8").split("\n")) {
      const [id, code] = line.split("\t");
      if (id && code !== undefined) hostExits[id] = Number(code);
    }
  }
  const checksFile = join(PATHS.out, "checks.json");
  const checks = existsSync(checksFile) ? readJson(checksFile) : null;
  const report = buildReport({ plan, results, hostExits, checks });
  writeJson(join(PATHS.out, "result.json"), report);
  const text = summaryText(report);
  writeFileSync(join(PATHS.out, "summary.txt"), text);
  process.stdout.write(text);
  const EXIT = { PASS: 0, FAIL: 1, "COULD-NOT-RUN": 2, "NEEDS-DECISION": 3 };
  process.exitCode = EXIT[report.verdict] ?? 1;
}

// ---------------------------------------------------------------- main

if (isMain(import.meta.url)) {
  const [cmd, arg] = process.argv.slice(2);
  try {
    if (cmd === "plan") planCommand();
    else if (cmd === "slice" && /^j\d{4,}$/.test(arg ?? "")) sliceCommand(arg);
    else if (cmd === "checks") await checksCommand();
    else if (cmd === "report") reportCommand();
    else throw new Error("usage: gate.mjs plan | slice <jNNNN> | checks | report");
  } catch (err) {
    process.stderr.write(`gate ${cmd ?? ""}: ${err.message}\n`);
    process.exit(2);
  }
}
