// Reads the metadata the slicing gate needs from a Bambu Studio .3mf: the
// plate list, Bambu's own per-plate numbers, the printer the file was sliced
// for, and the project's filament types and key process values.
//
// It follows the Bambu Plates parser (parser.rb@136fd61): entries are read
// only by exact name, every entry is capped on inflated bytes, and the
// AC-023 ceilings apply. It never returns object names, plate names or any
// other designer text.
import { openZip, ZipDamaged } from "./zip.mjs";

export const LIMITS = Object.freeze({
  configBytes: 5 * 1024 * 1024,
  plates: 128,
  filaments: 256,
  predictionSeconds: 10 * 365 * 24 * 60 * 60,
});

const MODEL_SETTINGS = "Metadata/model_settings.config";
const SLICE_INFO = "Metadata/slice_info.config";
const PROJECT_SETTINGS = "Metadata/project_settings.config";
// The packages/threemf rule (parse.ts): N has no leading zero, and a name
// whose N is past MAX_STORED_INDEX makes the file damaged (see storedIndex).
const PLATE_PNG = /^Metadata\/plate_([1-9][0-9]*)(?:_small)?\.png$/;
const INTEGER = /^\s*-?[0-9]+\s*$/;
// The largest plate index or filament slot the app's database holds (a
// 32-bit Postgres integer), as MAX_STORED_INDEX in packages/threemf.
const MAX_STORED_INDEX = 2147483647;

class Damaged extends Error {}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decode(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[e];
  });
}

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([A-Za-z_][\w.-]*)\s*=\s*"([^"]*)"/g)) out[m[1]] = decode(m[2]);
  return out;
}

// Bambu's config XML is machine-written and flat: <plate> blocks holding
// self-closing <metadata key value/> and <filament .../> tags. A regular
// reader over that shape is enough here; it never expands entities beyond
// the five XML ones and numeric references, and it ignores DTDs entirely.
function plateBlocks(xml) {
  return [...xml.matchAll(/<plate\b[^>]*>([\s\S]*?)<\/plate>/g)].map((m) => m[1]);
}

function metadata(block) {
  const meta = {};
  for (const m of block.matchAll(/<metadata\b[^>]*?\/?>/g)) {
    const a = attrs(m[0]);
    if (a.key !== undefined && !(a.key in meta)) meta[a.key] = a.value ?? "";
  }
  return meta;
}

// The packages/threemf rule (parse.ts int()): plain digits that make a safe
// integer, or null. From 9007199254740992 up a number is rounded, so a
// 17-digit plater_id would be read as a different plate (issue #129).
function int(v) {
  if (typeof v !== "string" || !INTEGER.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

// The packages/threemf rule (parse.ts storedIndex) for a plate index or a
// filament slot: int(v), except that a whole number past MAX_STORED_INDEX is
// damage, never a skipped value (issue #137). The app stores such a file with
// no plate data, so the gate must not read plates from it either. That covers
// numbers past Number.MAX_SAFE_INTEGER too, which Number() rounds or turns
// into Infinity.
function storedIndex(v) {
  if (typeof v === "string" && INTEGER.test(v) && Number(v) > MAX_STORED_INDEX) throw new Damaged();
  return int(v);
}

function num(v) {
  if (typeof v !== "string" || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function readText(zip, name) {
  const buf = zip.readEntry(name, LIMITS.configBytes);
  return buf === null ? null : buf.toString("utf8");
}

function platesFromModelSettings(zip) {
  const xml = readText(zip, MODEL_SETTINGS);
  if (xml === null) return null;
  const blocks = plateBlocks(xml);
  if (blocks.length > LIMITS.plates) throw new Damaged();
  const seen = new Map();
  for (const block of blocks) {
    const index = storedIndex(metadata(block).plater_id);
    if (index === null || index < 1 || seen.has(index)) continue;
    seen.set(index, (block.match(/<model_instance\b/g) ?? []).length);
  }
  if (seen.size === 0) return null;
  return [...seen.entries()].map(([index, objectCount]) => ({ index, objectCount }));
}

function platesFromPngs(zip) {
  const indexes = new Set();
  for (const name of zip.names()) {
    // The same check as plater_id: a name whose N is past 2147483647, of any
    // length, is damage, so no rounded or Infinity number becomes a plate.
    const index = storedIndex(PLATE_PNG.exec(name)?.[1]);
    if (index !== null) indexes.add(index);
  }
  if (indexes.size > LIMITS.plates) throw new Damaged();
  return [...indexes].sort((a, b) => a - b).map((index) => ({ index, objectCount: null }));
}

function sliceData(zip) {
  const xml = readText(zip, SLICE_INFO);
  const result = new Map();
  const keys = { printer_model_id: false, nozzle_diameters: false };
  if (xml === null) return { result, keys };
  const blocks = plateBlocks(xml);
  if (blocks.length > LIMITS.plates) throw new Damaged();
  for (const block of blocks) {
    const filamentTags = [...block.matchAll(/<filament\b[^>]*?\/?>/g)];
    if (filamentTags.length > LIMITS.filaments) throw new Damaged();
    const meta = metadata(block);
    if ("printer_model_id" in meta) keys.printer_model_id = true;
    if ("nozzle_diameters" in meta) keys.nozzle_diameters = true;
    const index = storedIndex(meta.index);
    const prediction = int(meta.prediction);
    if (index === null || prediction === null || result.has(index)) continue;
    if (prediction < 1 || prediction > LIMITS.predictionSeconds) continue;
    result.set(index, {
      predictionSeconds: prediction,
      weightGrams: num(meta.weight),
      printerModelId: meta.printer_model_id ?? null,
      nozzle: meta.nozzle_diameters ?? null,
      filaments: filamentTags.map((m) => {
        const a = attrs(m[0]);
        return { slot: storedIndex(a.id), type: a.type ?? null, grams: num(a.used_g) };
      }),
    });
  }
  return { result, keys };
}

function first(v) {
  if (Array.isArray(v)) return v.length > 0 && v[0] !== null ? String(v[0]) : null;
  return v === undefined || v === null ? null : String(v);
}

function projectSettings(zip) {
  const empty = {
    project: {
      printerModel: null,
      printerSettingsId: null,
      nozzleDiameter: null,
      printSettingsId: null,
      filamentTypes: [],
      layerHeight: null,
      wallLoops: null,
      sparseInfillDensity: null,
    },
    keys: { printer_model: false, printer_settings_id: false, nozzle_diameter: false, print_settings_id: false },
  };
  const text = readText(zip, PROJECT_SETTINGS);
  if (text === null) return empty;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return empty;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return empty;
  const types = Array.isArray(data.filament_type) ? data.filament_type.map(String) : [];
  if (types.length > LIMITS.filaments) throw new Damaged();
  return {
    project: {
      printerModel: first(data.printer_model),
      printerSettingsId: first(data.printer_settings_id),
      nozzleDiameter: first(data.nozzle_diameter),
      printSettingsId: first(data.print_settings_id),
      filamentTypes: types,
      layerHeight: first(data.layer_height),
      wallLoops: first(data.wall_loops),
      sparseInfillDensity: first(data.sparse_infill_density),
    },
    keys: {
      printer_model: "printer_model" in data,
      printer_settings_id: "printer_settings_id" in data,
      nozzle_diameter: "nozzle_diameter" in data,
      print_settings_id: "print_settings_id" in data,
    },
  };
}

/**
 * Returns the gate's view of one .3mf, or null when the file holds no Bambu
 * plate data or is damaged. Filesystem errors are thrown to the caller.
 */
export function readProjectMeta(path) {
  let zip;
  try {
    zip = openZip(path);
  } catch (err) {
    if (err instanceof ZipDamaged) return null;
    throw err;
  }
  try {
    const plates = platesFromModelSettings(zip) ?? platesFromPngs(zip);
    if (plates.length === 0) return null;
    const slices = sliceData(zip);
    const settings = projectSettings(zip);
    let slicedFor = null;
    const out = plates.map(({ index, objectCount }) => {
      const s = slices.result.get(index);
      if (!s) {
        return { index, objectCount, sliced: false, predictionSeconds: null, weightGrams: null, filaments: [] };
      }
      if (slicedFor === null && (s.printerModelId !== null || s.nozzle !== null)) {
        slicedFor = { printerModelId: s.printerModelId, nozzle: s.nozzle };
      }
      return {
        index,
        objectCount,
        sliced: true,
        predictionSeconds: s.predictionSeconds,
        weightGrams: s.weightGrams,
        filaments: s.filaments,
      };
    });
    return {
      plates: out,
      slicedFor,
      project: settings.project,
      keys: { sliceInfo: slices.keys, projectSettings: settings.keys },
    };
  } catch (err) {
    if (err instanceof ZipDamaged || err instanceof Damaged) return null;
    throw err;
  } finally {
    zip.close();
  }
}
