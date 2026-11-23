// Reads the objects on one plate of a Bambu Studio .3mf as meshes, with
// where each sits and the colour of the filament it prints with, for the
// plate's 3D view (issue #358). The server turns the result into a GLB.
//
// Where things are in the file:
// - Metadata/model_settings.config lists each plate's objects
//   (<model_instance> object_id and instance_id), each object's filament
//   (<metadata key="extruder">) and its parts, each with its own filament
//   and subtype; only a normal part is printed, so a modifier, a negative
//   volume and a support blocker or enforcer are left out of the view;
// - Metadata/project_settings.config has the filament colours
//   (filament_colour, by filament number from 1);
// - 3D/3dmodel.model holds the objects and the build items that place
//   them. An object is a mesh, or components, each naming an object in the
//   same part or, through the production extension's p:path, in another
//   part such as 3D/Objects/object_1.model, with a transform of its own.
//   Bambu Studio writes both layouts: every mesh in 3D/3dmodel.model, or
//   each object's meshes in a part of its own. An object with several
//   instances has one build item per instance, and instance_id counts them
//   from 0 in file order.
//
// The limits hold by construction (review findings #383, #384). One Budget
// per call is the only way the reader allocates a mesh array or takes an
// inflated byte, and each is charged before it happens:
// - memory: every Float32Array and Uint32Array of mesh data is made by
//   Budget.float32 or Budget.uint32, which refuse one that would take all
//   the arrays allocated in the read past limits.meshBytes. A freed array
//   keeps its charge until the read ends (its memory is only freed by a
//   later garbage collection). A mesh is read into fixed blocks and copied
//   once at the end, so it costs at most twice its size plus two blocks;
// - inflate: every byte inflated, the config entries and every read of
//   every model part, is charged to Budget.inflate before it is used, against
//   one total, limits.inflateBytes;
// - work: every character the tag scanner looks at (an unfinished tag that
//   is looked at again counted again), every config character parsed and
//   every step of the component walk is charged to Budget.step;
// - placing: each mesh placed on the plate charges its triangles (counted
//   while its part was first read, before the mesh itself is read) against
//   limits.triangles, and each component followed counts against
//   limits.instances, when it is placed, not when the result is assembled.
// When a charge would pass a limit, the read stops there with too_large, and
// everything it held is freed. Each model part is read at most twice: once
// for its objects (collecting the meshes already known to be needed), and
// once more only if the walk later finds other meshes in it are needed.
//
// Other rules, carried from parse.ts where they apply:
// - entries are found by their raw name bytes, and only the parts the plate
//   needs are inflated: 3D/3dmodel.model and the parts its components name;
// - a model part is read as a stream of tags (xml-scan.ts), never whole;
// - a filesystem error is ReadUnavailable and never a problem with the file;
// - anything else wrong with the file is a PlateMeshError with its problem:
//   no_plate (the file lists no such plate), no_objects (the plate is
//   empty), no_mesh (nothing on the plate has a mesh that can be read),
//   too_large (over a limit) or damaged (the archive or a part it needs
//   cannot be read). A plate where some objects can be read and others
//   cannot shows the ones that can.
//
// Colours: an object prints with filament 1 unless it names another; a part
// naming filament 0 or none uses its object's. A colour is kept only as
// #RRGGBB (an #RRGGBBAA colour loses its alpha, since the view draws every
// object solid); anything else, or a filament past the colour list, is no
// colour. Painted colours (per triangle) are not read: a painted object
// shows in its own filament's colour.
import { open } from "node:fs/promises";
import { XMLParser } from "fast-xml-parser";
import type yauzl from "yauzl";
import { HandleReader, listEntries, openArchive, ownRead, pump, unavailableOr } from "./archive.js";
import { Damaged } from "./errors.js";
import { LIMITS } from "./limits.js";
import { attrs, TagScanner } from "./xml-scan.js";

const MODEL_SETTINGS = "Metadata/model_settings.config";
/** A plate picture; the page lists plates from these when the settings name none. */
const PLATE_PICTURE = /^Metadata\/plate_([1-9][0-9]*)(?:_small)?\.png$/;
const PROJECT_SETTINGS = "Metadata/project_settings.config";
const ROOT = "3D/3dmodel.model";
const COLOUR = /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/;
const WHOLE = /^\s*[0-9]+\s*$/;
const MiB = 1024 * 1024;

/** Why a plate has no 3D view. */
export type PlateMeshProblem = "no_plate" | "no_objects" | "no_mesh" | "too_large" | "damaged";

export class PlateMeshError extends Error {
  readonly problem: PlateMeshProblem;

  constructor(problem: PlateMeshProblem, detail: string) {
    super(detail);
    this.name = "PlateMeshError";
    this.problem = problem;
  }
}

export interface PlateMeshLimits {
  /** Triangles drawn on the plate, every placed copy counted. */
  triangles: number;
  /** Bytes of mesh arrays alive at any moment. */
  meshBytes: number;
  /** Bytes inflated in all, over the config entries and every read of every model part. */
  inflateBytes: number;
  /** Parsing work: characters scanned and parsed, and steps of the component walk. */
  work: number;
  /** Meshes placed on one plate, counted as components are followed. */
  instances: number;
  /** Components and build items held over the model parts read. */
  components: number;
  /** How deep components may nest. */
  depth: number;
}

export const PLATE_MESH_LIMITS: Readonly<PlateMeshLimits> = Object.freeze({
  triangles: 5_000_000,
  meshBytes: 256 * MiB,
  inflateBytes: 1024 * MiB,
  work: 200_000_000,
  instances: 10_000,
  components: 100_000,
  depth: 16,
});

/** What one read used, for a caller that wants to see it (the tests). */
export interface PlateMeshBudgetReport {
  /** The limits the read ran under. */
  limits: Readonly<PlateMeshLimits>;
  /** The most bytes of mesh arrays owned at once (freed ones do not count). */
  peakLiveBytes: number;
  /** Bytes of mesh arrays still alive when the read ended: the result's, or 0. */
  liveBytes: number;
  /** Bytes of mesh arrays allocated in all, freed ones too: this is what meshBytes limits. */
  allocatedBytes: number;
  inflatedBytes: number;
  work: number;
  /** Triangles drawn, every placed copy counted. */
  drawnTriangles: number;
}

/** One mesh, in its object's own coordinates. */
export interface MeshPiece {
  /** x, y, z per vertex, in millimetres, Z up. */
  positions: Float32Array;
  /** Three vertex numbers per triangle, counter-clockwise from outside. */
  indices: Uint32Array;
  /** The filament's #RRGGBB, or null when the file gives none. */
  colour: string | null;
}

/** A piece placed on the plate. */
export interface MeshInstance {
  piece: number;
  /**
   * The 3MF transform from the piece's coordinates to the plate's: m00 m01
   * m02 m10 m11 m12 m20 m21 m22 m30 m31 m32, for row vectors, so a point
   * (x, y, z) goes to x*m00 + y*m10 + z*m20 + m30, and so on.
   */
  transform: number[];
}

export interface PlateMesh {
  plate: number;
  pieces: MeshPiece[];
  instances: MeshInstance[];
  /** Triangles drawn, every instance counted. */
  triangles: number;
}

export interface PlateMeshOptions {
  /** Lowers limits.triangles; the same as limits: { triangles }. */
  maxTriangles?: number;
  /**
   * Lowers any limit. A value that is not a positive finite number, or is
   * above the default (PLATE_MESH_LIMITS), is ignored: a limit can only be
   * lowered.
   */
  limits?: Partial<PlateMeshLimits>;
  /** Told what the read used when it ends, however it ends. */
  onBudget?: (report: PlateMeshBudgetReport) => void;
}

/**
 * The objects on plate `plate` (Bambu's plate number, from 1). Throws
 * PlateMeshError when the plate has no 3D view, and ReadUnavailable when the
 * file cannot be read right now.
 */
export async function readPlateMesh(
  path: string,
  plate: number,
  opts: PlateMeshOptions = {},
): Promise<PlateMesh> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "r");
  } catch (err) {
    throw unavailableOr(err);
  }
  const budget = new Budget(limitsOf(opts));
  try {
    let size: number;
    try {
      ({ size } = await handle.stat());
    } catch (err) {
      throw unavailableOr(err);
    }
    try {
      const mesh = await readFromArchive(new HandleReader(handle), size, plate, budget);
      budget.keepOnly(mesh);
      return mesh;
    } catch (err) {
      budget.freeAll();
      // Damaged comes only from the zip reader, inflate, the config caps and
      // the tag scanner; a ReadUnavailable or a bug reaches the caller as is.
      if (err instanceof Damaged) throw new PlateMeshError("damaged", err.message);
      throw err;
    }
  } finally {
    await handle.close().catch(() => undefined);
    opts.onBudget?.(budget.report());
  }
}

function limitsOf(opts: PlateMeshOptions): PlateMeshLimits {
  const asked: Partial<PlateMeshLimits> = { ...opts.limits };
  if (opts.maxTriangles !== undefined) asked.triangles = opts.maxTriangles;
  const out = { ...PLATE_MESH_LIMITS };
  for (const key of Object.keys(out) as Array<keyof PlateMeshLimits>) {
    const v = asked[key];
    if (v !== undefined && Number.isFinite(v) && v > 0 && v <= out[key]) out[key] = v;
  }
  return out;
}

// --- The budget -------------------------------------------------------------------

/**
 * Everything one read may use, charged before it is used. The only maker
 * of mesh arrays and the only taker of inflated bytes in this file.
 */
class Budget {
  readonly limits: Readonly<PlateMeshLimits>;
  private readonly owned = new Set<Float32Array | Uint32Array>();
  private live = 0;
  private peak = 0;
  private allocated = 0;
  private inflated = 0;
  private worked = 0;
  private drawn = 0;
  private held = 0;

  constructor(limits: PlateMeshLimits) {
    this.limits = Object.freeze(limits);
  }

  private over(what: string): never {
    throw new PlateMeshError("too_large", `${what} over the limit`);
  }

  private charge(bytes: number): void {
    // Against everything allocated so far, not what is alive: V8 frees an
    // array's memory only at a later garbage collection, so a freed array
    // still counts until the read ends.
    if (this.allocated + bytes > this.limits.meshBytes) this.over("mesh memory");
    this.live += bytes;
    this.allocated += bytes;
    if (this.live > this.peak) this.peak = this.live;
  }

  float32(length: number): Float32Array {
    this.charge(length * 4);
    const a = new Float32Array(length);
    this.owned.add(a);
    return a;
  }

  uint32(length: number): Uint32Array {
    this.charge(length * 4);
    const a = new Uint32Array(length);
    this.owned.add(a);
    return a;
  }

  /**
   * Drops an array this budget made from the ones in use (so liveBytes is
   * right); anything else is ignored. Its charge stays: the memory is not
   * back until the garbage collector runs.
   */
  free(a: Float32Array | Uint32Array): void {
    if (!this.owned.delete(a)) return;
    this.live -= a.byteLength;
  }

  freeAll(): void {
    for (const a of [...this.owned]) this.free(a);
  }

  /** Frees every array the mesh does not use. */
  keepOnly(mesh: PlateMesh): void {
    const used = new Set<ArrayBufferLike>();
    for (const p of mesh.pieces) {
      used.add(p.positions.buffer);
      used.add(p.indices.buffer);
    }
    for (const a of [...this.owned]) if (!used.has(a.buffer)) this.free(a);
  }

  inflate(bytes: number): void {
    if (this.inflated + bytes > this.limits.inflateBytes) this.over("bytes inflated");
    this.inflated += bytes;
  }

  step(units = 1): void {
    if (this.worked + units > this.limits.work) this.over("parsing work");
    this.worked += units;
  }

  place(triangles: number): void {
    if (this.drawn + triangles > this.limits.triangles) this.over("triangles drawn");
    this.drawn += triangles;
  }

  component(): void {
    if (++this.held > this.limits.components) this.over("components and build items");
  }

  report(): PlateMeshBudgetReport {
    return {
      limits: this.limits,
      peakLiveBytes: this.peak,
      liveBytes: this.live,
      allocatedBytes: this.allocated,
      inflatedBytes: this.inflated,
      work: this.worked,
      drawnTriangles: this.drawn,
    };
  }
}

/** Inflates an entry through the budget, handing each chunk on once it is charged. */
async function inflateEntry(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry,
  budget: Budget,
  take: (chunk: Buffer) => void,
): Promise<void> {
  await pump(zip, entry, Number.POSITIVE_INFINITY, (chunk) => {
    budget.inflate(chunk.length);
    take(chunk);
    return true;
  });
}

/** A config entry's text, within its own cap (damage past it) and the budget. */
async function configText(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry | undefined,
  budget: Budget,
): Promise<string | null> {
  if (entry === undefined) return null;
  const chunks: Buffer[] = [];
  let total = 0;
  await inflateEntry(zip, entry, budget, (chunk) => {
    total += chunk.length;
    if (total > LIMITS.configBytes) throw new Damaged(`entry over ${LIMITS.configBytes} bytes`);
    chunks.push(chunk);
  });
  const text = Buffer.concat(chunks).toString("utf8");
  budget.step(text.length);
  return text;
}

// --- Transforms ---------------------------------------------------------------

type Transform = number[];

const IDENTITY: Transform = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

/**
 * Whether every number of a transform is finite as a float32, the way the
 * GLB and the GPU hold it: a double past about 3.4e38 is finite but becomes
 * Infinity there (review finding #393).
 */
function finiteTransform(t: Transform): boolean {
  return t.every((n) => Number.isFinite(Math.fround(n)));
}

/**
 * A transform attribute: identity when absent, null when it is not 12
 * numbers each finite as a float32.
 */
function transformOf(v: string | undefined): Transform | null {
  if (v === undefined) return IDENTITY;
  const parts = v.trim().split(/\s+/);
  if (parts.length !== 12) return null;
  const out = parts.map(Number);
  return finiteTransform(out) ? out : null;
}

/** a, then b: for row vectors, the matrix product a * b. */
function compose(a: Transform, b: Transform): Transform {
  const out = new Array<number>(12);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 3; c++) {
      let sum = r === 3 ? (b[9 + c] as number) : 0;
      for (let k = 0; k < 3; k++) sum += (a[3 * r + k] as number) * (b[3 * k + c] as number);
      out[3 * r + c] = sum;
    }
  }
  return out;
}

// --- Config ---------------------------------------------------------------------

interface PartSettings {
  extruder: number | null;
  printed: boolean;
}

interface ObjectSettings {
  extruder: number | null;
  parts: Map<number, PartSettings>;
}

interface Settings {
  /** Each plate's objects; null when the file lists no plate. */
  plates: Map<number, Array<{ objectId: number; instance: number }>> | null;
  objects: Map<number, ObjectSettings>;
}

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: false,
  processEntities: true,
  htmlEntities: false,
  isArray: (name) => ["plate", "metadata", "model_instance", "object", "part"].includes(name),
});

type Node = Record<string, unknown>;

function isNode(v: unknown): v is Node {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nodes(v: unknown): Node[] {
  return Array.isArray(v) ? v.filter(isNode) : [];
}

function metadata(node: Node): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of nodes(node.metadata)) {
    if (typeof m.key !== "string" || out.has(m.key)) continue;
    out.set(m.key, typeof m.value === "string" ? m.value : "");
  }
  return out;
}

function whole(v: unknown): number | null {
  if (typeof v !== "string" || !WHOLE.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

/** A filament number from 1, or null for none, 0 (the object's own) or anything else. */
function filament(v: unknown): number | null {
  const n = whole(v);
  return n !== null && n >= 1 ? n : null;
}

function readSettings(text: string | null): Settings {
  const empty: Settings = { plates: null, objects: new Map() };
  if (text === null) return empty;
  if (/<!DOCTYPE/i.test(text) || /<!ENTITY/i.test(text)) throw new Damaged("XML with a DTD");
  let doc: unknown;
  try {
    doc = xml.parse(text);
  } catch {
    return empty;
  }
  const config = isNode(doc) && isNode(doc.config) ? doc.config : null;
  if (config === null) return empty;

  const objects = new Map<number, ObjectSettings>();
  for (const o of nodes(config.object)) {
    const id = whole(o.id);
    if (id === null || objects.has(id)) continue;
    const parts = new Map<number, PartSettings>();
    for (const p of nodes(o.part)) {
      const partId = whole(p.id);
      if (partId === null || parts.has(partId)) continue;
      const subtype = typeof p.subtype === "string" ? p.subtype : "normal_part";
      parts.set(partId, {
        extruder: filament(metadata(p).get("extruder")),
        printed: subtype === "normal_part",
      });
    }
    objects.set(id, { extruder: filament(metadata(o).get("extruder")), parts });
  }

  const blocks = nodes(config.plate);
  if (blocks.length === 0) return { plates: null, objects };
  if (blocks.length > LIMITS.plates) throw new Damaged("too many plates");
  const plates = new Map<number, Array<{ objectId: number; instance: number }>>();
  for (const block of blocks) {
    const index = whole(metadata(block).get("plater_id"));
    if (index === null || index < 1 || plates.has(index)) continue;
    const instances: Array<{ objectId: number; instance: number }> = [];
    for (const mi of nodes(block.model_instance)) {
      const meta = metadata(mi);
      const objectId = whole(meta.get("object_id"));
      if (objectId === null) continue;
      instances.push({ objectId, instance: whole(meta.get("instance_id")) ?? 0 });
    }
    plates.set(index, instances);
  }
  return { plates, objects };
}

function readColours(text: string | null): Array<string | null> {
  if (text === null) return [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isNode(data) || !Array.isArray(data.filament_colour)) return [];
  if (data.filament_colour.length > LIMITS.filaments)
    throw new Damaged("too many project filaments");
  return data.filament_colour.map((c) =>
    typeof c === "string" && COLOUR.test(c) ? c.slice(0, 7) : null,
  );
}

// --- Model parts ------------------------------------------------------------------

interface Component {
  objectId: number;
  /** The entry name of the part holding the object; null for the same part. */
  path: string | null;
  transform: Transform | null;
}

interface Mesh {
  positions: Float32Array;
  indices: Uint32Array;
}

/**
 * What the reader knows of one model part. Its objects, components and
 * build items come from its first read and never change; meshes are added
 * as they are read, each at most once.
 */
interface PartData {
  /** Objects made of components, by id. */
  components: Map<number, Component[]>;
  /** Objects with a <mesh>, read or not, and the triangles each mesh has. */
  triangles: Map<number, number>;
  /** The meshes read so far, by id; null for one that cannot be read. */
  meshes: Map<number, Mesh | null>;
  /** The build items, in file order (the root part's). */
  items: Component[];
  /** How many times the part has been read; at most 2. */
  reads: number;
}

/** The most bytes in one block of a mesh being read. */
export const BLOCK_BYTES = 256 * 1024;

/** Elements of the largest block, a multiple of 3 so no vertex or triangle is split. */
const BLOCK_ELEMENTS = Math.floor(BLOCK_BYTES / 4 / 3) * 3;

/** Elements of the first block: 256 vertices or triangles. */
const FIRST_BLOCK_ELEMENTS = 3 * 256;

/**
 * Numbers appended three at a time into blocks of the budget: the first
 * block is small, each next one twice as big up to BLOCK_BYTES, then the
 * size stays. A block is filled before the next is made and is never
 * reallocated or copied while reading.
 */
class Blocks<A extends Float32Array | Uint32Array> {
  readonly list: A[] = [];
  private fill = 0;
  private readonly make: (length: number) => A;

  constructor(make: (length: number) => A) {
    this.make = make;
    this.list.push(make(FIRST_BLOCK_ELEMENTS));
  }

  push3(a: number, b: number, c: number): void {
    let last = this.list[this.list.length - 1] as A;
    if (this.fill === last.length) {
      last = this.make(Math.min(last.length * 2, BLOCK_ELEMENTS));
      this.list.push(last);
      this.fill = 0;
    }
    last[this.fill] = a;
    last[this.fill + 1] = b;
    last[this.fill + 2] = c;
    this.fill += 3;
  }

  /** The numbers appended, as views of the blocks in order. */
  views(): A[] {
    return this.list.map((block, i) =>
      i === this.list.length - 1 ? (block.subarray(0, this.fill) as A) : block,
    );
  }
}

/**
 * A mesh being read. Its numbers go into blocks of the budget; done() gives
 * a mesh that fits in one block as a view of it, and copies a bigger one
 * into arrays of its exact size, so a mesh costs at most twice its final
 * size plus two blocks.
 */
class MeshBuilder {
  private readonly positions: Blocks<Float32Array>;
  private readonly indices: Blocks<Uint32Array>;
  private vertexCount = 0;
  private triangleCount = 0;
  private broken = false;
  private readonly budget: Budget;

  constructor(budget: Budget) {
    this.budget = budget;
    this.positions = new Blocks((n) => budget.float32(n));
    this.indices = new Blocks((n) => budget.uint32(n));
  }

  vertex(a: Map<string, string>): void {
    // Narrowed to 32 bits before the check, since that is how they are
    // stored: a double past about 3.4e38 is finite but becomes Infinity in
    // the Float32Array, and the GLB would get infinite positions and null
    // bounds (review of PR #368).
    const x = Math.fround(Number(a.get("x")));
    const y = Math.fround(Number(a.get("y")));
    const z = Math.fround(Number(a.get("z")));
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      this.broken = true;
      return;
    }
    this.positions.push3(x, y, z);
    this.vertexCount++;
  }

  triangle(a: Map<string, string>): void {
    const v1 = whole(a.get("v1"));
    const v2 = whole(a.get("v2"));
    const v3 = whole(a.get("v3"));
    // A Uint32Array holds 0 to 0xFFFFFFFF; a larger index would wrap to a
    // small one and pass the check against the vertex count (review
    // finding #394), so it makes the mesh unreadable here.
    if (
      v1 === null ||
      v2 === null ||
      v3 === null ||
      v1 > 0xffffffff ||
      v2 > 0xffffffff ||
      v3 > 0xffffffff
    ) {
      this.broken = true;
      return;
    }
    this.indices.push3(v1, v2, v3);
    this.triangleCount++;
  }

  /**
   * The mesh, or null when it has no triangles, more vertices than its
   * triangles could use (three each; the rest would only be bytes in the
   * GLB, review of PR #368), or anything in it cannot be read; then its
   * blocks are freed. A mesh in one block is returned as views of it; a
   * bigger one is copied into exact-size arrays and its blocks are freed.
   */
  done(): Mesh | null {
    const positions = this.positions.views();
    const indices = this.indices.views();
    const unreadable =
      this.broken ||
      this.triangleCount === 0 ||
      this.vertexCount > 3 * this.triangleCount ||
      indices.some((block) => block.some((i) => i >= this.vertexCount));
    if (unreadable) {
      this.drop();
      return null;
    }
    const [onlyPositions] = positions;
    const [onlyIndices] = indices;
    if (
      onlyPositions !== undefined &&
      onlyIndices !== undefined &&
      positions.length === 1 &&
      indices.length === 1
    ) {
      // Each in one block: the views are the result, and the blocks stay owned.
      return { positions: onlyPositions, indices: onlyIndices };
    }
    const mesh: Mesh = {
      positions: this.budget.float32(3 * this.vertexCount),
      indices: this.budget.uint32(3 * this.triangleCount),
    };
    copyBlocks(positions, mesh.positions);
    copyBlocks(indices, mesh.indices);
    this.drop();
    return mesh;
  }

  drop(): void {
    for (const block of this.positions.list) this.budget.free(block);
    for (const block of this.indices.list) this.budget.free(block);
  }
}

function copyBlocks<A extends Float32Array | Uint32Array>(from: A[], to: A): void {
  let at = 0;
  for (const block of from) {
    to.set(block as never, at);
    at += block.length;
  }
}

/** A p:path value as an entry name: /3D/Objects/a.model is 3D/Objects/a.model. */
function entryName(path: string | undefined): string | null {
  if (path === undefined || path === "") return null;
  return path.startsWith("/") ? path.slice(1) : path;
}

/**
 * Reads one model part as a stream of tags. On its first read (part has no
 * data yet) it records every object's components and the triangles of each
 * mesh, and the build items; on any read it reads the meshes of the ids in
 * collect that are not read yet, each into arrays of the budget. A part that
 * is not in the archive is empty.
 */
async function readPart(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry | undefined,
  known: PartData | undefined,
  collect: ReadonlySet<number>,
  budget: Budget,
): Promise<PartData> {
  const first = known === undefined;
  const data: PartData = known ?? {
    components: new Map(),
    triangles: new Map(),
    meshes: new Map(),
    items: [],
    reads: 0,
  };
  data.reads++;
  if (data.reads > 2) throw new Error(`a model part was read ${data.reads} times`);
  if (entry === undefined) return data;

  let objectId: number | null = null;
  let components: Component[] | null = null;
  let builder: MeshBuilder | null = null;
  let triangles = 0;
  let inMesh = false;
  let inBuild = false;
  const component = (a: Map<string, string>): Component | null => {
    const id = whole(a.get("objectid"));
    if (id === null) return null;
    return {
      objectId: id,
      path: entryName(a.get("path")),
      transform: transformOf(a.get("transform")),
    };
  };
  const endObject = (): void => {
    if (first && objectId !== null && components !== null && !data.components.has(objectId)) {
      data.components.set(objectId, components);
    }
    // An object closed inside its mesh never finished it.
    builder?.drop();
    objectId = null;
    components = null;
    builder = null;
    inMesh = false;
  };
  const endMesh = (): void => {
    if (objectId === null) return;
    if (first && !data.triangles.has(objectId)) data.triangles.set(objectId, triangles);
    if (builder !== null) data.meshes.set(objectId, builder.done());
    builder = null;
    inMesh = false;
  };

  const scanner = new TagScanner(
    (tag) => {
      switch (tag.name) {
        case "object":
          if (tag.closing) {
            endObject();
          } else {
            endObject();
            objectId = whole(attrs(tag.raw).get("id"));
            if (tag.selfClosing) endObject();
          }
          return;
        case "mesh":
          if (objectId === null) return;
          if (tag.closing) {
            endMesh();
            return;
          }
          inMesh = true;
          triangles = 0;
          if (collect.has(objectId) && !data.meshes.has(objectId)) {
            builder = new MeshBuilder(budget);
          }
          if (tag.selfClosing) endMesh();
          return;
        case "vertex":
          if (builder !== null && !tag.closing) builder.vertex(attrs(tag.raw));
          return;
        case "triangle":
          if (!inMesh || tag.closing) return;
          triangles++;
          if (builder !== null) builder.triangle(attrs(tag.raw));
          return;
        case "components":
          if (first && objectId !== null && !tag.closing) components ??= [];
          return;
        case "component":
          if (components !== null && !tag.closing) {
            const c = component(attrs(tag.raw));
            if (c !== null) {
              budget.component();
              components.push(c);
            }
          }
          return;
        case "build":
          inBuild = !tag.closing && !tag.selfClosing;
          return;
        case "item":
          if (first && inBuild && !tag.closing) {
            const c = component(attrs(tag.raw));
            if (c !== null) {
              budget.component();
              data.items.push(c);
            }
          }
          return;
        default:
          return;
      }
    },
    (chars) => budget.step(chars),
  );

  try {
    await inflateEntry(zip, entry, budget, (chunk) => scanner.write(chunk));
    scanner.end();
  } finally {
    // A mesh left unfinished by an error, or by the part ending inside it.
    // (A cast: the scanner's callback assigns builder, which narrowing cannot see.)
    (builder as MeshBuilder | null)?.drop();
  }
  return data;
}

// --- The plate --------------------------------------------------------------------

interface Request {
  path: string;
  objectId: number;
  transform: Transform;
  /** The plate object the request came from, for its filament. */
  top: number;
  /** The part of the plate object it is in (its first-level component), if any. */
  part: number | null;
}

interface Placed {
  path: string;
  objectId: number;
  transform: Transform;
  colour: string | null;
}

/** How many plates the entry names' pictures list. */
function plateCount(entries: ReadonlyMap<string, unknown>): number {
  const indexes = new Set<string>();
  for (const name of entries.keys()) {
    const index = PLATE_PICTURE.exec(name)?.[1];
    if (index !== undefined) indexes.add(index);
  }
  return indexes.size;
}

async function readFromArchive(
  reader: yauzl.RandomAccessReader,
  size: number,
  plate: number,
  budget: Budget,
): Promise<PlateMesh> {
  const zip = await openArchive(reader, size);
  try {
    const entries = await ownRead(() => listEntries(zip));
    const settings = readSettings(await configText(zip, entries.get(MODEL_SETTINGS), budget));
    const colours = readColours(await configText(zip, entries.get(PROJECT_SETTINGS), budget));
    const parts = new Map<string, PartData>();

    // The plate's own objects are known from the settings, so the root's
    // first read already takes their meshes.
    const instances = settings.plates === null ? null : settings.plates.get(plate);
    if (settings.plates !== null && instances === undefined) {
      throw new PlateMeshError("no_plate", `the file lists no plate ${plate}`);
    }
    if (instances !== null && instances !== undefined && instances.length === 0) {
      throw new PlateMeshError("no_objects", `plate ${plate} is empty`);
    }
    if (instances === null && (plate !== 1 || plateCount(entries) > 1)) {
      // The page lists several plates from their pictures, but with no plate
      // blocks the file does not say which build items are on which.
      throw new PlateMeshError("no_plate", `the file lists no plate ${plate}`);
    }
    const tops = new Set((instances ?? []).map((i) => i.objectId));
    const root = await readPart(zip, entries.get(ROOT), undefined, tops, budget);
    parts.set(ROOT, root);

    // The plate's requests: its model instances matched to build items, or
    // every build item when the file lists no plates and plate 1 is asked for.
    let requests: Request[] = [];
    const request = (r: Request): void => {
      budget.step();
      if (requests.length >= budget.limits.instances) {
        throw new PlateMeshError("too_large", "placed meshes over the limit");
      }
      requests.push(r);
    };
    if (instances === null || instances === undefined) {
      for (const i of root.items) {
        if (i.transform === null) continue;
        request({
          path: i.path ?? ROOT,
          objectId: i.objectId,
          transform: i.transform,
          top: i.objectId,
          part: null,
        });
      }
    } else {
      // Each object's build items in file order, indexed once.
      const itemsOf = new Map<number, Component[]>();
      for (const item of root.items) {
        budget.step();
        const list = itemsOf.get(item.objectId);
        if (list === undefined) itemsOf.set(item.objectId, [item]);
        else list.push(item);
      }
      for (const { objectId, instance } of instances) {
        const item = itemsOf.get(objectId)?.[instance];
        if (item === undefined || item.transform === null) continue;
        request({
          path: item.path ?? ROOT,
          objectId,
          transform: item.transform,
          top: objectId,
          part: null,
        });
      }
    }

    // Walk the components layer by layer. A part not read yet is read once,
    // taking the meshes this layer asks of it; a mesh found is placed at
    // once, its triangles charged from the count its part's first read
    // made, so no mesh needs to be held to be counted.
    const placed: Placed[] = [];
    /** Mesh ids the walk placed but whose part has not read them yet, by part. */
    const unread = new Map<string, Set<number>>();
    /**
     * Each object's components that are followed, worked out once for each
     * distinct (part, object, plate object, part of it): a component whose
     * transform cannot be read, or whose part is not printed, is skipped
     * once, charged once, and never looked at again for another request of
     * the same object (review finding #392: a plate can name one object
     * thousands of times).
     */
    const followed = new Map<string, Component[]>();
    const childrenOf = (r: Request, comps: Component[]): Component[] => {
      const key = `${r.path}\u0000${r.objectId}\u0000${r.top}\u0000${r.part ?? ""}`;
      let kept = followed.get(key);
      if (kept === undefined) {
        kept = [];
        for (const c of comps) {
          budget.step();
          if (c.transform === null) continue;
          if (!printed(settings, r.top, r.part ?? c.objectId)) continue;
          kept.push(c);
        }
        followed.set(key, kept);
      }
      return kept;
    };
    for (let depth = 0; requests.length > 0 && depth <= budget.limits.depth; depth++) {
      const firstReads = new Map<string, Set<number>>();
      for (const r of requests) {
        if (parts.has(r.path)) continue;
        let ids = firstReads.get(r.path);
        if (ids === undefined) {
          ids = new Set();
          firstReads.set(r.path, ids);
        }
        ids.add(r.objectId);
      }
      for (const [path, ids] of firstReads) {
        parts.set(path, await readPart(zip, entries.get(path), undefined, ids, budget));
      }
      const next: Request[] = [];
      for (const r of requests) {
        budget.step();
        const data = parts.get(r.path) as PartData;
        const comps = data.components.get(r.objectId);
        if (comps !== undefined) {
          for (const c of childrenOf(r, comps)) {
            budget.step();
            // Each number of both is finite, but the product may not be:
            // 1e200 times 1e200 is Infinity (review finding #393). Such a
            // copy cannot be drawn, so it is skipped like an unreadable one.
            const transform = compose(c.transform as Transform, r.transform);
            if (!finiteTransform(transform)) continue;
            if (next.length + placed.length >= budget.limits.instances) {
              throw new PlateMeshError("too_large", "placed meshes over the limit");
            }
            next.push({
              path: c.path ?? r.path,
              objectId: c.objectId,
              transform,
              top: r.top,
              part: r.part ?? c.objectId,
            });
          }
          continue;
        }
        const triangles = data.triangles.get(r.objectId);
        if (triangles === undefined) continue;
        budget.place(triangles);
        if (next.length + placed.length >= budget.limits.instances) {
          throw new PlateMeshError("too_large", "placed meshes over the limit");
        }
        placed.push({
          path: r.path,
          objectId: r.objectId,
          transform: r.transform,
          colour: colourOf(settings, colours, r.top, r.part),
        });
        if (!data.meshes.has(r.objectId)) {
          let ids = unread.get(r.path);
          if (ids === undefined) {
            ids = new Set();
            unread.set(r.path, ids);
          }
          ids.add(r.objectId);
        }
      }
      requests = next;
    }

    // The meshes placed but not read yet: one more read of each such part,
    // taking only those.
    for (const [path, ids] of unread) {
      const data = parts.get(path) as PartData;
      const missing = new Set([...ids].filter((id) => !data.meshes.has(id)));
      if (missing.size > 0) await readPart(zip, entries.get(path), data, missing, budget);
    }

    return assemble(plate, placed, parts, budget);
  } finally {
    zip.close();
  }
}

/** Whether a part of a plate object is printed: anything but a normal part is not. */
function printed(settings: Settings, top: number, part: number): boolean {
  return settings.objects.get(top)?.parts.get(part)?.printed ?? true;
}

function colourOf(
  settings: Settings,
  colours: Array<string | null>,
  top: number,
  part: number | null,
): string | null {
  const object = settings.objects.get(top);
  const fromPart = part === null ? null : (object?.parts.get(part)?.extruder ?? null);
  const n = fromPart ?? object?.extruder ?? 1;
  return colours[n - 1] ?? null;
}

/** The pieces, one per mesh and colour, and the instances that place them. */
function assemble(
  plate: number,
  placed: Placed[],
  parts: Map<string, PartData>,
  budget: Budget,
): PlateMesh {
  const pieces: MeshPiece[] = [];
  const pieceOf = new Map<string, number>();
  const instances: MeshInstance[] = [];
  let triangles = 0;
  for (const p of placed) {
    budget.step();
    const mesh = parts.get(p.path)?.meshes.get(p.objectId) ?? null;
    if (mesh === null) continue;
    triangles += mesh.indices.length / 3;
    const key = `${p.path}\u0000${p.objectId}\u0000${p.colour ?? ""}`;
    let piece = pieceOf.get(key);
    if (piece === undefined) {
      piece = pieces.length;
      pieces.push({ positions: mesh.positions, indices: mesh.indices, colour: p.colour });
      pieceOf.set(key, piece);
    }
    instances.push({ piece, transform: p.transform });
  }
  if (instances.length === 0) {
    throw new PlateMeshError("no_mesh", `nothing on plate ${plate} has a mesh that can be read`);
  }
  return { plate, pieces, instances, triangles };
}
