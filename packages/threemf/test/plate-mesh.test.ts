// Issue #358: the 3D view of one .3mf plate. readPlateMesh reads only the
// objects on that plate out of the file, with their placement and the
// colour of the filament each prints with, so the server can turn them into
// the mesh the model page shows. Both layouts Bambu Studio writes are read:
// every mesh in 3D/3dmodel.model (buildSliceable), and meshes in parts of
// their own under 3D/Objects/ that components point at. Every fixture is
// built here; no designer file is used.
import { describe, expect, it } from "vitest";
import {
  PLATE_MESH_LIMITS,
  type PlateMesh,
  PlateMeshError,
  type PlateMeshProblem,
  ReadUnavailable,
  readPlateMesh,
} from "../src/index.js";
import { buildZip, writeTmp, type ZipEntry } from "./support/fixture-builder.js";
import {
  boxMesh,
  buildItem,
  componentObject,
  IDENTITY,
  meshObject,
  meshXml,
  modelXml,
  moved,
  projectJson,
  type SettingsObject,
  type SettingsPlate,
  settingsXml,
} from "./support/plate-models.js";
import { buildSliceable, plateOrigin } from "./support/sliceable.js";

const ROOT = "3D/3dmodel.model";
const SETTINGS = "Metadata/model_settings.config";
const PROJECT = "Metadata/project_settings.config";

const file = (entries: ZipEntry[]): string => writeTmp(buildZip(entries));

interface Placed {
  colour: string | null;
  vertices: number;
  triangles: number;
  /** The instance's whole transform, 12 numbers, rounded to 1e-6. */
  transform: number[];
}

/** Each instance on the plate, in a stable order, with its piece's sizes and colour. */
function placed(mesh: PlateMesh): Placed[] {
  return mesh.instances
    .map((inst) => {
      const piece = mesh.pieces[inst.piece];
      if (piece === undefined) throw new Error(`instance names piece ${inst.piece}`);
      return {
        colour: piece.colour,
        vertices: piece.positions.length / 3,
        triangles: piece.indices.length / 3,
        transform: inst.transform.map((n) => Math.round(n * 1e6) / 1e6),
      };
    })
    .sort((a, b) => {
      for (let i = 9; i < 12; i++) {
        const d = (a.transform[i] ?? 0) - (b.transform[i] ?? 0);
        if (d !== 0) return d;
      }
      return String(a.colour).localeCompare(String(b.colour));
    });
}

async function problemOf(path: string, plate: number): Promise<PlateMeshProblem> {
  try {
    await readPlateMesh(path, plate);
  } catch (err) {
    if (err instanceof PlateMeshError) return err.problem;
    throw err;
  }
  throw new Error("expected a PlateMeshError, got a mesh");
}

/** A split project: the root's component objects, the parts' meshes, settings and colours. */
function split(opts: {
  root: string[];
  build: string[];
  parts: Record<string, string>;
  objects: SettingsObject[];
  plates: SettingsPlate[];
  colours?: string[] | null;
}): string {
  const entries: ZipEntry[] = [
    { name: ROOT, data: modelXml(opts.root, opts.build) },
    { name: SETTINGS, data: settingsXml(opts.objects, opts.plates) },
  ];
  for (const [name, data] of Object.entries(opts.parts)) entries.push({ name, data });
  if (opts.colours !== null) {
    entries.push({ name: PROJECT, data: projectJson(opts.colours ?? ["#C12E1F", "#2850E0"]) });
  }
  return file(entries);
}

describe("readPlateMesh on a multi-plate file with every mesh in 3D/3dmodel.model", () => {
  const path = writeTmp(buildSliceable({ plates: 3, filaments: 2 }));

  it("reads only the objects on the plate asked for, placed where they sit", async () => {
    const mesh = await readPlateMesh(path, 2);
    expect(mesh.plate).toBe(2);
    const origin = plateOrigin(1, 3);
    expect(placed(mesh)).toEqual([
      {
        colour: "#FFFFFF",
        vertices: 8,
        triangles: 12,
        transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, origin.x + 40, origin.y + 40, 0],
      },
      {
        colour: "#1F1F1F",
        vertices: 8,
        triangles: 12,
        transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, origin.x + 85, origin.y + 40, 0],
      },
    ]);
    expect(mesh.triangles).toBe(24);
  });

  it("gives each plate its own objects", async () => {
    for (const plate of [1, 2, 3]) {
      const origin = plateOrigin(plate - 1, 3);
      const xs = placed(await readPlateMesh(path, plate)).map((p) => p.transform[9]);
      expect(xs).toEqual([origin.x + 40, origin.x + 85]);
    }
  });

  it("keeps the mesh in the object's own coordinates, so the transform places it", async () => {
    const mesh = await readPlateMesh(path, 1);
    const piece = mesh.pieces[0];
    expect(piece).toBeDefined();
    const xs = [];
    for (let i = 0; i < (piece?.positions.length ?? 0); i += 3) xs.push(piece?.positions[i]);
    expect(Math.min(...(xs as number[]))).toBe(0);
    expect(Math.max(...(xs as number[]))).toBe(20);
  });

  it("is not a plate the file lists", async () => {
    expect(await problemOf(path, 4)).toBe("no_plate");
  });
});

describe("readPlateMesh on a split file (meshes in 3D/Objects/*.model)", () => {
  const OBJ1 = "/3D/Objects/object_1.model";
  const OBJ2 = "/3D/Objects/object_2.model";
  const twoParts = modelXml(
    [meshObject(1, boxMesh(10)), meshObject(2, boxMesh(4)), meshObject(3, boxMesh(30))],
    null,
  );
  const path = split({
    root: [
      // A two-part object with a modifier (part 3) that is never printed.
      componentObject(10, [
        { objectId: 1, path: OBJ1, transform: IDENTITY },
        { objectId: 2, path: OBJ1, transform: moved(3, 3, 10) },
        { objectId: 3, path: OBJ1, transform: IDENTITY },
      ]),
      componentObject(20, [{ objectId: 1, path: OBJ2, transform: moved(5, 0, 0) }]),
    ],
    build: [
      buildItem(10, moved(100, 50, 0)),
      buildItem(10, moved(140, 50, 0)),
      // Turned a quarter about z, then moved: the component's own move turns with it.
      buildItem(20, "0 1 0 -1 0 0 0 0 1 400 0 0"),
    ],
    parts: {
      "3D/Objects/object_1.model": twoParts,
      "3D/Objects/object_2.model": modelXml([meshObject(1, boxMesh(8))], null),
    },
    objects: [
      {
        id: 10,
        extruder: 1,
        parts: [{ id: 1 }, { id: 2, extruder: 2 }, { id: 3, subtype: "modifier_part" }],
      },
      { id: 20, extruder: 2 },
    ],
    plates: [
      {
        index: 1,
        instances: [
          [10, 0],
          [10, 1],
        ],
      },
      { index: 2, instances: [[20, 0]] },
    ],
  });

  it("follows each component into its part and places it by the component's and the item's transforms", async () => {
    const mesh = await readPlateMesh(path, 1);
    expect(placed(mesh)).toEqual([
      {
        colour: "#C12E1F",
        vertices: 8,
        triangles: 12,
        transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 100, 50, 0],
      },
      {
        colour: "#2850E0",
        vertices: 8,
        triangles: 12,
        transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 103, 53, 10],
      },
      {
        colour: "#C12E1F",
        vertices: 8,
        triangles: 12,
        transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 140, 50, 0],
      },
      {
        colour: "#2850E0",
        vertices: 8,
        triangles: 12,
        transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 143, 53, 10],
      },
    ]);
  });

  it("shares one piece between the instances of an object", async () => {
    const mesh = await readPlateMesh(path, 1);
    expect(mesh.instances).toHaveLength(4);
    expect(mesh.pieces).toHaveLength(2);
    expect(mesh.triangles).toBe(48);
  });

  it("leaves out a modifier, which is never printed", async () => {
    const mesh = await readPlateMesh(path, 1);
    // The 30 mm modifier box would be the only piece reaching x = 30.
    for (const piece of mesh.pieces) {
      expect(Math.max(...piece.positions)).toBeLessThanOrEqual(10);
    }
  });

  it("applies the component's transform before the item's", async () => {
    const mesh = await readPlateMesh(path, 2);
    expect(placed(mesh)).toEqual([
      {
        colour: "#2850E0",
        vertices: 8,
        triangles: 12,
        transform: [0, 1, 0, -1, 0, 0, 0, 0, 1, 400, 5, 0],
      },
    ]);
  });

  it("does not read the parts of objects on other plates", async () => {
    const broken = split({
      root: [
        componentObject(10, [{ objectId: 1, path: OBJ1 }]),
        componentObject(20, [{ objectId: 1, path: OBJ2 }]),
      ],
      build: [buildItem(10), buildItem(20, moved(300, 0))],
      parts: {
        "3D/Objects/object_1.model": modelXml([meshObject(1, boxMesh(10))], null),
        "3D/Objects/object_2.model": '<model><resources><object id="1"><mesh><vertices><vertex',
      },
      objects: [{ id: 10 }, { id: 20 }],
      plates: [
        { index: 1, instances: [[10, 0]] },
        { index: 2, instances: [[20, 0]] },
      ],
    });
    expect(placed(await readPlateMesh(broken, 1))).toHaveLength(1);
  });

  it("takes the first build item of an object when the plate gives no instance id", async () => {
    const one = split({
      root: [componentObject(10, [{ objectId: 1, path: OBJ1 }])],
      build: [buildItem(10, moved(7, 8, 0)), buildItem(10, moved(70, 80, 0))],
      parts: { "3D/Objects/object_1.model": modelXml([meshObject(1, boxMesh(10))], null) },
      objects: [{ id: 10 }],
      plates: [{ index: 1, instances: [[10, undefined]] }],
    });
    expect(placed(await readPlateMesh(one, 1)).map((p) => p.transform.slice(9))).toEqual([
      [7, 8, 0],
    ]);
  });
});

describe("readPlateMesh colours each object by its filament", () => {
  function oneBox(objects: SettingsObject[], colours: string[] | null): string {
    return file([
      {
        name: ROOT,
        data: modelXml([meshObject(1, boxMesh(10))], [buildItem(1)]),
      },
      { name: SETTINGS, data: settingsXml(objects, [{ index: 1, instances: [[1, 0]] }]) },
      ...(colours === null ? [] : [{ name: PROJECT, data: projectJson(colours) }]),
    ]);
  }

  const colourOf = async (path: string) => (await readPlateMesh(path, 1)).pieces[0]?.colour;

  it("uses the colour of the object's filament", async () => {
    expect(await colourOf(oneBox([{ id: 1, extruder: 2 }], ["#111111", "#22aa33"]))).toBe(
      "#22aa33",
    );
  });

  it("uses filament 1 for an object that names none", async () => {
    expect(await colourOf(oneBox([{ id: 1 }], ["#111111", "#22aa33"]))).toBe("#111111");
  });

  it("drops a colour's alpha, since the view draws every object solid", async () => {
    expect(await colourOf(oneBox([{ id: 1 }], ["#FFFFFF80"]))).toBe("#FFFFFF");
  });

  it.each([
    ["the file names no colours", 1, null],
    ["the filament is past the colour list", 2, ["#111111"]],
    ["the colour is not #RRGGBB", 1, ["red"]],
  ])("has no colour when %s", async (_why, extruder, colours) => {
    const objects = [{ id: 1, extruder }];
    expect(await colourOf(oneBox(objects, colours as string[] | null))).toBeNull();
  });
});

describe("readPlateMesh on a file with no readable mesh", () => {
  function onePlate(root: string, extra: ZipEntry[] = []): string {
    return file([
      { name: ROOT, data: root },
      { name: SETTINGS, data: settingsXml([{ id: 1 }], [{ index: 1, instances: [[1, 0]] }]) },
      ...extra,
    ]);
  }

  it.each([
    ["the object has no mesh", modelXml(['<object id="1" type="model"/>'], [buildItem(1)])],
    [
      "the mesh has no triangles",
      modelXml([meshObject(1, meshXml([[0, 0, 0]], []))], [buildItem(1)]),
    ],
    [
      "a triangle names a vertex the mesh does not have",
      modelXml(
        [
          meshObject(
            1,
            meshXml(
              [
                [0, 0, 0],
                [1, 0, 0],
                [0, 1, 0],
              ],
              [[0, 1, 3]],
            ),
          ),
        ],
        [buildItem(1)],
      ),
    ],
    [
      "a vertex is not a number",
      modelXml(
        [
          meshObject(
            1,
            meshXml(
              [
                [0, 0, 0],
                [1, 0, 0],
                [Number.NaN, 1, 0],
              ],
              [[0, 1, 2]],
            ),
          ),
        ],
        [buildItem(1)],
      ),
    ],
    [
      "the component's part is missing",
      modelXml(
        [componentObject(1, [{ objectId: 1, path: "/3D/Objects/missing.model" }])],
        [buildItem(1)],
      ),
    ],
    ["the plate's object has no build item", modelXml([meshObject(1, boxMesh(10))], [])],
  ])("says no_mesh when %s", async (_why, root) => {
    expect(await problemOf(onePlate(root), 1)).toBe("no_mesh");
  });

  it("says no_mesh when the file has no 3D/3dmodel.model", async () => {
    const path = file([
      { name: SETTINGS, data: settingsXml([{ id: 1 }], [{ index: 1, instances: [[1, 0]] }]) },
    ]);
    expect(await problemOf(path, 1)).toBe("no_mesh");
  });

  it("shows the objects it can read when another on the plate has no mesh", async () => {
    const path = file([
      {
        name: ROOT,
        data: modelXml(
          [meshObject(1, boxMesh(10)), '<object id="2" type="model"/>'],
          [buildItem(1), buildItem(2, moved(50, 0))],
        ),
      },
      {
        name: SETTINGS,
        data: settingsXml(
          [{ id: 1 }, { id: 2 }],
          [
            {
              index: 1,
              instances: [
                [1, 0],
                [2, 0],
              ],
            },
          ],
        ),
      },
    ]);
    expect(placed(await readPlateMesh(path, 1))).toHaveLength(1);
  });

  it("says no_objects for a plate with nothing on it", async () => {
    const path = file([
      { name: ROOT, data: modelXml([meshObject(1, boxMesh(10))], [buildItem(1)]) },
      {
        name: SETTINGS,
        data: settingsXml(
          [{ id: 1 }],
          [
            { index: 1, instances: [[1, 0]] },
            { index: 2, instances: [] },
          ],
        ),
      },
    ]);
    expect(await problemOf(path, 2)).toBe("no_objects");
  });

  it("says damaged for bytes that are not a zip", async () => {
    expect(await problemOf(writeTmp(Buffer.from("not a zip at all")), 1)).toBe("damaged");
  });

  it("says damaged for a model part with a DTD", async () => {
    const root = `<?xml version="1.0"?><!DOCTYPE model [<!ENTITY x "y">]>${modelXml(
      [meshObject(1, boxMesh(10))],
      [buildItem(1)],
    ).replace(/^<\?xml[^>]*>/, "")}`;
    expect(await problemOf(onePlate(root), 1)).toBe("damaged");
  });

  it("throws ReadUnavailable, never a problem, when the file cannot be opened", async () => {
    await expect(readPlateMesh("/nonexistent/platehouse/plate.3mf", 1)).rejects.toBeInstanceOf(
      ReadUnavailable,
    );
  });
});

describe("readPlateMesh limits", () => {
  const path = writeTmp(buildSliceable({ plates: 1, filaments: 3 }));

  it("says too_large when the plate has more triangles than the limit", async () => {
    expect(PLATE_MESH_LIMITS.triangles).toBeGreaterThanOrEqual(1_000_000);
    await expect(readPlateMesh(path, 1, { maxTriangles: 36 })).resolves.toBeDefined();
    try {
      await readPlateMesh(path, 1, { maxTriangles: 35 });
      throw new Error("expected too_large");
    } catch (err) {
      expect(err).toBeInstanceOf(PlateMeshError);
      expect((err as PlateMeshError).problem).toBe("too_large");
    }
  });

  it.each([Number.NaN, 0, -1, Number.POSITIVE_INFINITY, 1e12])(
    "ignores a maxTriangles of %s that would lift or break the limit",
    async (max) => {
      await expect(readPlateMesh(path, 1, { maxTriangles: max })).resolves.toBeDefined();
    },
  );

  it("refuses components nested deeper than the limit as no_mesh, never looping", async () => {
    // Object 1 holds object 1: a loop a careless reader would follow for ever.
    const loop = file([
      {
        name: ROOT,
        data: modelXml([componentObject(1, [{ objectId: 1 }])], [buildItem(1)]),
      },
      { name: SETTINGS, data: settingsXml([{ id: 1 }], [{ index: 1, instances: [[1, 0]] }]) },
    ]);
    expect(await problemOf(loop, 1)).toBe("no_mesh");
  });

  it("says too_large for components that double at every level, before holding them all", async () => {
    // Object 1 holds itself twice: 2^n requests at depth n.
    const fan = file([
      {
        name: ROOT,
        data: modelXml([componentObject(1, [{ objectId: 1 }, { objectId: 1 }])], [buildItem(1)]),
      },
      { name: SETTINGS, data: settingsXml([{ id: 1 }], [{ index: 1, instances: [[1, 0]] }]) },
    ]);
    expect(await problemOf(fan, 1)).toBe("too_large");
  });
});
