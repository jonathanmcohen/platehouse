// Issue #358, review findings #392 to #394: the one contract a plate mesh
// must meet before the server stores anything made from it. The reader runs
// in a worker; whatever comes back is checked by validatePlateMesh on the
// main thread, and anything that fails is the file's fault: no_mesh for a
// mesh that is not well formed, too_large for one past a limit.
import { describe, expect, it } from "vitest";
import {
  PLATE_MESH_LIMITS,
  type PlateMesh,
  PlateMeshError,
  validatePlateMesh,
} from "../src/index.js";

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

/** Two pieces, one placed twice: 3 triangles drawn. */
function good(): PlateMesh {
  return {
    plate: 1,
    pieces: [
      {
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        indices: new Uint32Array([0, 1, 2]),
        colour: "#FF8800",
      },
      {
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
        indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
        colour: null,
      },
    ],
    instances: [
      { piece: 0, transform: [...IDENTITY] },
      { piece: 1, transform: [2, 0, 0, 0, 2, 0, 0, 0, 2, 10, 20, 30] },
    ],
    triangles: 3,
  };
}

function problemOf(value: unknown, limits = {}): string {
  try {
    validatePlateMesh(value, limits);
  } catch (err) {
    if (err instanceof PlateMeshError) return err.problem;
    throw err;
  }
  return "passed";
}

describe("validatePlateMesh", () => {
  it("passes a well formed mesh and hands back its parts", () => {
    const mesh = good();
    const out = validatePlateMesh(mesh);
    expect(out.plate).toBe(1);
    expect(out.pieces).toHaveLength(2);
    expect(out.pieces[1]?.indices).toBe(mesh.pieces[1]?.indices);
    expect(out.instances.map((i) => i.piece)).toEqual([0, 1]);
    expect(out.triangles).toBe(3);
  });

  it.each([
    ["not an object", null],
    ["no pieces", { ...good(), pieces: [] }],
    ["no instances", { ...good(), instances: [] }],
    ["a plate that is not a whole number from 1", { ...good(), plate: 0 }],
    ["pieces that are not a list", { ...good(), pieces: {} }],
  ])("refuses %s as no_mesh", (_why, value) => {
    expect(problemOf(value)).toBe("no_mesh");
  });

  const withPiece = (change: Record<string, unknown>) => {
    const mesh = good() as unknown as { pieces: Array<Record<string, unknown>> };
    mesh.pieces[0] = { ...mesh.pieces[0], ...change };
    return mesh;
  };

  it.each([
    ["a NaN coordinate", { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, Number.NaN, 0]) }],
    ["an infinite coordinate", { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, Number.POSITIVE_INFINITY, 0]) }],
    ["coordinates that are not a Float32Array", { positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) }],
    ["coordinates in a plain list", { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0] }],
    ["coordinates not a whole number of vertices", { positions: new Float32Array([0, 0, 0, 1, 0]) }],
    ["an index past the last vertex", { indices: new Uint32Array([0, 1, 3]) }],
    ["indices that are not a Uint32Array", { indices: new Float64Array([0, 1, 2 ** 32]) }],
    ["indices not a whole number of triangles", { indices: new Uint32Array([0, 1]) }],
    ["no triangles", { indices: new Uint32Array([]) }],
    ["a colour that is not #RRGGBB", { colour: "red" }],
  ])("refuses a piece with %s as no_mesh", (_why, change) => {
    expect(problemOf(withPiece(change))).toBe("no_mesh");
  });

  it.each([
    ["Infinity", Number.POSITIVE_INFINITY],
    ["NaN", Number.NaN],
    ["a double past the largest float32", 3.5e38],
    ["a string", "1"],
  ])("refuses a transform holding %s as no_mesh", (_why, bad) => {
    const mesh = good() as unknown as { instances: Array<{ piece: number; transform: unknown[] }> };
    const transform = [...IDENTITY] as unknown[];
    transform[9] = bad;
    (mesh.instances[1] as { transform: unknown[] }).transform = transform;
    expect(problemOf(mesh)).toBe("no_mesh");
  });

  it.each([
    ["11 numbers", IDENTITY.slice(1)],
    ["13 numbers", [...IDENTITY, 0]],
  ])("refuses a transform of %s as no_mesh", (_why, transform) => {
    const mesh = good();
    (mesh.instances[0] as { transform: number[] }).transform = transform;
    expect(problemOf(mesh)).toBe("no_mesh");
  });

  it.each([
    ["past the last piece", 2],
    ["negative", -1],
    ["not a whole number", 0.5],
  ])("refuses an instance naming a piece %s as no_mesh", (_why, piece) => {
    const mesh = good();
    (mesh.instances[0] as { piece: number }).piece = piece;
    expect(problemOf(mesh)).toBe("no_mesh");
  });

  it("refuses a triangle count that does not match its instances as no_mesh", () => {
    expect(problemOf({ ...good(), triangles: 4 })).toBe("no_mesh");
  });

  it("refuses more triangles drawn than the limit as too_large", () => {
    expect(problemOf(good(), { triangles: 2 })).toBe("too_large");
    expect(problemOf(good(), { triangles: 3 })).toBe("passed");
  });

  it("refuses more instances than the limit as too_large", () => {
    expect(problemOf(good(), { instances: 1 })).toBe("too_large");
  });

  it("refuses more mesh bytes than the limit as too_large, counting each buffer once", () => {
    const mesh = good();
    // Both pieces' arrays: 36 + 12 + 48 + 24 bytes.
    expect(problemOf(mesh, { meshBytes: 119 })).toBe("too_large");
    expect(problemOf(mesh, { meshBytes: 120 })).toBe("passed");
    // A piece sharing another's buffers adds nothing.
    const shared = good();
    shared.pieces.push({ ...(shared.pieces[0] as PlateMesh["pieces"][number]), colour: "#000000" });
    expect(problemOf(shared, { meshBytes: 120 })).toBe("passed");
  });

  it("counts a view's whole buffer, since that is what it keeps alive", () => {
    const mesh = good();
    const big = new Float32Array(1024);
    big.set([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    (mesh.pieces[0] as { positions: Float32Array }).positions = big.subarray(0, 9);
    expect(problemOf(mesh, { meshBytes: 4096 })).toBe("too_large");
  });

  it("never lets a caller raise a limit past the default", () => {
    expect(problemOf(good(), { triangles: PLATE_MESH_LIMITS.triangles * 10 })).toBe("passed");
  });
});
