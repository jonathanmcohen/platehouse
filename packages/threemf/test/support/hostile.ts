// A seeded generator of hostile .3mf files for the plate mesh reader (issue
// #358, review findings #383 and #384). Each file is a well-formed Bambu
// project whose plate 1 does have a mesh that can be read, built to push one
// of the reader's costs: memory held in mesh arrays, bytes inflated, or work
// done walking components. A reader that keeps its limits answers each one
// with a mesh or with too_large, and never holds, inflates or works past
// them on the way.
//
// The families:
// - chain: a part holding a big mesh M and objects C0..Cd, each made of [M,
//   Ck+1], so every level of the walk needs one new object from the same part
//   and adds one more instance of M (#383);
// - fan: one object made of k copies of another made of k copies of M;
// - sameNamePath: objects at every depth reach their next object through a
//   p:path naming the part they are already in;
// - overlapping: many differently named parts that are one stored entry, every
//   central directory record pointing at the same compressed bytes, so each
//   name inflates the same large part again (#384);
// - hugeMesh: one mesh of very many vertices written as repetitive text, so it
//   compresses to almost nothing;
// - longTags: tags up to the scanner's longest, each a long run with no = in
//   it (bare, or in quotes), on an object, a vertex of a mesh the plate
//   needs and a build item, so reading their attributes must take one pass
//   (review of PR #368: a backtracking regex took minutes per tag);
// - mixed: a random mixture of the above.
// Nothing here is a designer file; every byte is made from the seed.
import { crc32, deflateRawSync } from "node:zlib";
import { meshXml, moved, settingsXml } from "./plate-models.js";

const CORE = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02";
const PRODUCTION = "http://schemas.microsoft.com/3dmanufacturing/production/2015/06";

export type Family =
  | "chain"
  | "fan"
  | "sameNamePath"
  | "overlapping"
  | "hugeMesh"
  | "longTags"
  | "duplicateSkipped"
  | "overflow"
  | "wideIndex"
  | "mixed";

export const FAMILIES: readonly Family[] = [
  "chain",
  "fan",
  "sameNamePath",
  "overlapping",
  "hugeMesh",
  "longTags",
  "duplicateSkipped",
  "overflow",
  "wideIndex",
  "mixed",
];

/** A deterministic random source, so a failing seed can be run again. */
export function rng(seed: number): (lo: number, hi: number) => number {
  let x = (seed * 2654435761) >>> 0 || 1;
  return (lo, hi) => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return lo + (x % (hi - lo + 1));
  };
}

/** A mesh of n vertices in a strip, n - 2 triangles, written as short repetitive text. */
export function stripMesh(n: number): string {
  const vertices: number[][] = [];
  for (let i = 0; i < n; i++) vertices.push([i % 7, (i >> 1) % 5, i % 2]);
  const triangles: number[][] = [];
  for (let i = 0; i + 2 < n; i++) triangles.push([i, i + 1, i + 2]);
  return meshXml(vertices, triangles);
}

/** The small mesh every file also places, so plate 1 always has something readable. */
const TETRA = meshXml(
  [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  [
    [0, 2, 1],
    [0, 1, 3],
    [0, 3, 2],
    [1, 2, 3],
  ],
);

function model(resources: string[], build: string[] | null): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<model unit="millimeter" xmlns="${CORE}" xmlns:p="${PRODUCTION}" requiredextensions="p">`,
    "<resources>",
    ...resources,
    "</resources>",
    ...(build === null ? [] : ["<build>", ...build, "</build>"]),
    "</model>",
  ].join("\n");
}

const meshObject = (id: number, mesh: string) => `<object id="${id}" type="model">${mesh}</object>`;

const comps = (id: number, list: Array<{ objectId: number; path?: string }>) =>
  `<object id="${id}" type="model"><components>${list
    .map(
      (c) =>
        `<component${c.path === undefined ? "" : ` p:path="${c.path}"`} objectid="${c.objectId}"/>`,
    )
    .join("")}</components></object>`;

const item = (objectId: number, x = 0) =>
  `<item objectid="${objectId}" transform="${moved(x, 0)}" printable="1"/>`;

export interface ZipEntrySpec {
  name: string;
  data: string | Buffer;
  /** Write no bytes of its own: point at the stored bytes of the entry with this name. */
  sameBytesAs?: string;
}

/**
 * A zip whose entries may share stored bytes: an entry with sameBytesAs gets
 * a central directory record of its own, under its own name, pointing at the
 * other entry's local header and compressed data.
 */
export function overlappingZip(entries: ZipEntrySpec[]): Buffer {
  const parts: Buffer[] = [];
  const centrals: Buffer[] = [];
  const stored = new Map<string, { offset: number; crc: number; size: number; body: number }>();
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    let at: { offset: number; crc: number; size: number; body: number };
    if (entry.sameBytesAs !== undefined) {
      const shared = stored.get(entry.sameBytesAs);
      if (shared === undefined) throw new Error(`no stored entry ${entry.sameBytesAs}`);
      at = shared;
    } else {
      const raw = typeof entry.data === "string" ? Buffer.from(entry.data, "utf8") : entry.data;
      const body = deflateRawSync(raw);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6);
      local.writeUInt16LE(8, 8);
      local.writeUInt32LE(crc32(raw), 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(raw.length, 22);
      local.writeUInt16LE(name.length, 26);
      at = { offset, crc: crc32(raw), size: raw.length, body: body.length };
      stored.set(entry.name, at);
      parts.push(local, name, body);
      offset += local.length + name.length + body.length;
    }
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(45, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(at.crc, 16);
    central.writeUInt32LE(at.body, 20);
    central.writeUInt32LE(at.size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(at.offset, 42);
    centrals.push(central, name);
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, eocd]);
}

export interface HostileFile {
  family: Family;
  seed: number;
  /** What the case is, in a line, for a failing assertion's message. */
  label: string;
  bytes: Buffer;
}

const SETTINGS = "Metadata/model_settings.config";
const ROOT = "3D/3dmodel.model";

/** Plate 1 holds the given top objects, each placed once, plus the tetrahedron object 1. */
function project(
  rootResources: string[],
  tops: number[],
  extra: ZipEntrySpec[] = [],
): ZipEntrySpec[] {
  const all = [1, ...tops];
  return [
    {
      name: ROOT,
      data: model(
        [meshObject(1, TETRA), ...rootResources],
        all.map((id, i) => item(id, i * 50)),
      ),
    },
    {
      name: SETTINGS,
      data: settingsXml(
        all.map((id) => ({ id })),
        [{ index: 1, instances: all.map((id) => [id, 0] as [number, number]) }],
      ),
    },
    ...extra,
  ];
}

/**
 * Review finding #392: plate 1 lists object 50 `duplicates` times (plus the
 * tetrahedron), and object 50 is `skipped` components the walk can only
 * skip: nine in ten with a transform that does not parse, one in ten naming
 * a part the settings mark as a modifier (few enough that the settings file
 * stays under its 5 MiB cap). Nothing is placed for them, so no instance
 * limit trips; a walk that redoes object 50 for every duplicate does
 * duplicates x skipped steps with nothing in between.
 */
export function duplicateSkipped(skipped: number, duplicates: number): Buffer {
  const components: string[] = [];
  const modifiers: Array<{ id: number; subtype: string }> = [];
  for (let i = 0; i < skipped; i++) {
    if (i % 10 !== 0) {
      components.push(`<component objectid="1" transform="not a transform"/>`);
    } else {
      const part = 1_000_000 + i;
      components.push(`<component objectid="${part}"/>`);
      modifiers.push({ id: part, subtype: "modifier_part" });
    }
  }
  const instances: Array<[number, number]> = [[1, 0]];
  for (let i = 0; i < duplicates; i++) instances.push([50, 0]);
  return overlappingZip([
    {
      name: ROOT,
      data: model(
        [
          meshObject(1, TETRA),
          `<object id="50" type="model"><components>${components.join("")}</components></object>`,
        ],
        [item(1), item(50, 50)],
      ),
    },
    {
      name: SETTINGS,
      data: settingsXml([{ id: 1 }, { id: 50, parts: modifiers }], [{ index: 1, instances }]),
    },
  ]);
}

/**
 * Review finding #393: transforms whose every number is finite, but that
 * overflow: composed (1e200 times 1e200 is Infinity), or once narrowed to
 * 32 bits, as the GLB and the GPU hold them (3e38 is finite, 3.5e38 is not
 * a float32). Plate 1 holds object 60 placed that way, and the tetrahedron.
 */
export function overflowing(variant: number): Buffer {
  const big = "1e200 0 0 0 1e200 0 0 0 1e200 0 0 0";
  const plain = "1 0 0 0 1 0 0 0 1 0 0 0";
  const cases = [
    // Each finite; composed, Infinity (and NaN where it meets a 0).
    { item: big, component: big },
    // A translation past the largest float32.
    { item: "1 0 0 0 1 0 0 0 1 3.5e38 0 0", component: plain },
    // A scale past the largest float32 on the component.
    { item: plain, component: "4e38 0 0 0 1 0 0 0 1 0 0 0" },
    // Finite as float32 on its own, Infinity once composed.
    { item: "3e38 0 0 0 1 0 0 0 1 0 0 0", component: "3e38 0 0 0 1 0 0 0 1 0 0 0" },
  ];
  const c = cases[variant % cases.length] as { item: string; component: string };
  return overlappingZip([
    {
      name: ROOT,
      data: model(
        [
          meshObject(1, TETRA),
          meshObject(100, TETRA),
          `<object id="60" type="model"><components><component objectid="100" transform="${c.component}"/></components></object>`,
        ],
        [item(1), `<item objectid="60" transform="${c.item}" printable="1"/>`],
      ),
    },
    {
      name: SETTINGS,
      data: settingsXml(
        [{ id: 1 }, { id: 60 }],
        [
          {
            index: 1,
            instances: [
              [1, 0],
              [60, 0],
            ],
          },
        ],
      ),
    },
  ]);
}

/**
 * Review finding #394: object 100's one triangle names a vertex at
 * `index`, which a 32-bit index array cannot hold past 0xFFFFFFFF (it would
 * wrap to a small number). Plate 1 holds object 100, and the tetrahedron
 * too unless `alone`.
 */
export function wideIndex(index: number, alone: boolean): Buffer {
  const mesh =
    `<mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices>` +
    `<triangles><triangle v1="${index}" v2="1" v3="2"/></triangles></mesh>`;
  const tops = alone ? [100] : [1, 100];
  return overlappingZip([
    {
      name: ROOT,
      data: model(
        [meshObject(1, TETRA), meshObject(100, mesh)],
        tops.map((id, i) => item(id, i * 50)),
      ),
    },
    {
      name: SETTINGS,
      data: settingsXml(
        tops.map((id) => ({ id })),
        [{ index: 1, instances: tops.map((id) => [id, 0] as [number, number]) }],
      ),
    },
  ]);
}

/** The hostile file for a family and seed. */
export function hostile(family: Family, seed: number): HostileFile {
  const r = rng(seed);
  switch (family) {
    case "chain": {
      // M, then C0..Cd with Ck = [M, Ck+1]; Cd = [M].
      const depth = r(4, 16);
      const vertices = r(2_000, 20_000);
      const inRoot = r(0, 1) === 1;
      const objects: string[] = [meshObject(100, stripMesh(vertices))];
      for (let k = depth; k >= 0; k--) {
        const next = k === depth ? [] : [{ objectId: 200 + k + 1 }];
        objects.push(comps(200 + k, [{ objectId: 100 }, ...next]));
      }
      if (inRoot) {
        return {
          family,
          seed,
          label: `chain of ${depth} over a ${vertices}-vertex mesh in the root`,
          bytes: overlappingZip(project(objects, [200])),
        };
      }
      const part = "3D/Objects/chain.model";
      return {
        family,
        seed,
        label: `chain of ${depth} over a ${vertices}-vertex mesh in a part`,
        bytes: overlappingZip(
          project(
            [comps(300, [{ objectId: 200, path: `/${part}` }])],
            [300],
            [{ name: part, data: model(objects, null) }],
          ),
        ),
      };
    }
    case "fan": {
      const k = r(20, 400);
      const vertices = r(10, 2_000);
      const objects = [
        meshObject(100, stripMesh(vertices)),
        comps(
          101,
          Array.from({ length: k }, () => ({ objectId: 100 })),
        ),
        comps(
          102,
          Array.from({ length: k }, () => ({ objectId: 101 })),
        ),
      ];
      return {
        family,
        seed,
        label: `fan of ${k} x ${k} over a ${vertices}-vertex mesh`,
        bytes: overlappingZip(project(objects, [102])),
      };
    }
    case "sameNamePath": {
      // O0..Od in one part, each reaching the next through a p:path naming
      // that same part; Od is a mesh.
      const depth = r(3, 16);
      const part = "3D/Objects/self.model";
      const vertices = r(100, 5_000);
      const objects: string[] = [meshObject(500 + depth, stripMesh(vertices))];
      for (let k = depth - 1; k >= 0; k--) {
        objects.push(comps(500 + k, [{ objectId: 500 + k + 1, path: `/${part}` }]));
      }
      return {
        family,
        seed,
        label: `${depth} levels through p:path to the part they are in`,
        bytes: overlappingZip(
          project(
            [comps(300, [{ objectId: 500, path: `/${part}` }])],
            [300],
            [{ name: part, data: model(objects, null) }],
          ),
        ),
      };
    }
    case "overlapping": {
      // One stored part, inflating to about `padding` bytes of comments plus a
      // small mesh, listed under n names; the plate object names all of them.
      const n = r(50, 400);
      const padding = r(64, 256) * 1024;
      const body = model(
        [`<!-- ${"x".repeat(padding)} -->`, meshObject(1, stripMesh(r(10, 200)))],
        null,
      );
      const names = Array.from({ length: n }, (_, i) => `3D/Objects/o${i}.model`);
      return {
        family,
        seed,
        label: `${n} names for one part inflating to ${padding} bytes`,
        bytes: overlappingZip(
          project(
            [
              comps(
                300,
                names.map((name) => ({ objectId: 1, path: `/${name}` })),
              ),
            ],
            [300],
            names.map((name, i) =>
              i === 0 ? { name, data: body } : { name, data: "", sameBytesAs: names[0] as string },
            ),
          ),
        ),
      };
    }
    case "hugeMesh": {
      const vertices = r(50_000, 400_000);
      return {
        family,
        seed,
        label: `one mesh of ${vertices} vertices`,
        bytes: overlappingZip(project([meshObject(100, stripMesh(vertices))], [100])),
      };
    }
    case "longTags": {
      // Object 100 is on the plate, so its mesh is read and its long vertex
      // tag reaches attrs(); it cannot be read, and the tetrahedron is shown.
      const count = r(2, 5);
      const run = (i: number) => {
        const length = r(64, 1000) * 1024;
        return i % 2 === 0 ? "a".repeat(length) : `"${"a".repeat(length)}"`;
      };
      const objects: string[] = [];
      for (let i = 0; i < count; i++) objects.push(`<object ${run(i)}/>`);
      objects.push(
        meshObject(
          100,
          stripMesh(r(10, 200)).replace("<vertices>", `<vertices><vertex ${run(0)}/>`),
        ),
      );
      const files = project(objects, [100]);
      const root = files[0] as ZipEntrySpec;
      root.data = (root.data as string).replace("<build>", `<build><item ${run(1)}/>`);
      return {
        family,
        seed,
        label: `${count} long tags with no attribute, a long vertex and a long build item`,
        bytes: overlappingZip(files),
      };
    }
    case "duplicateSkipped": {
      const skipped = r(1_000, 18_000);
      const duplicates = r(100, 1_900);
      return {
        family,
        seed,
        label: `${duplicates} plate instances of an object of ${skipped} skipped components`,
        bytes: duplicateSkipped(skipped, duplicates),
      };
    }
    case "overflow": {
      const variant = r(0, 3);
      return {
        family,
        seed,
        label: `transforms that overflow, case ${variant}`,
        bytes: overflowing(variant),
      };
    }
    case "wideIndex": {
      const index = 0xffffffff + r(0, 3);
      return {
        family,
        seed,
        label: `a triangle naming vertex ${index}`,
        bytes: wideIndex(index, false),
      };
    }
    case "mixed": {
      const pick = FAMILIES[r(0, FAMILIES.length - 2)] as Family;
      const inner = hostile(pick, seed * 31 + 7);
      return { ...inner, family, label: `mixed: ${inner.label}` };
    }
  }
}
