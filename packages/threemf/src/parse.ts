// Reads the plate data of a Bambu Studio .3mf. A port of the Bambu Plates
// parser (parser.rb@136fd61) with its AC-023 ceilings, plus the printer,
// process and MakerWorld fields Platehouse needs.
//
// Rules carried from that parser:
// - entries are read only by exact name, compared as the raw name bytes: a
//   backslash is not a slash, and the name of an entry the parser does not
//   read (one with '..' or an absolute path, say) never makes a damaged file;
// - the plate list comes from model_settings.config, else the plate_N.png
//   names; a plate index from either is kept only as a whole number from 1,
//   and one past 2147483647 is damage (next rule), not a skipped value;
// - a plate index or filament slot past 2147483647 is damage, whatever its
//   source, because plates.index and the slot columns are 32-bit Postgres
//   integers (#78);
// - every text value returned has NUL removed, because Postgres text cannot
//   hold it (#78); a value that was only NUL reads as absent;
// - a printer model id over 64 characters reads as absent, because it is
//   stored in a btree key that cannot hold a long one (#142);
// - every cap counts bytes actually inflated, never a declared size;
// - a colour is kept only as #RRGGBB or #RRGGBBAA;
// - only the parser's own reads of the file (opening the zip, listing it,
//   inflating an entry), the ceilings and the 32-bit rule above make a
//   damaged file (null); otherwise broken config XML or JSON costs that
//   entry only, while a plate index or filament slot past 2147483647 in
//   valid config costs the whole file;
// - a filesystem error is ReadUnavailable and never damage;
// - anything else reaches the caller unchanged: whatever onThumbnail throws,
//   and a bug in this file's own code. Neither is a file with no plate data.
import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";
import { XMLParser } from "fast-xml-parser";
import type yauzl from "yauzl";
import {
  HandleReader,
  listEntries,
  openArchive,
  ownRead,
  pump,
  readCapped,
  unavailableOr,
} from "./archive.js";
import { Damaged } from "./errors.js";
import { LIMITS, MODEL_PREFIX_BYTES } from "./limits.js";
import type { Filament, Plate, Project, ReadOptions } from "./types.js";

// The zip helpers live in archive.ts; model-xml.ts takes these two from here.
export { listEntries, ownRead } from "./archive.js";

const MODEL_SETTINGS = "Metadata/model_settings.config";
const SLICE_INFO = "Metadata/slice_info.config";
const PROJECT_SETTINGS = "Metadata/project_settings.config";
export const MODEL = "3D/3dmodel.model";
const PLATE_PNG = /^Metadata\/plate_([1-9][0-9]*)(_small)?\.png$/;
const COLOUR = /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/;
const INTEGER = /^\s*-?[0-9]+\s*$/;
/** The largest plate index or filament slot the database holds (Postgres integer). */
const MAX_STORED_INDEX = 2147483647;
/**
 * The longest printer model id kept for slicedFor, in UTF-16 code units (at
 * most 192 UTF-8 bytes). Bambu's ids are a few characters (C12, N2S). The id
 * is stored as estimates.printer_id, part of a btree unique key, and a btree
 * entry over 2704 bytes fails the insert and with it the upload (#142).
 */
const MAX_PRINTER_MODEL_ID_LENGTH = 64;
const RESOURCES = Buffer.from("<resources", "latin1");

/**
 * Reads one .3mf. Returns null when the file holds no Bambu plate data or
 * breaks any ceiling; the app shows NO_PLATE_DATA_MESSAGE for it. Throws
 * ReadUnavailable when the file cannot be read right now.
 */
export async function readProject(path: string, opts: ReadOptions = {}): Promise<Project | null> {
  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch (err) {
    throw unavailableOr(err);
  }
  try {
    let size: number;
    try {
      ({ size } = await handle.stat());
    } catch (err) {
      throw unavailableOr(err);
    }
    // readProjectFromReader classifies its own errors; what it rethrows
    // unclassified came from onThumbnail or a bug and must stay as it is.
    return await readProjectFromReader(new HandleReader(handle), size, opts);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * The same read over any yauzl random-access reader. Internal: readProject
 * uses it, and the tests use it to inject filesystem faults.
 */
export async function readProjectFromReader(
  reader: yauzl.RandomAccessReader,
  size: number,
  opts: ReadOptions = {},
): Promise<Project | null> {
  try {
    return await readArchive(reader, size, opts);
  } catch (err) {
    if (err instanceof CallerError) throw err.error;
    // Damaged comes only from ownRead (the zip reader and inflate), the
    // ceilings and storedIndex (a plate index or filament slot past the
    // 32-bit range, thrown from the config mapping), so a hostile file never
    // throws.
    if (err instanceof Damaged) return null;
    // ReadUnavailable from ownRead, or a bug in this file: either way the
    // caller sees it, never "No Bambu plate data in this file".
    throw err;
  }
}

/** Carries what onThumbnail threw past the classification above, untouched. */
class CallerError {
  readonly error: unknown;

  constructor(error: unknown) {
    this.error = error;
  }
}

async function readArchive(
  reader: yauzl.RandomAccessReader,
  size: number,
  opts: ReadOptions,
): Promise<Project | null> {
  // Entry names stay as the raw bytes the archive holds (openArchive).
  const zip = await openArchive(reader, size);
  try {
    const entries = await ownRead(() => listEntries(zip));
    const configText = async (name: string): Promise<string | null> => {
      const entry = entries.get(name);
      if (!entry) return null;
      return (await readCapped(zip, entry, LIMITS.configBytes)).toString("utf8");
    };

    const listed = platesFromModelSettings(await configText(MODEL_SETTINGS));
    const slices = sliceData(await configText(SLICE_INFO));
    const settings = projectSettings(await configText(PROJECT_SETTINGS));
    const list = listed ?? platesFromPngs(entries);
    if (list.length === 0) return null;

    let slicedFor: Project["slicedFor"];
    const plates: Plate[] = list.map(({ index, name, objectCount }) => {
      const s = slices.get(index);
      if (!s) return { index, name, objectCount, sliced: false, filaments: [] };
      slicedFor ??= s.slicedFor;
      const plate: Plate = {
        index,
        name,
        objectCount,
        sliced: true,
        predictionSeconds: s.predictionSeconds,
        filaments: s.filaments,
      };
      if (s.weightGrams !== undefined) plate.weightGrams = s.weightGrams;
      return plate;
    });

    const modelEntry = entries.get(MODEL);
    const makerWorldXml = modelEntry ? await readModelPrefix(zip, modelEntry) : undefined;

    const budget = thumbnailBudget(opts.maxThumbnailBytes);

    // Pass 1: every thumbnail must fit the file's budget before any is
    // handed over, so a caller never stores thumbnails of a file that turns
    // out damaged. Bytes are counted and dropped, never held. As in
    // parser.rb thumbnail_from: plate_N.png comes first, and an empty one or
    // one over LIMITS.pngBytes gives way to plate_N_small.png; a plate with
    // no usable entry has no thumbnail. Every byte read from a thumbnail
    // entry counts against the budget, a passed-over one included.
    const thumbs: Array<{ index: number; entry: yauzl.Entry }> = [];
    let total = 0;
    for (const { index } of plates) {
      for (const name of [`Metadata/plate_${index}.png`, `Metadata/plate_${index}_small.png`]) {
        const entry = entries.get(name);
        if (!entry) continue;
        const bytes = await countUpTo(zip, entry, LIMITS.pngBytes + 1);
        total += bytes;
        if (total > budget) throw new Damaged("thumbnails over budget");
        if (bytes > 0 && bytes <= LIMITS.pngBytes) {
          thumbs.push({ index, entry });
          break;
        }
      }
    }
    // Pass 2: hand them over one at a time, in plate order (Bambu Plates #11).
    // The same bytes again, so the checks below hold unless the file changed
    // under the read.
    if (opts.onThumbnail) {
      total = 0;
      for (const t of thumbs) {
        const png = await readCapped(zip, t.entry, LIMITS.pngBytes);
        total += png.length;
        if (total > budget) throw new Damaged("thumbnails over budget");
        try {
          await opts.onThumbnail(t.index, png);
        } catch (err) {
          throw new CallerError(err);
        }
      }
    }

    const project: Project = { plates, projectFilaments: settings.filaments };
    if (slicedFor) project.slicedFor = slicedFor;
    if (settings.processName !== undefined) project.processName = settings.processName;
    if (makerWorldXml !== undefined) project.makerWorldXml = makerWorldXml;
    return project;
  } finally {
    zip.close();
  }
}

/**
 * Inflates an entry until it ends or limit bytes have come out, and returns
 * how many bytes were taken, at most limit. Bytes past limit in the last
 * chunk are dropped, not counted, so the count is the same however the
 * inflated stream is chunked (parser.rb reads cap + 1 bytes the same way).
 */
async function countUpTo(zip: yauzl.ZipFile, entry: yauzl.Entry, limit: number): Promise<number> {
  let taken = 0;
  await pump(zip, entry, Number.POSITIVE_INFINITY, (chunk) => {
    taken = Math.min(limit, taken + chunk.length);
    return taken < limit;
  });
  return taken;
}

/** 3D/3dmodel.model up to <resources, at most MODEL_PREFIX_BYTES. Never damage by size. */
export async function readModelPrefix(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<string> {
  let buf = Buffer.alloc(0);
  let end = -1;
  await pump(zip, entry, Number.POSITIVE_INFINITY, (chunk) => {
    const from = Math.max(0, buf.length - RESOURCES.length + 1);
    buf = Buffer.concat([buf, chunk]);
    end = buf.indexOf(RESOURCES, from);
    return end < 0 && buf.length < MODEL_PREFIX_BYTES;
  });
  const stop = end < 0 ? buf.length : end;
  return withoutNul(buf.subarray(0, Math.min(stop, MODEL_PREFIX_BYTES)).toString("utf8"));
}

/**
 * The per-file thumbnail budget (parser.rb max_thumbnail_bytes):
 * maxThumbnailBytes when it is a positive finite number, never above
 * LIMITS.thumbnailBytesPerFile. Anything else (NaN from an unset setting,
 * zero, a negative number, Infinity) keeps the default, so the option can
 * neither lift the budget nor make every thumbnail count as damage. The
 * 10 MiB per-thumbnail ceiling, LIMITS.pngBytes, is fixed.
 */
function thumbnailBudget(asked: number | undefined): number {
  if (asked === undefined || !Number.isFinite(asked) || asked <= 0) {
    return LIMITS.thumbnailBytesPerFile;
  }
  return Math.min(asked, LIMITS.thumbnailBytesPerFile);
}

// --- XML ------------------------------------------------------------------

const ARRAY_TAGS = new Set(["plate", "metadata", "filament", "model_instance", "object"]);

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseAttributeValue: false,
  parseTagValue: false,
  // Values are taken exactly as written: " #FFFFFF" is not a colour.
  trimValues: false,
  // The five XML entities and numeric references only. Bambu's configs carry
  // no DTD, so any DOCTYPE is refused before parsing (see parseXml): no
  // external entity and no internal entity expansion is ever read.
  processEntities: true,
  htmlEntities: false,
  isArray: (name) => ARRAY_TAGS.has(name),
});

type Node = Record<string, unknown>;

/**
 * The <config> element of a config entry, or null when there is none. XML
 * that fast-xml-parser cannot parse counts as the entry being absent, as
 * Nokogiri's recovery does under parser.rb: a broken model_settings.config
 * costs the plate names (the png list takes over) and a broken
 * slice_info.config costs the slice data, never the whole file. A DTD is
 * still damage.
 */
function parseXml(text: string): Node | null {
  if (/<!DOCTYPE/i.test(text) || /<!ENTITY/i.test(text)) throw new Damaged("XML with a DTD");
  let doc: unknown;
  try {
    doc = xml.parse(text);
  } catch {
    return null;
  }
  if (!isNode(doc)) return null;
  const config = doc.config;
  return isNode(config) ? config : null;
}

function isNode(v: unknown): v is Node {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nodes(v: unknown): Node[] {
  return Array.isArray(v) ? v.filter(isNode) : [];
}

/** All of a node's raw children of one tag, whatever their shape. */
function count(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}

/** <metadata key="..." value="..."/> pairs; the first of a repeated key wins. */
function metadata(node: Node): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of nodes(node.metadata)) {
    const key = m.key;
    if (typeof key !== "string" || out.has(key)) continue;
    out.set(key, typeof m.value === "string" ? m.value : "");
  }
  return out;
}

function int(v: unknown): number | null {
  if (typeof v !== "string" || !INTEGER.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * A plate index or filament slot: int(v), except that a whole number past
 * MAX_STORED_INDEX is damage, never a skipped value. That covers numbers past
 * Number.MAX_SAFE_INTEGER too (Number gives Infinity for 400 digits), so no
 * size of number can become a plate or a slot the database cannot store.
 * Anything that is not a whole number stays null, as int has it.
 */
function storedIndex(v: unknown): number | null {
  if (typeof v === "string" && INTEGER.test(v) && Number(v) > MAX_STORED_INDEX) {
    throw new Damaged("plate index or filament slot past the 32-bit range");
  }
  return int(v);
}

/** The text with every NUL removed: Postgres text cannot hold one (#78). */
function withoutNul(s: string): string {
  return s.replaceAll("\u0000", "");
}

function nonNegative(v: unknown): number | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function colour(v: unknown): string | null {
  return typeof v === "string" && COLOUR.test(v) ? v : null;
}

interface Listed {
  index: number;
  name: string | null;
  objectCount: number;
}

function platesFromModelSettings(text: string | null): Listed[] | null {
  if (text === null) return null;
  const config = parseXml(text);
  if (!config) return null;
  const blocks = nodes(config.plate);
  if (count(config.plate) > LIMITS.plates) throw new Damaged("too many plates");
  const seen = new Map<number, Listed>();
  for (const block of blocks) {
    const meta = metadata(block);
    const index = storedIndex(meta.get("plater_id"));
    if (index === null || index < 1 || seen.has(index)) continue;
    const name = withoutNul(meta.get("plater_name") ?? "");
    seen.set(index, {
      index,
      // A blank name is no name, so the page shows "Plate N" for it.
      name: name.trim() === "" ? null : name,
      objectCount: count(block.model_instance),
    });
  }
  if (seen.size === 0) return null;
  return [...seen.values()].sort((a, b) => a.index - b.index);
}

function platesFromPngs(entries: Map<string, yauzl.Entry>): Listed[] {
  const indexes = new Set<number>();
  for (const name of entries.keys()) {
    // The same check as plater_id: a name whose N is past 2147483647, of
    // any length, is damage (#78).
    const index = storedIndex(PLATE_PNG.exec(name)?.[1]);
    if (index !== null) indexes.add(index);
  }
  if (indexes.size > LIMITS.plates) throw new Damaged("too many plate thumbnails");
  return [...indexes].sort((a, b) => a - b).map((index) => ({ index, name: null, objectCount: 0 }));
}

interface Slice {
  predictionSeconds: number;
  weightGrams?: number;
  filaments: Filament[];
  slicedFor?: { printerModelId: string; nozzle: number };
}

function sliceData(text: string | null): Map<number, Slice> {
  const out = new Map<number, Slice>();
  if (text === null) return out;
  const config = parseXml(text);
  if (!config) return out;
  if (count(config.plate) > LIMITS.plates) throw new Damaged("too many sliced plates");
  for (const block of nodes(config.plate)) {
    if (count(block.filament) > LIMITS.filaments) throw new Damaged("too many plate filaments");
    const meta = metadata(block);
    const index = storedIndex(meta.get("index"));
    const prediction = int(meta.get("prediction"));
    if (index === null || index < 1 || out.has(index)) continue;
    if (prediction === null || prediction < 1 || prediction > LIMITS.predictionSeconds) continue;
    const slice: Slice = {
      predictionSeconds: prediction,
      filaments: nodes(block.filament).map((f, i) => {
        const slot = storedIndex(f.id);
        return {
          slot: slot !== null && slot >= 1 ? slot : i + 1,
          type: typeof f.type === "string" ? withoutNul(f.type) : "",
          colour: colour(f.color),
          grams: nonNegative(f.used_g),
        };
      }),
    };
    const weight = nonNegative(meta.get("weight"));
    if (weight !== null) slice.weightGrams = weight;
    const printerModelId = withoutNul(meta.get("printer_model_id") ?? "");
    const nozzle = nonNegative(
      meta
        .get("nozzle_diameters")
        ?.trim()
        .split(/[\s,;]+/)[0],
    );
    // An over-long id reads as absent, like an empty one, so the file is
    // still stored with its plates (MAX_PRINTER_MODEL_ID_LENGTH).
    const keptId = printerModelId !== "" && printerModelId.length <= MAX_PRINTER_MODEL_ID_LENGTH;
    if (keptId && nozzle !== null && nozzle > 0) {
      slice.slicedFor = { printerModelId, nozzle };
    }
    out.set(index, slice);
  }
  return out;
}

// --- project_settings.config (JSON) ----------------------------------------

function strings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === "string" ? withoutNul(x) : ""));
}

function projectSettings(text: string | null): { filaments: Filament[]; processName?: string } {
  if (text === null) return { filaments: [] };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    // A broken settings file costs the filament list, not the plates.
    return { filaments: [] };
  }
  if (!isNode(data)) return { filaments: [] };
  const types = strings(data.filament_type);
  const colours = strings(data.filament_colour);
  if (types.length > LIMITS.filaments || colours.length > LIMITS.filaments) {
    throw new Damaged("too many project filaments");
  }
  const filaments = types.map((type, i) => ({
    slot: i + 1,
    type,
    colour: colour(colours[i]),
    grams: null,
  }));
  const raw = data.print_settings_id;
  const first = Array.isArray(raw) ? raw[0] : raw;
  const process = typeof first === "string" ? withoutNul(first) : "";
  return process !== "" ? { filaments, processName: process } : { filaments };
}
