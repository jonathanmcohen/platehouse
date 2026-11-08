#!/usr/bin/env node
// Flattens OrcaSlicer's bundled BBL profiles through `inherits` into full JSON
// files that `orca-slicer --load-settings` and `--load-filaments` accept, and
// writes the recipe (report item c) that says which files were used.
//
// Why flatten: --load-settings does not run the GUI's preset resolver, so a
// preset that only names its parent loads without the parent's keys. The walk
// follows the Bambuddy fork's resolver (maziggy/orca-slicer-api
// profile-resolver.ts and profile-index.ts at 4c05506):
//   - presets are found by name through the vendor manifest (BBL.json), whose
//     sub_path entries may sit in subfolders, then by a flat scan;
//   - a vendor preset's parent is looked up in the vendor first, then in
//     OrcaFilamentLibrary; once the walk is in the library it stays there;
//   - child keys win over parent keys; `inherits` is dropped at the end;
//   - `from` "User"/"System" becomes "system", and `type` is stamped when
//     missing (the CLI rejects a type-less or oddly cased file with -5);
//   - optional: "<preset> template <key>.json" companion files fill keys the
//     preset leaves unset (start G-code and friends). Off by default, because
//     the plan (T11) does not use them; --companions turns them on.
// Sentinel stripping in that resolver applies to user exports only; bundled
// system presets carry none, so it is not done here.
//
// Usage (inside the gate image):
//   node flatten-profiles.mjs --profiles /opt/orca-profiles --out <dir> \
//        --printer "Bambu Lab P1S 0.4 nozzle" [--printer ...] --types PLA,PETG [--companions]
//   node flatten-profiles.mjs --profiles /opt/orca-profiles \
//        --process-full /opt/orca/resources/profiles/BBL/process_full
//     (at image build time: Orca's default process presets for a printer
//     switch; see writeProcessFull)
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { isMain } from "./lib/is-main.mjs";

export const VENDOR = "BBL";
export const LIBRARY = "OrcaFilamentLibrary";
const MAX_DEPTH = 16;
const CATEGORIES = ["machine", "process", "filament"];
const LIST_KEYS = { machine_list: "machine", process_list: "process", filament_list: "filament" };
const TEMPLATE_MARKER = " template ";
const TEMPLATE_IDENTITY_KEYS = new Set(["name", "inherits", "instantiation", "type", "from"]);

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function readTree(profilesRoot, name) {
  const root = join(profilesRoot, name);
  const tree = { root, machine: new Map(), process: new Map(), filament: new Map(), machineModels: [] };
  const manifestFile = join(profilesRoot, `${name}.json`);
  const inside = (sub) => {
    const file = resolve(root, sub);
    return file.startsWith(resolve(root) + sep) ? file : null;
  };
  if (existsSync(manifestFile)) {
    const manifest = readJson(manifestFile);
    for (const [key, category] of Object.entries(LIST_KEYS)) {
      for (const entry of Array.isArray(manifest[key]) ? manifest[key] : []) {
        if (!entry || typeof entry.name !== "string" || typeof entry.sub_path !== "string") continue;
        const file = inside(entry.sub_path);
        if (file && !tree[category].has(entry.name)) tree[category].set(entry.name, file);
      }
    }
    for (const entry of Array.isArray(manifest.machine_model_list) ? manifest.machine_model_list : []) {
      const file = entry && typeof entry.sub_path === "string" ? inside(entry.sub_path) : null;
      if (file) tree.machineModels.push(file);
    }
  }
  for (const category of CATEGORIES) {
    const dir = join(root, category);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".json")) continue;
      const presetName = entry.slice(0, -5);
      if (!tree[category].has(presetName)) tree[category].set(presetName, join(dir, entry));
    }
  }
  return tree;
}

/**
 * Indexes the vendor tree and the filament library under a profiles folder in
 * the layout of Orca's source resources/profiles (in the image,
 * /opt/orca-profiles, fetched from Orca's source; see the Dockerfile).
 * Throws when the vendor has no JSON presets, rather than return an empty
 * index that turns every printer into a "no bundled machine preset" error.
 */
export function loadIndex(profilesRoot, vendor = VENDOR) {
  // OrcaSlicer 2.5.0's AppImage ships resources/profiles/<vendor>.opc, a
  // binary preset cache (PresetCacheFormat.cpp), in place of <vendor>.json
  // and its JSON tree; <vendor>/filament keeps only a few JSON maps, which are
  // not presets, so the manifest is what tells the two layouts apart.
  if (!existsSync(join(profilesRoot, `${vendor}.json`)) && existsSync(join(profilesRoot, `${vendor}.opc`))) {
    throw new Error(
      `${profilesRoot} has ${vendor}.opc but no ${vendor}.json: OrcaSlicer 2.5.0 packs its presets into ${vendor}.opc, a binary preset cache this flattener cannot read`,
    );
  }
  const vendorTree = readTree(profilesRoot, vendor);
  if (CATEGORIES.every((category) => vendorTree[category].size === 0)) {
    throw new Error(`no ${vendor} presets under ${profilesRoot} (no ${vendor}.json and no ${vendor}/machine, process or filament JSON)`);
  }
  let library = null;
  if (existsSync(join(profilesRoot, LIBRARY)) || existsSync(join(profilesRoot, `${LIBRARY}.json`))) {
    library = readTree(profilesRoot, LIBRARY);
    library.machine.clear();
    library.process.clear();
  }
  return { profilesRoot, vendor: vendorTree, library, cache: new Map() };
}

function lookup(index, category, name, scope) {
  if (scope === "vendor") {
    const file = index.vendor[category].get(name);
    if (file) return { file, scope: "vendor" };
  }
  const file = index.library?.[category].get(name);
  return file ? { file, scope: "library" } : null;
}

function companionsFor(index, category, name) {
  const dir = join(index.vendor.root, category);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    const base = entry.slice(0, -5);
    const at = base.lastIndexOf(TEMPLATE_MARKER);
    if (at > 0 && base.slice(0, at) === name) out.push(join(dir, entry));
  }
  return out.sort();
}

function applyCompanions(index, category, name, preset) {
  for (const file of companionsFor(index, category, name)) {
    const companion = readJson(file);
    for (const [key, value] of Object.entries(companion)) {
      if (TEMPLATE_IDENTITY_KEYS.has(key) || key in preset) continue;
      preset[key] = value;
    }
  }
}

/**
 * Flattens one bundled preset. Returns { profile, chain, dangling }:
 * chain lists the preset and each ancestor read; dangling names an inherits
 * value that matched no bundled preset (dropped, as the Bambuddy resolver does).
 */
export function flattenPreset(index, category, name, { companions = false } = {}) {
  const key = `${category}\u0000${name}\u0000${companions}`;
  const cached = index.cache.get(key);
  if (cached) return structuredClone(cached);

  const start = lookup(index, category, name, "vendor");
  if (!start) throw new Error(`no bundled ${category} preset named "${name}"`);
  let current = readJson(start.file);
  if (companions && start.scope === "vendor") applyCompanions(index, category, name, current);
  const chain = [name];
  let scope = start.scope;
  let dangling = null;
  let depth = 0;
  while (typeof current.inherits === "string" && current.inherits.length > 0) {
    if (depth >= MAX_DEPTH) {
      throw new Error(`inheritance depth over ${MAX_DEPTH} for ${category} "${name}" at "${current.inherits}"`);
    }
    const parentName = current.inherits;
    const found = lookup(index, category, parentName, scope);
    if (!found) {
      dangling = parentName;
      delete current.inherits;
      break;
    }
    const parent = readJson(found.file);
    if (companions && found.scope === "vendor") applyCompanions(index, category, parentName, parent);
    const merged = { ...parent, ...current };
    if (typeof parent.inherits === "string" && parent.inherits.length > 0) merged.inherits = parent.inherits;
    else delete merged.inherits;
    current = merged;
    chain.push(parentName);
    scope = found.scope;
    depth += 1;
  }
  delete current.inherits;
  if (current.from === "User" || current.from === "System" || current.from === undefined) current.from = "system";
  if (typeof current.type !== "string" || current.type.length === 0) current.type = category;
  current.name = name;
  const result = { profile: current, chain, dangling };
  index.cache.set(key, structuredClone(result));
  return result;
}

function firstValue(v) {
  return Array.isArray(v) ? v[0] : v;
}

function baseName(name) {
  const at = name.indexOf(" @");
  return at === -1 ? name : name.slice(0, at);
}

/**
 * Orca's Bambu generic filament profile for one filament type on one printer
 * (Q4 / AC-032). Candidates: instantiable "Generic ..." presets whose
 * flattened filament_type is the type and whose compatible_printers names the
 * printer. Ranked: base name exactly "Generic <type>", then shorter name, then
 * name order. Returns { name, rule } or null when none fits.
 */
export function genericFilamentFor(index, printerName, type) {
  const names = new Set([...index.vendor.filament.keys(), ...(index.library?.filament.keys() ?? [])]);
  const candidates = [];
  for (const name of names) {
    if (!name.startsWith("Generic ") || name.includes(TEMPLATE_MARKER)) continue;
    let flat;
    try {
      flat = flattenPreset(index, "filament", name).profile;
    } catch {
      continue;
    }
    if (flat.instantiation !== "true") continue;
    if (String(firstValue(flat.filament_type) ?? "") !== type) continue;
    const compat = Array.isArray(flat.compatible_printers) ? flat.compatible_printers : [];
    if (!compat.includes(printerName)) continue;
    candidates.push(name);
  }
  if (candidates.length === 0) return null;
  const exact = `Generic ${type}`;
  candidates.sort((a, b) => {
    const ea = baseName(a) === exact ? 0 : 1;
    const eb = baseName(b) === exact ? 0 : 1;
    if (ea !== eb) return ea - eb;
    if (a.length !== b.length) return a.length - b.length;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const name = candidates[0];
  const rule =
    baseName(name) === exact
      ? `named Generic ${type}, compatible with ${printerName}`
      : `no Generic ${type} preset fits ${printerName}; nearest generic preset of type ${type}`;
  return { name, rule, candidates: candidates.length };
}

/** Machine presets the printer menu would list: instantiable, name ending in "nozzle". */
export function nozzlePrinters(index) {
  const out = [];
  for (const name of index.vendor.machine.keys()) {
    if (!name.endsWith("nozzle") || name.includes(TEMPLATE_MARKER) || name.endsWith("_common")) continue;
    try {
      if (flattenPreset(index, "machine", name).profile.instantiation === "true") out.push(name);
    } catch {
      // a preset that cannot be flattened is not offered
    }
  }
  return out.sort();
}

/** BBL model_id -> printer model name, from the machine_model files. */
export function machineModels(index) {
  const out = {};
  for (const file of index.vendor.machineModels) {
    const model = readJson(file);
    if (typeof model.model_id === "string" && typeof model.name === "string") out[model.model_id] = model.name;
  }
  return out;
}

function safeFile(name) {
  const slug = name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 8);
  return `${slug}-${hash}.json`;
}

/**
 * Writes flattened machine presets for each printer and the generic filament
 * preset for each printer x type into outDir, plus recipe.json. Returns the
 * recipe. File paths in the recipe are relative to outDir.
 */
export function writeRecipe(index, outDir, { printers, types, companions = false }) {
  mkdirSync(join(outDir, "machine"), { recursive: true });
  mkdirSync(join(outDir, "filament"), { recursive: true });
  const recipe = {
    method:
      "Each preset is flattened through inherits to its root (vendor BBL first, then OrcaFilamentLibrary for filaments), child keys over parent keys, inherits removed, from set to system, type stamped. Only the machine preset is loaded with --load-settings, so the file's own process is kept unless Orca refuses the switch; one generic filament per filament type is loaded with --load-filaments, and a type with no generic preset keeps the file's own filament (an empty slot in the list).",
    companions,
    printers: {},
    filaments: {},
    modelIds: machineModels(index),
    nozzlePrinterCount: nozzlePrinters(index).length,
  };
  const writePreset = (category, name) => {
    const { profile, chain, dangling } = flattenPreset(index, category, name, { companions });
    const rel = join(category, safeFile(name));
    writeFileSync(join(outDir, rel), `${JSON.stringify(profile, null, 2)}\n`);
    return { file: rel, chain, dangling };
  };
  for (const printer of printers) {
    recipe.printers[printer] = writePreset("machine", printer);
    recipe.filaments[printer] = {};
    for (const type of types) {
      const pick = genericFilamentFor(index, printer, type);
      recipe.filaments[printer][type] = pick ? { name: pick.name, rule: pick.rule, ...writePreset("filament", pick.name) } : null;
    }
  }
  writeFileSync(join(outDir, "recipe.json"), `${JSON.stringify(recipe, null, 2)}\n`);
  return recipe;
}

/**
 * Writes Orca's process_full folder: the flattened default process
 * (default_print_profile) of every instantiable machine preset, one file
 * per process, named exactly "<process name>.json".
 *
 * Why: when a file is sliced on a printer other than its own and the
 * extruder variant count changes (P1S and X1C carry two print variants, A1
 * one), Orca 2.5.0's CLI (src/OrcaSlicer.cpp, the machine_switch block)
 * loads <resources>/profiles/BBL/process_full/<default_print_profile>.json.
 * The resources dir is the binary's ../../resources and no flag moves it,
 * and the AppImage ships no process_full folder, so the switch failed with
 * code -3 (Hades run 3, 79 plates). The file must be flattened:
 * load_config_file resolves an inherits chain only through a vendor
 * manifest (BBL.json) beside the vendor folder, which the AppImage does not
 * ship, and the switch rejects a file whose type is not "process" or whose
 * from is not "system". flattenPreset gives exactly that.
 *
 * The rule: every instantiable machine preset ends with its default process
 * written here, or the call throws, naming each machine and why, and writes
 * nothing. A machine left out would fail with code -3 the first time a file
 * is switched to it, which is the failure this folder exists to prevent, so
 * nothing is skipped and merely listed. The reasons:
 *   - the machine will not flatten (an inheritance loop or chain too deep),
 *     or its own inherits chain names a parent the bundle does not have
 *     (flattenPreset's dangling): its keys, instantiation and
 *     default_print_profile included, may come from that parent, so it can
 *     be neither trusted nor told apart from an instantiable machine;
 *   - it has no default_print_profile, or one that is not a non-empty string;
 *   - its default process is not in the bundle, has a dangling parent of its
 *     own (the file would lack the parent's keys and Orca would quietly use
 *     its built-in defaults for them), or is not a process preset.
 * Templates and _common machine presets are never read, and a machine that
 * flattens cleanly but is not instantiable (machine_model files included) is
 * passed over: the printer menu does not offer it, so nothing switches to it.
 * Never overwrites a file, and refuses a name that is not a plain file name.
 * Returns { files: [process names, sorted], machines: instantiable count }.
 */
export function writeProcessFull(index, outDir) {
  const wanted = new Map();
  const problems = [];
  let machines = 0;
  for (const name of [...index.vendor.machine.keys()].sort()) {
    if (name.includes(TEMPLATE_MARKER) || name.endsWith("_common")) continue;
    let flat;
    try {
      flat = flattenPreset(index, "machine", name);
    } catch (err) {
      problems.push(`machine "${name}" will not flatten: ${err.message}`);
      continue;
    }
    if (flat.dangling !== null) {
      problems.push(`machine "${name}" inherits "${flat.dangling}", which the bundle does not have, so its default process cannot be known`);
      continue;
    }
    const { profile } = flat;
    if (profile.instantiation !== "true") continue;
    machines += 1;
    const proc = profile.default_print_profile;
    if (typeof proc !== "string" || proc.length === 0) {
      problems.push(`machine "${name}" is instantiable but has no default_print_profile`);
      continue;
    }
    if (proc.includes("/") || proc.includes("\\") || proc.includes("\0") || proc.startsWith(".")) {
      throw new Error(`machine "${name}" names default process "${proc}", which is not a plain file name`);
    }
    if (!wanted.has(proc)) wanted.set(proc, []);
    wanted.get(proc).push(name);
  }
  const files = [...wanted.keys()].sort();
  // Flatten every one before writing any, so a problem writes nothing.
  const flat = [];
  for (const name of files) {
    const users = wanted.get(name).map((m) => `machine "${m}"`).join(", ");
    let result;
    try {
      result = flattenPreset(index, "process", name);
    } catch (err) {
      problems.push(`${users}: default process "${name}": ${err.message}`);
      continue;
    }
    if (result.dangling !== null) {
      problems.push(`${users}: default process "${name}" inherits "${result.dangling}", which the bundle does not have; the file would lack its keys`);
    } else if (result.profile.type !== "process") {
      problems.push(`${users}: "${name}" is a ${result.profile.type} preset, not a process`);
    } else {
      flat.push([name, result.profile]);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `${problems.length} problem(s) would leave an instantiable machine without its default process (code -3 on a printer switch):\n  ${problems.join("\n  ")}`,
    );
  }
  mkdirSync(outDir, { recursive: true });
  for (const [name, profile] of flat) {
    writeFileSync(join(outDir, `${name}.json`), `${JSON.stringify(profile, null, 2)}\n`, { flag: "wx" });
  }
  return { files, machines };
}

function parseArgs(argv) {
  const args = { profiles: null, out: null, printers: [], types: [], companions: false, processFull: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--profiles") args.profiles = argv[++i];
    else if (a === "--process-full") args.processFull = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--printer") args.printers.push(argv[++i]);
    else if (a === "--types") args.types.push(...argv[++i].split(",").filter(Boolean));
    else if (a === "--companions") args.companions = true;
    else throw new Error(`unknown argument ${a}`);
  }
  const usage =
    "usage: flatten-profiles.mjs --profiles <dir> --out <dir> --printer <name> [--printer ...] --types A,B [--companions]\n" +
    "       flatten-profiles.mjs --profiles <dir> --process-full <dir>";
  if (args.processFull !== null) {
    if (!args.profiles || !args.processFull || args.out || args.printers.length > 0) throw new Error(usage);
    return args;
  }
  if (!args.profiles || !args.out || args.printers.length === 0) throw new Error(usage);
  return args;
}

if (isMain(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.processFull !== null) {
      const { files, machines } = writeProcessFull(loadIndex(args.profiles), args.processFull);
      process.stdout.write(`wrote ${files.length} default process presets for ${machines} instantiable machine presets to ${args.processFull}\n`);
      process.exit(0);
    }
    const recipe = writeRecipe(loadIndex(args.profiles), args.out, args);
    process.stdout.write(
      `wrote ${Object.keys(recipe.printers).length} machine preset(s) and recipe.json to ${basename(args.out)}; ${recipe.nozzlePrinterCount} nozzle printers in the bundle\n`,
    );
  } catch (err) {
    process.stderr.write(`flatten-profiles: ${err.message}\n`);
    process.exit(2);
  }
}
