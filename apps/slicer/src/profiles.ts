// Orca's BBL profiles for the slicer (build plan Task 11, AC-031): the T1
// recipe, ported from the slicing gate's flatten-profiles.mjs, which Hades
// run 4 proved on 332 slices.
//
// At image build (node profiles.js --source ... --out ... --process-full ...):
// - every preset is flattened through inherits, because --load-settings does
//   not run the GUI's preset resolver. The walk follows the Bambuddy fork's
//   resolver (maziggy/orca-slicer-api profile-resolver.ts at 4c05506):
//   presets are found by name through the vendor manifest (BBL.json), then
//   by a flat scan; a vendor preset's parent is looked up in the vendor
//   first, then in OrcaFilamentLibrary, and once in the library the walk
//   stays there; child keys win; inherits is dropped; from "User"/"System"
//   becomes "system"; type is stamped when missing. The template companion
//   merge is not used (no G-code is kept), nor any user-profile handling;
//   bundled presets carry no sentinels to strip;
// - the menu printers are the instantiable machine presets whose names end
//   in "nozzle" (not templates, not _common); each gets a flattened machine
//   file, and each filament type gets one default filament per printer:
//   Bambu's own preset for that printer where BAMBU_FILAMENTS maps the type
//   and Orca has one, else the generic preset for that printer (Jon,
//   2026-11-08: "I use mostly Bambu Filaments");
// - Orca's process_full folder gets the flattened default process of every
//   instantiable machine. Orca 2.5.0 loads that file on a printer switch and
//   the AppImage ships none, so without it the switch fails with code -3
//   (gate run 3). The build fails naming any machine it cannot cover.
//
// At run time the server reads manifest.json (loadProfiles), never the
// source tree.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const VENDOR = "BBL";
export const LIBRARY = "OrcaFilamentLibrary";
const MAX_DEPTH = 16;
const TEMPLATE_MARKER = " template ";

export type Category = "machine" | "process" | "filament";
const CATEGORIES: Category[] = ["machine", "process", "filament"];
const LIST_KEYS: Record<string, Category> = {
  machine_list: "machine",
  process_list: "process",
  filament_list: "filament",
};

export type Preset = Record<string, unknown>;

interface Tree {
  root: string;
  machine: Map<string, string>;
  process: Map<string, string>;
  filament: Map<string, string>;
  machineModels: string[];
}

export interface ProfileIndex {
  profilesRoot: string;
  vendor: Tree;
  library: Tree | null;
  cache: Map<string, Flattened>;
}

export interface Flattened {
  profile: Preset;
  chain: string[];
  dangling: string | null;
}

function readJson(file: string): Preset {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${file} is not a JSON object`);
  }
  return value as Preset;
}

function entries(value: unknown): Array<{ name: string; sub_path: string }> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (e): e is { name: string; sub_path: string } =>
      e !== null &&
      typeof e === "object" &&
      typeof (e as { name?: unknown }).name === "string" &&
      typeof (e as { sub_path?: unknown }).sub_path === "string",
  );
}

function readTree(profilesRoot: string, name: string): Tree {
  const root = join(profilesRoot, name);
  const tree: Tree = {
    root,
    machine: new Map(),
    process: new Map(),
    filament: new Map(),
    machineModels: [],
  };
  const manifestFile = join(profilesRoot, `${name}.json`);
  const inside = (sub: string): string | null => {
    const file = resolve(root, sub);
    return file.startsWith(resolve(root) + sep) ? file : null;
  };
  if (existsSync(manifestFile)) {
    const manifest = readJson(manifestFile);
    for (const [key, category] of Object.entries(LIST_KEYS)) {
      for (const entry of entries(manifest[key])) {
        const file = inside(entry.sub_path);
        if (file && !tree[category].has(entry.name)) tree[category].set(entry.name, file);
      }
    }
    for (const entry of entries(manifest.machine_model_list)) {
      const file = inside(entry.sub_path);
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
 * Indexes the vendor tree and the filament library under a folder in the
 * layout of Orca's source resources/profiles (in the image /opt/orca-profiles,
 * fetched from Orca's source; the AppImage ships only binary .opc caches).
 */
export function loadIndex(profilesRoot: string, vendor = VENDOR): ProfileIndex {
  if (
    !existsSync(join(profilesRoot, `${vendor}.json`)) &&
    existsSync(join(profilesRoot, `${vendor}.opc`))
  ) {
    throw new Error(
      `${profilesRoot} has ${vendor}.opc but no ${vendor}.json: OrcaSlicer 2.5.0 packs its presets into ${vendor}.opc, a binary preset cache this flattener cannot read`,
    );
  }
  const vendorTree = readTree(profilesRoot, vendor);
  if (CATEGORIES.every((category) => vendorTree[category].size === 0)) {
    throw new Error(
      `no ${vendor} presets under ${profilesRoot} (no ${vendor}.json and no ${vendor}/machine, process or filament JSON)`,
    );
  }
  let library: Tree | null = null;
  if (
    existsSync(join(profilesRoot, LIBRARY)) ||
    existsSync(join(profilesRoot, `${LIBRARY}.json`))
  ) {
    library = readTree(profilesRoot, LIBRARY);
    library.machine.clear();
    library.process.clear();
  }
  return { profilesRoot, vendor: vendorTree, library, cache: new Map() };
}

function lookup(
  index: ProfileIndex,
  category: Category,
  name: string,
  scope: "vendor" | "library",
): { file: string; scope: "vendor" | "library" } | null {
  if (scope === "vendor") {
    const file = index.vendor[category].get(name);
    if (file) return { file, scope: "vendor" };
  }
  const file = index.library?.[category].get(name);
  return file ? { file, scope: "library" } : null;
}

/** Flattens one bundled preset through inherits. */
export function flattenPreset(index: ProfileIndex, category: Category, name: string): Flattened {
  const key = `${category}\u0000${name}`;
  const cached = index.cache.get(key);
  if (cached) return structuredClone(cached);

  const start = lookup(index, category, name, "vendor");
  if (!start) throw new Error(`no bundled ${category} preset named "${name}"`);
  let current = readJson(start.file);
  const chain = [name];
  let scope = start.scope;
  let dangling: string | null = null;
  let depth = 0;
  while (typeof current.inherits === "string" && current.inherits.length > 0) {
    if (depth >= MAX_DEPTH) {
      throw new Error(
        `inheritance depth over ${MAX_DEPTH} for ${category} "${name}" at "${current.inherits}"`,
      );
    }
    const parentName = current.inherits;
    const found = lookup(index, category, parentName, scope);
    if (!found) {
      dangling = parentName;
      delete current.inherits;
      break;
    }
    const parent = readJson(found.file);
    const merged: Preset = { ...parent, ...current };
    if (typeof parent.inherits === "string" && parent.inherits.length > 0) {
      merged.inherits = parent.inherits;
    } else {
      delete merged.inherits;
    }
    current = merged;
    chain.push(parentName);
    scope = found.scope;
    depth += 1;
  }
  delete current.inherits;
  if (current.from === "User" || current.from === "System" || current.from === undefined) {
    current.from = "system";
  }
  if (typeof current.type !== "string" || current.type.length === 0) current.type = category;
  current.name = name;
  const result: Flattened = { profile: current, chain, dangling };
  index.cache.set(key, structuredClone(result));
  return result;
}

function firstValue(v: unknown): unknown {
  return Array.isArray(v) ? v[0] : v;
}

function baseName(name: string): string {
  const at = name.indexOf(" @");
  return at === -1 ? name : name.slice(0, at);
}

function isTemplateOrCommon(name: string): boolean {
  return name.includes(TEMPLATE_MARKER) || name.endsWith("_common");
}

/** Where a printer's default filament for a type comes from. */
export type FilamentSource = "bambu" | "generic";

/** A bundled, instantiable filament preset, flattened. */
export interface FilamentCandidate {
  name: string;
  type: string;
  compatible: string[];
}

const GENERIC_PREFIX = "Generic ";
const BAMBU_PREFIX = "Bambu ";

/**
 * The presets a default filament is picked from: every bundled, instantiable
 * "Generic ..." or "Bambu ..." filament preset (not a template), with its
 * flattened filament_type and compatible_printers.
 */
export function filamentCandidates(index: ProfileIndex): FilamentCandidate[] {
  const names = new Set([
    ...index.vendor.filament.keys(),
    ...(index.library?.filament.keys() ?? []),
  ]);
  const out: FilamentCandidate[] = [];
  for (const name of names) {
    if (!name.startsWith(GENERIC_PREFIX) && !name.startsWith(BAMBU_PREFIX)) continue;
    if (name.includes(TEMPLATE_MARKER)) continue;
    let flat: Preset;
    try {
      flat = flattenPreset(index, "filament", name).profile;
    } catch {
      continue;
    }
    if (flat.instantiation !== "true") continue;
    const type = String(firstValue(flat.filament_type) ?? "");
    if (type.length === 0) continue;
    const compatible = Array.isArray(flat.compatible_printers)
      ? flat.compatible_printers.filter((p): p is string => typeof p === "string")
      : [];
    out.push({ name, type, compatible });
  }
  return out;
}

function byLengthThenName(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

function pickGeneric(candidates: string[], type: string): string | null {
  if (candidates.length === 0) return null;
  const exact = `Generic ${type}`;
  const sorted = [...candidates].sort((a, b) => {
    const ea = baseName(a) === exact ? 0 : 1;
    const eb = baseName(b) === exact ? 0 : 1;
    if (ea !== eb) return ea - eb;
    return byLengthThenName(a, b);
  });
  return sorted[0] ?? null;
}

/**
 * Orca's Bambu generic filament profile for one filament type on one printer
 * (Q4 / AC-032). Candidates: instantiable "Generic ..." presets whose
 * flattened filament_type is the type and whose compatible_printers names
 * the printer. Ranked: base name exactly "Generic <type>", then shorter
 * name, then name order.
 */
export function genericFilamentFor(
  index: ProfileIndex,
  printerName: string,
  type: string,
): { name: string; candidates: number } | null {
  const candidates = filamentCandidates(index)
    .filter(
      (g) =>
        g.name.startsWith(GENERIC_PREFIX) && g.type === type && g.compatible.includes(printerName),
    )
    .map((g) => g.name);
  const name = pickGeneric(candidates, type);
  return name ? { name, candidates: candidates.length } : null;
}

/**
 * Bambu's own filament preset per filament type, preferred over the generic
 * one wherever Orca has it for the printer (build plan Task 11 Decisions,
 * Jon 2026-11-08: "I use mostly Bambu Filaments"). The front office's
 * mapping, which Jon may correct: this table is the one place it lives.
 * Each value is a preset's base name, the part before " @".
 */
export const BAMBU_FILAMENTS: Readonly<Record<string, string>> = Object.freeze({
  PLA: "Bambu PLA Basic",
  PETG: "Bambu PETG HF",
  ABS: "Bambu ABS",
  ASA: "Bambu ASA",
  TPU: "Bambu TPU 95A",
});

/**
 * The default filament for one type on one printer: Bambu's own preset for
 * the printer where the table maps the type (an instantiable preset whose
 * base name is the table's, whose filament_type is the type and whose
 * compatible_printers names the printer; shorter name, then name order, if
 * there were ever two), else the generic preset for the printer (the merged
 * ranking, genericFilamentFor), else null: the slice keeps the file's own
 * filament for that slot.
 */
export function pickFilament(
  candidates: readonly FilamentCandidate[],
  printerName: string,
  type: string,
  table: Readonly<Record<string, string>> = BAMBU_FILAMENTS,
): { profile: string; source: FilamentSource } | null {
  const fits = (c: FilamentCandidate) => c.type === type && c.compatible.includes(printerName);
  const bambuName = Object.hasOwn(table, type) ? table[type] : undefined;
  if (bambuName) {
    const bambu = candidates
      .filter((c) => fits(c) && baseName(c.name) === bambuName)
      .map((c) => c.name)
      .sort(byLengthThenName);
    if (bambu[0]) return { profile: bambu[0], source: "bambu" };
  }
  const generic = pickGeneric(
    candidates.filter((c) => fits(c) && c.name.startsWith(GENERIC_PREFIX)).map((c) => c.name),
    type,
  );
  return generic ? { profile: generic, source: "generic" } : null;
}

/** Machine presets the printer menu lists: instantiable, name ending in "nozzle". */
export function nozzlePrinters(index: ProfileIndex): string[] {
  const out: string[] = [];
  for (const name of index.vendor.machine.keys()) {
    if (!name.endsWith("nozzle") || isTemplateOrCommon(name)) continue;
    try {
      if (flattenPreset(index, "machine", name).profile.instantiation === "true") out.push(name);
    } catch {
      // a preset that cannot be flattened is not offered
    }
  }
  return out.sort();
}

/** BBL model_id -> printer model name, from the machine_model files. */
export function machineModels(index: ProfileIndex): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of index.vendor.machineModels) {
    const model = readJson(file);
    if (typeof model.model_id === "string" && typeof model.name === "string") {
      out[model.model_id] = model.name;
    }
  }
  return out;
}

/**
 * Writes Orca's process_full folder: the flattened default process
 * (default_print_profile) of every instantiable machine preset, one file per
 * process, named exactly "<process name>.json". Throws, naming each machine
 * and why, and writes nothing, when any instantiable machine cannot be
 * covered: a machine that will not flatten or has a dangling parent, one
 * with no default_print_profile, or a default process that is missing, has a
 * dangling parent or is not a process. Never overwrites a file, and refuses
 * a name that is not a plain file name.
 */
export function writeProcessFull(
  index: ProfileIndex,
  outDir: string,
): { files: string[]; machines: number } {
  const wanted = new Map<string, string[]>();
  const problems: string[] = [];
  let machines = 0;
  for (const name of [...index.vendor.machine.keys()].sort()) {
    if (isTemplateOrCommon(name)) continue;
    let flat: Flattened;
    try {
      flat = flattenPreset(index, "machine", name);
    } catch (err) {
      problems.push(`machine "${name}" will not flatten: ${(err as Error).message}`);
      continue;
    }
    if (flat.dangling !== null) {
      problems.push(
        `machine "${name}" inherits "${flat.dangling}", which the bundle does not have, so its default process cannot be known`,
      );
      continue;
    }
    if (flat.profile.instantiation !== "true") continue;
    machines += 1;
    const proc = flat.profile.default_print_profile;
    if (typeof proc !== "string" || proc.length === 0) {
      problems.push(`machine "${name}" is instantiable but has no default_print_profile`);
      continue;
    }
    if (proc.includes("/") || proc.includes("\\") || proc.includes("\0") || proc.startsWith(".")) {
      throw new Error(
        `machine "${name}" names default process "${proc}", which is not a plain file name`,
      );
    }
    const users = wanted.get(proc) ?? [];
    users.push(name);
    wanted.set(proc, users);
  }
  const files = [...wanted.keys()].sort();
  const flat: Array<[string, Preset]> = [];
  for (const name of files) {
    const users = (wanted.get(name) ?? []).map((m) => `machine "${m}"`).join(", ");
    let result: Flattened;
    try {
      result = flattenPreset(index, "process", name);
    } catch (err) {
      problems.push(`${users}: default process "${name}": ${(err as Error).message}`);
      continue;
    }
    if (result.dangling !== null) {
      problems.push(
        `${users}: default process "${name}" inherits "${result.dangling}", which the bundle does not have; the file would lack its keys`,
      );
    } else if (result.profile.type !== "process") {
      problems.push(
        `${users}: "${name}" is a ${String(result.profile.type)} preset, not a process`,
      );
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
    writeFileSync(join(outDir, `${name}.json`), `${JSON.stringify(profile, null, 2)}\n`, {
      flag: "wx",
    });
  }
  return { files, machines };
}

// ------------------------------------------------------------ the manifest

const manifestSchema = z.strictObject({
  printers: z.array(
    z.strictObject({
      id: z.string().min(1),
      model: z.string().min(1),
      modelId: z.string().min(1),
      nozzle: z.number().positive(),
      file: z.string().min(1),
    }),
  ),
  filaments: z.record(
    z.string(),
    z.record(
      z.string(),
      z.strictObject({
        profile: z.string().min(1),
        file: z.string().min(1),
        source: z.enum(["bambu", "generic"]),
      }),
    ),
  ),
});

export type Manifest = z.infer<typeof manifestSchema>;

function safeFile(name: string): string {
  const slug = name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 8);
  return `${slug}-${hash}.json`;
}

/**
 * Writes the image's profile folder: one flattened machine file per menu
 * printer, one flattened filament file per default filament picked
 * (pickFilament: Bambu's own preset, else the generic one), and
 * manifest.json naming them (paths relative to outDir). Fails when a menu
 * printer has no printer_model, no model_id for it, or no nozzle size, so the
 * menu never shows a printer the app cannot match to a file's printer.
 */
export function buildProfiles(index: ProfileIndex, outDir: string): Manifest {
  mkdirSync(join(outDir, "machine"), { recursive: true });
  mkdirSync(join(outDir, "filament"), { recursive: true });
  const modelIds = Object.fromEntries(
    Object.entries(machineModels(index)).map(([id, m]) => [m, id]),
  );
  const candidates = filamentCandidates(index);
  const types = [...new Set(candidates.map((c) => c.type))].sort();
  const written = new Map<string, string>();
  const writePreset = (category: Category, name: string): string => {
    const key = `${category}\u0000${name}`;
    const done = written.get(key);
    if (done) return done;
    const rel = join(category, safeFile(name));
    writeFileSync(
      join(outDir, rel),
      `${JSON.stringify(flattenPreset(index, category, name).profile, null, 2)}\n`,
    );
    written.set(key, rel);
    return rel;
  };
  const manifest: Manifest = { printers: [], filaments: {} };
  const problems: string[] = [];
  for (const id of nozzlePrinters(index)) {
    const profile = flattenPreset(index, "machine", id).profile;
    const model = typeof profile.printer_model === "string" ? profile.printer_model : "";
    const modelId = modelIds[model];
    const nozzle = Number(firstValue(profile.nozzle_diameter));
    if (!model || !modelId || !(nozzle > 0)) {
      problems.push(
        `printer "${id}": printer_model "${model}", model_id ${modelId ?? "none"}, nozzle ${String(nozzle)}`,
      );
      continue;
    }
    manifest.printers.push({ id, model, modelId, nozzle, file: writePreset("machine", id) });
    const byType: Manifest["filaments"][string] = {};
    for (const type of types) {
      const pick = pickFilament(candidates, id, type);
      if (pick) {
        byType[type] = {
          profile: pick.profile,
          file: writePreset("filament", pick.profile),
          source: pick.source,
        };
      }
    }
    manifest.filaments[id] = byType;
  }
  if (problems.length > 0) {
    throw new Error(`menu printers the app could not identify:\n  ${problems.join("\n  ")}`);
  }
  writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

// ------------------------------------------------------------ version check

// Ported from the slicing gate's check-profile-version.mjs. The .opc layout
// follows OrcaSlicer src/libslic3r/PresetCacheFormat.cpp at v2.5.0 (commit
// 40ecc66): a 20-byte header (uint32 magic 0x4F52435A, the bytes "ZCRO";
// uint32 format version 2; uint64 body size; uint32 CRC-32), then a cereal
// body starting with the uint32 cache version (2), the vendor name and the
// vendor version, each a uint64 length and its bytes. PresetBundle.cpp writes
// that version as Semver::parse(<vendor>.json "version").to_string(), so
// "02.08.00.16" in BBL.json is "2.8.0.16" in BBL.opc.
const OPC_MAGIC = 0x4f52435a;
const OPC_FORMAT = 2;
const OPC_CACHE = 2;
const OPC_HEADER = 20;
const OPC_MAX_STAMP = 1024;

/** The cache version, vendor name and vendor version stamped in a .opc file. */
export function readOpcStamp(buf: Buffer): {
  cacheVersion: number;
  vendor: string;
  version: string;
} {
  if (buf.length < OPC_HEADER + 4) throw new Error("file too short for a preset cache header");
  const magic = buf.readUInt32LE(0);
  if (magic !== OPC_MAGIC) {
    throw new Error(`magic 0x${magic.toString(16)} is not ZCRO (0x${OPC_MAGIC.toString(16)})`);
  }
  const format = buf.readUInt32LE(4);
  if (format !== OPC_FORMAT) throw new Error(`format version ${format}, expected ${OPC_FORMAT}`);
  let at = OPC_HEADER;
  const cacheVersion = buf.readUInt32LE(at);
  at += 4;
  if (cacheVersion !== OPC_CACHE)
    throw new Error(`cache version ${cacheVersion}, expected ${OPC_CACHE}`);
  const readString = (): string => {
    if (at + 8 > buf.length) throw new Error("stamp length runs past the end of the file");
    const len = buf.readBigUInt64LE(at);
    at += 8;
    if (len > BigInt(OPC_MAX_STAMP) || at + Number(len) > buf.length) {
      throw new Error("stamp runs past the end of the file");
    }
    const s = buf.toString("latin1", at, at + Number(len));
    at += Number(len);
    return s;
  };
  const vendor = readString();
  const version = readString();
  return { cacheVersion, vendor, version };
}

/** True when two dotted versions have the same numbers in the same places. */
export function sameVersion(a: string, b: string): boolean {
  const parts = (v: string) => (/^\d+(\.\d+)*$/.test(v) ? v.split(".").map(Number) : null);
  const pa = parts(a);
  const pb = parts(b);
  return pa !== null && pb !== null && pa.length === pb.length && pa.every((n, i) => n === pb[i]);
}

/**
 * Checks <vendor>.json in the source tree against <vendor>.opc in the
 * AppImage's profiles folder, for BBL and the filament library. Throws on any
 * mismatch or unreadable stamp; returns one line per vendor checked.
 */
export function checkProfileVersions(sourceRoot: string, shippedRoot: string): string[] {
  return [VENDOR, LIBRARY].map((vendor) => {
    const json = readJson(join(sourceRoot, `${vendor}.json`));
    if (typeof json.version !== "string" || json.version === "") {
      throw new Error(`no version in ${vendor}.json`);
    }
    const stamp = readOpcStamp(readFileSync(join(shippedRoot, `${vendor}.opc`)));
    if (stamp.vendor !== vendor) {
      throw new Error(`${vendor}.opc names vendor ${stamp.vendor}, expected ${vendor}`);
    }
    if (!sameVersion(json.version, stamp.version)) {
      throw new Error(
        `profile version mismatch: ${vendor}.json ${json.version} but ${vendor}.opc ${stamp.version}`,
      );
    }
    return `${vendor} ${json.version} = ${stamp.version}`;
  });
}

export interface Profiles {
  printers: Array<{ id: string; model: string; modelId: string; nozzle: number }>;
  /** Each menu printer's default filament per type, sorted by printer then type. */
  filaments: Array<{ printer: string; type: string; profile: string; source: FilamentSource }>;
  /** Absolute path of a menu printer's flattened machine file, or null. */
  machineFile(printerId: string): string | null;
  /**
   * The default filament for a type on a menu printer, or null: the slice
   * then keeps the file's own filament for that slot.
   */
  filamentFor(
    printerId: string,
    type: string,
  ): { profile: string; file: string; source: FilamentSource } | null;
}

/** Reads the image's profile folder. Throws at start-up on a bad manifest. */
export function loadProfiles(dir: string): Profiles {
  let manifest: Manifest;
  try {
    manifest = manifestSchema.parse(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")));
  } catch (err) {
    throw new Error(`cannot read the profile manifest in ${dir}: ${(err as Error).message}`);
  }
  const byId = new Map(manifest.printers.map((p) => [p.id, p]));
  const filaments: Profiles["filaments"] = [];
  for (const printer of [...byId.keys()].sort()) {
    const byType = manifest.filaments[printer] ?? {};
    for (const type of Object.keys(byType).sort()) {
      const pick = byType[type];
      if (pick) filaments.push({ printer, type, profile: pick.profile, source: pick.source });
    }
  }
  return {
    printers: manifest.printers.map(({ id, model, modelId, nozzle }) => ({
      id,
      model,
      modelId,
      nozzle,
    })),
    filaments,
    machineFile: (printerId) => {
      const p = byId.get(printerId);
      return p ? join(dir, p.file) : null;
    },
    filamentFor: (printerId, type) => {
      if (!byId.has(printerId)) return null;
      const byType = manifest.filaments[printerId];
      const pick = byType && Object.hasOwn(byType, type) ? byType[type] : undefined;
      return pick
        ? { profile: pick.profile, file: join(dir, pick.file), source: pick.source }
        : null;
    },
  };
}

// ------------------------------------------------------------ build-time CLI

function isMain(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(argv1);
  } catch {
    return false;
  }
}

if (isMain()) {
  const args = process.argv.slice(2);
  const value = (flag: string): string | undefined => {
    const at = args.indexOf(flag);
    return at === -1 ? undefined : args[at + 1];
  };
  const source = value("--source");
  const shipped = value("--shipped");
  const out = value("--out");
  const processFull = value("--process-full");
  if (!source || !shipped || !out || !processFull) {
    process.stderr.write(
      "usage: profiles.js --source <profile JSON from Orca's source> --shipped <the AppImage's resources/profiles> --out <dir> --process-full <dir>\n",
    );
    process.exit(2);
  }
  try {
    for (const line of checkProfileVersions(source, shipped)) {
      process.stdout.write(`profile version match: ${line}\n`);
    }
    const index = loadIndex(source);
    const full = writeProcessFull(index, processFull);
    const manifest = buildProfiles(index, out);
    const picks = Object.values(manifest.filaments).reduce((n, t) => n + Object.keys(t).length, 0);
    process.stdout.write(
      `wrote ${full.files.length} default process presets for ${full.machines} instantiable machines to ${processFull}\n` +
        `wrote ${manifest.printers.length} menu printers and ${picks} printer x type filament picks to ${out}\n`,
    );
  } catch (err) {
    process.stderr.write(`profiles: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
