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
// Rules, carried from parse.ts where they apply:
// - entries are found by their raw name bytes, and only the parts the plate
//   needs are inflated: 3D/3dmodel.model and the parts its components name;
// - every cap counts bytes actually inflated, and the mesh limits below
//   count what is held, so a hostile file cannot make the reader hold more;
// - a model part is read as a stream of tags (xml-scan.ts), never whole;
// - a filesystem error is ReadUnavailable and never a problem with the file;
// - anything else wrong with the file is a PlateMeshError with its problem:
//   no_plate (the file lists no such plate), no_objects (the plate is
//   empty), no_mesh (nothing on the plate has a mesh that can be read),
//   too_large (over a limit below) or damaged (the archive or a part it
//   needs cannot be read). A plate where some objects can be read and
//   others cannot shows the ones that can.
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
import { LIMITS } from "./limits.js";
import { attrs, TagScanner } from "./xml-scan.js";

const MODEL_SETTINGS = "Metadata/model_settings.config";
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

export const PLATE_MESH_LIMITS = Object.freeze({
  /** Triangles drawn on one plate, every instance counted, and triangles held. */
  triangles: 5_000_000,
  /** Vertices held over the plate's meshes. */
  vertices: 5_000_000,
  /** Inflated bytes of each model part read. */
  partBytes: 1024 * MiB,
  /** Meshes placed on one plate, counted as each layer of components is expanded. */
  instances: 10_000,
  /**
   * Components and build items held over the model parts read. Counted as
   * each part is scanned, so a flood of tiny <component/> tags is refused
   * before it is held, whether or not it is on the plate.
   */
  components: 100_000,
  /** How deep components may nest. */
  depth: 16,
});

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
  /**
   * Lowers the triangle limit; it cannot raise it past
   * PLATE_MESH_LIMITS.triangles. A value that is not a positive finite
   * number is ignored.
   */
  maxTriangles?: number;
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
  try {
    let size: number;
    try {
      ({ size } = await handle.stat());
    } catch (err) {
      throw unavailableOr(err);
    }
    try {
      return await readFromArchive(new HandleReader(handle), size, plate, triangleLimit(opts));
    } catch (err) {
      // Damaged comes only from the zip reader, inflate, the config caps and
      // the tag scanner; a ReadUnavailable or a bug reaches the caller as is.
      if (err instanceof Damaged) throw new PlateMeshError("damaged", err.message);
      throw err;
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function triangleLimit(opts: PlateMeshOptions): number {
  const asked = opts.maxTriangles;
  if (asked === undefined || !Number.isFinite(asked) || asked <= 0) {
    return PLATE_MESH_LIMITS.triangles;
  }
  return Math.min(asked, PLATE_MESH_LIMITS.triangles);
}

// --- Transforms ---------------------------------------------------------------

type Transform = number[];

const IDENTITY: Transform = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

/** A transform attribute: identity when absent, null when it is not 12 finite numbers. */
function transformOf(v: string | undefined): Transform | null {
  if (v === undefined) return IDENTITY;
  const parts = v.trim().split(/\s+/);
  if (parts.length !== 12) return null;
  const out = parts.map(Number);
  return out.every(Number.isFinite) ? out : null;
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

interface PartData {
  /** Objects made of components, by id. */
  components: Map<number, Component[]>;
  /** Objects with a <mesh>, read or not. */
  meshIds: Set<number>;
  /** The meshes of the ids collected, by id; null for one that cannot be read. */
  meshes: Map<number, Mesh | null>;
  collected: Set<number>;
  /** The build items, in file order (the root part's). */
  items: Component[];
  /** Components and build items this part holds, counted against the budget. */
  held: number;
}

/** Counts what the reader holds and draws against the limits. */
class Budget {
  vertices = 0;
  triangles = 0;
  components = 0;
  readonly maxTriangles: number;

  constructor(maxTriangles: number) {
    this.maxTriangles = maxTriangles;
  }

  addVertex(): void {
    if (++this.vertices > PLATE_MESH_LIMITS.vertices) {
      throw new PlateMeshError("too_large", "more vertices than the limit");
    }
  }

  addTriangle(): void {
    if (++this.triangles > this.maxTriangles) {
      throw new PlateMeshError("too_large", "more triangles than the limit");
    }
  }

  /** A component or build item held. */
  addComponent(): void {
    if (++this.components > PLATE_MESH_LIMITS.components) {
      throw new PlateMeshError("too_large", "more components and build items than the limit");
    }
  }

  /** A part read again: its components and build items are no longer held. */
  releaseComponents(part: PartData): void {
    this.components -= part.held;
  }

  release(mesh: Mesh | null): void {
    if (mesh === null) return;
    this.vertices -= mesh.positions.length / 3;
    this.triangles -= mesh.indices.length / 3;
  }
}

class MeshBuilder {
  private positions = new Float32Array(3 * 256);
  private indices = new Uint32Array(3 * 256);
  private vertexCount = 0;
  private triangleCount = 0;
  private broken = false;
  private readonly budget: Budget;

  constructor(budget: Budget) {
    this.budget = budget;
  }

  vertex(a: Map<string, string>): void {
    const x = Number(a.get("x"));
    const y = Number(a.get("y"));
    const z = Number(a.get("z"));
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      this.broken = true;
      return;
    }
    this.budget.addVertex();
    if (3 * (this.vertexCount + 1) > this.positions.length) this.positions = grow(this.positions);
    this.positions.set([x, y, z], 3 * this.vertexCount);
    this.vertexCount++;
  }

  triangle(a: Map<string, string>): void {
    const v1 = whole(a.get("v1"));
    const v2 = whole(a.get("v2"));
    const v3 = whole(a.get("v3"));
    if (v1 === null || v2 === null || v3 === null) {
      this.broken = true;
      return;
    }
    this.budget.addTriangle();
    if (3 * (this.triangleCount + 1) > this.indices.length) this.indices = grow(this.indices);
    this.indices.set([v1, v2, v3], 3 * this.triangleCount);
    this.triangleCount++;
  }

  /** The mesh, or null when it has no triangles or anything in it cannot be read. */
  done(): Mesh | null {
    const mesh: Mesh = {
      positions: this.positions.slice(0, 3 * this.vertexCount),
      indices: this.indices.slice(0, 3 * this.triangleCount),
    };
    const unreadable =
      this.broken || this.triangleCount === 0 || mesh.indices.some((i) => i >= this.vertexCount);
    if (unreadable) {
      this.budget.release(mesh);
      return null;
    }
    return mesh;
  }
}

function grow<T extends Float32Array | Uint32Array>(a: T): T {
  const bigger = new (a.constructor as new (n: number) => T)(a.length * 2);
  bigger.set(a);
  return bigger;
}

/** A p:path value as an entry name: /3D/Objects/a.model is 3D/Objects/a.model. */
function entryName(path: string | undefined): string | null {
  if (path === undefined || path === "") return null;
  return path.startsWith("/") ? path.slice(1) : path;
}

/**
 * Reads one model part as a stream of tags: every object's components and
 * whether it has a mesh, the build items, and the meshes of the ids in
 * collect. A part that is not in the archive is empty.
 */
async function scanPart(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry | undefined,
  collect: Set<number>,
  budget: Budget,
): Promise<PartData> {
  const data: PartData = {
    components: new Map(),
    meshIds: new Set(),
    meshes: new Map(),
    collected: new Set(collect),
    items: [],
    held: 0,
  };
  const hold = (): void => {
    budget.addComponent();
    data.held++;
  };
  if (entry === undefined) return data;

  let objectId: number | null = null;
  let components: Component[] | null = null;
  let builder: MeshBuilder | null = null;
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
    if (objectId !== null && components !== null && !data.components.has(objectId)) {
      data.components.set(objectId, components);
    }
    objectId = null;
    components = null;
    builder = null;
  };

  const scanner = new TagScanner((tag) => {
    switch (tag.name) {
      case "object":
        if (tag.closing) {
          endObject();
        } else {
          objectId = whole(attrs(tag.raw).get("id"));
          components = null;
          if (tag.selfClosing) endObject();
        }
        return;
      case "mesh":
        if (objectId === null) return;
        if (tag.closing) {
          if (builder !== null && !data.meshes.has(objectId))
            data.meshes.set(objectId, builder.done());
          builder = null;
          return;
        }
        data.meshIds.add(objectId);
        if (collect.has(objectId) && !data.meshes.has(objectId)) {
          builder = new MeshBuilder(budget);
          if (tag.selfClosing) {
            data.meshes.set(objectId, builder.done());
            builder = null;
          }
        }
        return;
      case "vertex":
        if (builder !== null && !tag.closing) (builder as MeshBuilder).vertex(attrs(tag.raw));
        return;
      case "triangle":
        if (builder !== null && !tag.closing) (builder as MeshBuilder).triangle(attrs(tag.raw));
        return;
      case "components":
        if (objectId !== null && !tag.closing) components ??= [];
        return;
      case "component":
        if (components !== null && !tag.closing) {
          const c = component(attrs(tag.raw));
          if (c !== null) {
            hold();
            (components as Component[]).push(c);
          }
        }
        return;
      case "build":
        inBuild = !tag.closing && !tag.selfClosing;
        return;
      case "item":
        if (inBuild && !tag.closing) {
          const c = component(attrs(tag.raw));
          if (c !== null) {
            hold();
            data.items.push(c);
          }
        }
        return;
      default:
        return;
    }
  });

  let inflated = 0;
  await pump(zip, entry, Number.POSITIVE_INFINITY, (chunk) => {
    inflated += chunk.length;
    if (inflated > PLATE_MESH_LIMITS.partBytes) {
      throw new PlateMeshError("too_large", "a model part over the size limit");
    }
    scanner.write(chunk);
    return true;
  });
  scanner.end();
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

interface Leaf {
  mesh: Mesh;
  path: string;
  objectId: number;
  transform: Transform;
  colour: string | null;
}

async function readFromArchive(
  reader: yauzl.RandomAccessReader,
  size: number,
  plate: number,
  maxTriangles: number,
): Promise<PlateMesh> {
  const zip = await openArchive(reader, size);
  try {
    const entries = await ownRead(() => listEntries(zip));
    const configText = async (name: string): Promise<string | null> => {
      const entry = entries.get(name);
      return entry ? (await readCapped(zip, entry, LIMITS.configBytes)).toString("utf8") : null;
    };
    const settings = readSettings(await configText(MODEL_SETTINGS));
    const colours = readColours(await configText(PROJECT_SETTINGS));
    const budget = new Budget(maxTriangles);

    const parts = new Map<string, PartData>();
    /** The part's data with the meshes of ids collected, reading it again only for ids it lacks. */
    const partData = async (path: string, ids: Iterable<number>): Promise<PartData> => {
      const known = parts.get(path);
      const want = new Set(ids);
      if (known !== undefined && [...want].every((id) => known.collected.has(id))) return known;
      if (known !== undefined) {
        for (const id of known.collected) want.add(id);
        for (const mesh of known.meshes.values()) budget.release(mesh);
        budget.releaseComponents(known);
      }
      const read = await scanPart(zip, entries.get(path), want, budget);
      parts.set(path, read);
      return read;
    };

    // The plate's objects: its model instances, or every build item when
    // the file lists no plates and plate 1 is asked for.
    const root = await partData(ROOT, []);
    let requests: Request[];
    if (settings.plates === null) {
      if (plate !== 1) throw new PlateMeshError("no_plate", `the file lists no plate ${plate}`);
      requests = itemsAsRequests(root.items, () => true);
    } else {
      const instances = settings.plates.get(plate);
      if (instances === undefined) {
        throw new PlateMeshError("no_plate", `the file lists no plate ${plate}`);
      }
      if (instances.length === 0) throw new PlateMeshError("no_objects", `plate ${plate} is empty`);
      requests = [];
      for (const { objectId, instance } of instances) {
        const item = root.items.filter((i) => i.objectId === objectId)[instance];
        if (item === undefined || item.transform === null) continue;
        requests.push({
          path: item.path ?? ROOT,
          objectId,
          transform: item.transform,
          top: objectId,
          part: null,
        });
      }
    }

    // Follow components layer by layer, reading each part once for every
    // object the layer needs from it.
    const leaves: Array<Omit<Leaf, "mesh"> & { mesh: Mesh | null }> = [];
    for (let depth = 0; requests.length > 0 && depth <= PLATE_MESH_LIMITS.depth; depth++) {
      if (requests.length + leaves.length > PLATE_MESH_LIMITS.instances) {
        throw new PlateMeshError("too_large", "more placed meshes than the limit");
      }
      const byPath = new Map<string, number[]>();
      for (const r of requests) byPath.set(r.path, [...(byPath.get(r.path) ?? []), r.objectId]);
      for (const [path, ids] of byPath) await partData(path, ids);
      const next: Request[] = [];
      for (const r of requests) {
        const data = parts.get(r.path);
        if (data === undefined) continue;
        const comps = data.components.get(r.objectId);
        if (comps !== undefined) {
          for (const c of comps) {
            if (c.transform === null) continue;
            const part = r.part ?? c.objectId;
            if (!printed(settings, r.top, part)) continue;
            // Checked per component, so one wide object is refused before
            // its whole layer is expanded, not at the start of the next.
            if (next.length + leaves.length >= PLATE_MESH_LIMITS.instances) {
              throw new PlateMeshError("too_large", "more placed meshes than the limit");
            }
            next.push({
              path: c.path ?? r.path,
              objectId: c.objectId,
              transform: compose(c.transform, r.transform),
              top: r.top,
              part,
            });
          }
        } else if (data.meshIds.has(r.objectId)) {
          leaves.push({
            mesh: data.meshes.get(r.objectId) ?? null,
            path: r.path,
            objectId: r.objectId,
            transform: r.transform,
            colour: colourOf(settings, colours, r.top, r.part),
          });
        }
      }
      requests = next;
    }

    const readable = leaves.filter((l): l is Leaf => l.mesh !== null);
    if (readable.length === 0) {
      throw new PlateMeshError("no_mesh", `nothing on plate ${plate} has a mesh that can be read`);
    }
    return assemble(plate, readable, maxTriangles);
  } finally {
    zip.close();
  }
}

function itemsAsRequests(items: Component[], keep: (c: Component) => boolean): Request[] {
  return items
    .filter((i) => keep(i) && i.transform !== null)
    .map((i) => ({
      path: i.path ?? ROOT,
      objectId: i.objectId,
      transform: i.transform as Transform,
      top: i.objectId,
      part: null,
    }));
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
function assemble(plate: number, leaves: Leaf[], maxTriangles: number): PlateMesh {
  const pieces: MeshPiece[] = [];
  const pieceOf = new Map<string, number>();
  const instances: MeshInstance[] = [];
  let triangles = 0;
  for (const leaf of leaves) {
    triangles += leaf.mesh.indices.length / 3;
    if (triangles > maxTriangles) {
      throw new PlateMeshError("too_large", "more triangles drawn than the limit");
    }
    const key = `${leaf.path}\u0000${leaf.objectId}\u0000${leaf.colour ?? ""}`;
    let piece = pieceOf.get(key);
    if (piece === undefined) {
      piece = pieces.length;
      pieces.push({
        positions: leaf.mesh.positions,
        indices: leaf.mesh.indices,
        colour: leaf.colour,
      });
      pieceOf.set(key, piece);
    }
    instances.push({ piece, transform: leaf.transform });
  }
  return { plate, pieces, instances, triangles };
}
