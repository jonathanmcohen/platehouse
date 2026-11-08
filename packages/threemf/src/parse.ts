// Reads the plate data of a Bambu Studio .3mf. A port of the Bambu Plates
// parser (parser.rb@136fd61) with its AC-023 ceilings, plus the printer,
// process and MakerWorld fields Platehouse needs.
//
// Rules carried from that parser:
// - entries are read only by exact name, compared as the raw name bytes: a
//   backslash is not a slash, and the name of an entry the parser does not
//   read (one with '..' or an absolute path, say) never makes a damaged file;
// - the plate list comes from model_settings.config, else the plate_N.png
//   names; a plate index from either is kept only as a safe integer from 1;
// - every cap counts bytes actually inflated, never a declared size;
// - a colour is kept only as #RRGGBB or #RRGGBBAA;
// - only the parser's own reads of the file (opening the zip, listing it,
//   inflating an entry) and the ceilings make a damaged file (null); broken
//   config XML or JSON costs that entry only;
// - a filesystem error is ReadUnavailable and never damage;
// - anything else reaches the caller unchanged: whatever onThumbnail throws,
//   and a bug in this file's own code. Neither is a file with no plate data.
import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import { XMLParser } from "fast-xml-parser";
import yauzl from "yauzl";
import { Damaged, isSystemError, ReadUnavailable } from "./errors.js";
import { LIMITS, MAX_ZIP_ENTRIES, MODEL_PREFIX_BYTES } from "./limits.js";
import type { Filament, Plate, Project, ReadOptions } from "./types.js";

const MODEL_SETTINGS = "Metadata/model_settings.config";
const SLICE_INFO = "Metadata/slice_info.config";
const PROJECT_SETTINGS = "Metadata/project_settings.config";
const MODEL = "3D/3dmodel.model";
const PLATE_PNG = /^Metadata\/plate_([1-9][0-9]*)(_small)?\.png$/;
const COLOUR = /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/;
const INTEGER = /^\s*-?[0-9]+\s*$/;
const RESOURCES = Buffer.from("<resources", "latin1");
const READ_CHUNK = 64 * 1024;

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
    // Damaged comes only from ownRead (the zip reader and inflate) and the
    // ceilings, so a hostile file never throws.
    if (err instanceof Damaged) return null;
    // ReadUnavailable from ownRead, or a bug in this file: either way the
    // caller sees it, never "No Bambu plate data in this file".
    throw err;
  }
}

/**
 * Runs one of the parser's own reads of the archive (yauzl or inflate) and
 * classifies what it throws: a filesystem error is ReadUnavailable, anything
 * else is Damaged. The parser.rb@136fd61 damaged_on_read_error. It never
 * wraps the parser's mapping code or the caller's callback.
 */
async function ownRead<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if (err instanceof Damaged || err instanceof ReadUnavailable) throw err;
    if (isSystemError(err)) throw new ReadUnavailable(err);
    throw new Damaged(`unreadable archive: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Carries what onThumbnail threw past the classification above, untouched. */
class CallerError {
  readonly error: unknown;

  constructor(error: unknown) {
    this.error = error;
  }
}

function unavailableOr(err: unknown): unknown {
  if (err instanceof ReadUnavailable) return err;
  return isSystemError(err) ? new ReadUnavailable(err) : err;
}

class HandleReader extends yauzl.RandomAccessReader {
  private readonly handle: FileHandle;

  constructor(handle: FileHandle) {
    super();
    this.handle = handle;
  }

  // Positional reads on the one handle. A FileHandle read stream is not used
  // because destroying it early closes the shared handle.
  override _readStreamForRange(start: number, end: number): Readable {
    const handle = this.handle;
    let position = start;
    return new Readable({
      highWaterMark: READ_CHUNK,
      read(): void {
        const length = Math.min(READ_CHUNK, end - position);
        if (length <= 0) {
          this.push(null);
          return;
        }
        handle.read(Buffer.alloc(length), 0, length, position).then(
          ({ buffer, bytesRead }) => {
            position += bytesRead;
            // A short file ends the stream; yauzl then reports the missing
            // bytes as damage.
            this.push(bytesRead === 0 ? null : buffer.subarray(0, bytesRead));
          },
          (err: Error) => this.destroy(err),
        );
      },
    });
  }

  override read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    callback: (err: Error | null, bytesRead?: number) => void,
  ): void {
    this.handle.read(buffer, offset, length, position).then(
      ({ bytesRead }) => callback(null, bytesRead),
      (err: Error) => callback(err),
    );
  }
}

async function readArchive(
  reader: yauzl.RandomAccessReader,
  size: number,
  opts: ReadOptions,
): Promise<Project | null> {
  // decodeStrings: false keeps every entry name as the bytes the archive
  // holds. Decoding would turn a backslash into a slash (so
  // Metadata\model_settings.config would pass for the Bambu entry), honour
  // an Info-ZIP Unicode Path field over the real name, and make the whole
  // file damaged when any entry, even one never read, has '..' or an
  // absolute path. listEntries keys on those bytes instead.
  const zip = await ownRead(() =>
    yauzl.fromRandomAccessReaderPromise(reader, size, {
      lazyEntries: true,
      autoClose: false,
      validateEntrySizes: true,
      decodeStrings: false,
    }),
  );
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
 * Lists the entries once, keyed by the raw name bytes read as latin1: one
 * character per byte, so a key equals a Bambu name only when the bytes are
 * exactly that ASCII name. The first entry of a duplicated name wins.
 */
function listEntries(zip: yauzl.ZipFile): Promise<Map<string, yauzl.Entry>> {
  return new Promise((resolve, reject) => {
    const entries = new Map<string, yauzl.Entry>();
    let count = 0;
    const done = (fn: () => void): void => {
      zip.removeAllListeners("entry");
      zip.removeAllListeners("end");
      zip.removeAllListeners("error");
      zip.on("error", () => undefined);
      fn();
    };
    zip.on("entry", (entry: yauzl.Entry) => {
      count++;
      if (count > MAX_ZIP_ENTRIES) {
        done(() => reject(new Damaged("too many entries")));
        return;
      }
      const name = entry.fileNameRaw.toString("latin1");
      if (!entries.has(name)) entries.set(name, entry);
      zip.readEntry();
    });
    zip.on("end", () => done(() => resolve(entries)));
    zip.on("error", (err: Error) => done(() => reject(err)));
    zip.readEntry();
  });
}

function openStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => (err ? reject(err) : resolve(stream)));
  });
}

/**
 * Streams an entry through inflate and hands each chunk to take. take returns
 * false to stop early. Throws Damaged once more than cap bytes have come out.
 */
async function pump(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry,
  cap: number,
  take: (chunk: Buffer) => boolean,
): Promise<number> {
  const stream = await ownRead(() => openStream(zip, entry));
  const chunks = (stream as AsyncIterable<Buffer>)[Symbol.asyncIterator]();
  let total = 0;
  try {
    // Only pulling the next inflated chunk is a read of the file; take and
    // the cap check are the parser's own code.
    for (;;) {
      const next = await ownRead(() => chunks.next());
      if (next.done) break;
      const chunk = next.value;
      total += chunk.length;
      if (total > cap) throw new Damaged(`entry over ${cap} bytes`);
      if (!take(chunk)) break;
    }
  } finally {
    stream.on("error", () => undefined);
    stream.destroy();
  }
  return total;
}

async function readCapped(zip: yauzl.ZipFile, entry: yauzl.Entry, cap: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await pump(zip, entry, cap, (chunk) => {
    chunks.push(chunk);
    return true;
  });
  return Buffer.concat(chunks);
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
async function readModelPrefix(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<string> {
  let buf = Buffer.alloc(0);
  let end = -1;
  await pump(zip, entry, Number.POSITIVE_INFINITY, (chunk) => {
    const from = Math.max(0, buf.length - RESOURCES.length + 1);
    buf = Buffer.concat([buf, chunk]);
    end = buf.indexOf(RESOURCES, from);
    return end < 0 && buf.length < MODEL_PREFIX_BYTES;
  });
  const stop = end < 0 ? buf.length : end;
  return buf.subarray(0, Math.min(stop, MODEL_PREFIX_BYTES)).toString("utf8");
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
    const index = int(meta.get("plater_id"));
    if (index === null || index < 1 || seen.has(index)) continue;
    const name = meta.get("plater_name") ?? "";
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
    // The same safe-integer check as plater_id: a name whose N is past
    // Number.MAX_SAFE_INTEGER (from 9007199254740992, so every name of 17
    // digits or more) is not a plate.
    const index = int(PLATE_PNG.exec(name)?.[1]);
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
    const index = int(meta.get("index"));
    const prediction = int(meta.get("prediction"));
    if (index === null || index < 1 || out.has(index)) continue;
    if (prediction === null || prediction < 1 || prediction > LIMITS.predictionSeconds) continue;
    const slice: Slice = {
      predictionSeconds: prediction,
      filaments: nodes(block.filament).map((f, i) => {
        const slot = int(f.id);
        return {
          slot: slot !== null && slot >= 1 ? slot : i + 1,
          type: typeof f.type === "string" ? f.type : "",
          colour: colour(f.color),
          grams: nonNegative(f.used_g),
        };
      }),
    };
    const weight = nonNegative(meta.get("weight"));
    if (weight !== null) slice.weightGrams = weight;
    const printerModelId = meta.get("printer_model_id") ?? "";
    const nozzle = nonNegative(
      meta
        .get("nozzle_diameters")
        ?.trim()
        .split(/[\s,;]+/)[0],
    );
    if (printerModelId !== "" && nozzle !== null && nozzle > 0) {
      slice.slicedFor = { printerModelId, nozzle };
    }
    out.set(index, slice);
  }
  return out;
}

// --- project_settings.config (JSON) ----------------------------------------

function strings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === "string" ? x : ""));
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
  const process = Array.isArray(raw) ? raw[0] : raw;
  return typeof process === "string" && process !== ""
    ? { filaments, processName: process }
    : { filaments };
}
