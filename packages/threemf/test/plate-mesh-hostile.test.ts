// The plate mesh reader's limits hold by construction (issue #358, review
// findings #383 and #384): for any input, one readPlateMesh call never holds
// more than its memory budget in mesh arrays, never inflates more than its
// total, never does more than its parsing work or its component walk, and
// stops with too_large at the point a limit would be passed.
//
// The checks do not take the reader's word for it. Every hostile file from
// the seeded generator (support/hostile.ts) is read with two meters the
// reader cannot see: every Float32Array and Uint32Array allocated while it
// runs (tracking subclasses put in place of the globals for the call), and
// every inflated byte handed out by the zip layer (pump, wrapped), with the
// name of each entry read. The reader's own report (onBudget) must agree
// with those meters, and stay within the limits it was given.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const meters = vi.hoisted(() => ({ inflated: 0, reads: [] as string[] }));
vi.mock("../src/archive.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/archive.js")>();
  return {
    ...real,
    pump: (...args: Parameters<typeof real.pump>) => {
      const [zip, entry, cap, take] = args;
      meters.reads.push(entry.fileNameRaw.toString("latin1"));
      return real.pump(zip, entry, cap, (chunk) => {
        meters.inflated += chunk.length;
        return take(chunk);
      });
    },
  };
});

import {
  PLATE_MESH_LIMITS,
  type PlateMesh,
  type PlateMeshBudgetReport,
  PlateMeshError,
  type PlateMeshLimits,
  readPlateMesh,
  validatePlateMesh,
} from "../src/index.js";
import { buildZip, writeTmp } from "./support/fixture-builder.js";
import {
  duplicateSkipped,
  FAMILIES,
  type Family,
  hostile,
  overflowing,
  overlappingZip,
  stripMesh,
  wideIndex,
} from "./support/hostile.js";
import {
  boxMesh,
  buildItem,
  componentObject,
  meshObject,
  modelXml,
  moved,
  settingsXml,
} from "./support/plate-models.js";

const MiB = 1024 * 1024;

/** Lower limits than the defaults, so each case reaches them quickly. */
const LIMITS: Partial<PlateMeshLimits> = {
  meshBytes: 4 * MiB,
  inflateBytes: 8 * MiB,
  work: 50_000_000,
  walkSteps: 20_000_000,
  triangles: 150_000,
  instances: 2_000,
  components: 20_000,
};

/** One inflate chunk: the most a read can inflate past its total before it stops. */
const CHUNK_SLACK = 64 * 1024;

interface Run {
  outcome: PlateMesh | PlateMeshError;
  report: PlateMeshBudgetReport | undefined;
  /** Bytes of typed arrays allocated during the call, by the tracking subclasses. */
  allocated: number;
  inflated: number;
  reads: string[];
}

/** Bytes a typed array constructor call allocates: none for a view of an existing buffer. */
function allocates(args: unknown[], bytes: number): number {
  const first = args[0];
  return first instanceof ArrayBuffer || first instanceof SharedArrayBuffer ? 0 : bytes;
}

async function metered(bytes: Buffer, limits: Partial<PlateMeshLimits> = LIMITS): Promise<Run> {
  const path = writeTmp(bytes);
  const RealF32 = globalThis.Float32Array;
  const RealU32 = globalThis.Uint32Array;
  let allocated = 0;
  class F32 extends RealF32 {
    constructor(...args: unknown[]) {
      super(...(args as unknown as [number]));
      allocated += allocates(args, this.byteLength);
    }
  }
  class U32 extends RealU32 {
    constructor(...args: unknown[]) {
      super(...(args as unknown as [number]));
      allocated += allocates(args, this.byteLength);
    }
  }
  meters.inflated = 0;
  meters.reads = [];
  let report: PlateMeshBudgetReport | undefined;
  globalThis.Float32Array = F32 as typeof Float32Array;
  globalThis.Uint32Array = U32 as typeof Uint32Array;
  let outcome: PlateMesh | PlateMeshError;
  try {
    outcome = await readPlateMesh(path, 1, {
      limits,
      onBudget: (r: PlateMeshBudgetReport) => {
        report = r;
      },
    } as Parameters<typeof readPlateMesh>[2]);
  } catch (err) {
    if (!(err instanceof PlateMeshError)) throw err;
    outcome = err;
  } finally {
    globalThis.Float32Array = RealF32;
    globalThis.Uint32Array = RealU32;
  }
  return { outcome, report, allocated, inflated: meters.inflated, reads: [...meters.reads] };
}

/** The bytes of the distinct buffers a mesh's pieces keep alive. */
function liveBytesOf(mesh: PlateMesh): number {
  const buffers = new Set<ArrayBufferLike>();
  for (const p of mesh.pieces) {
    buffers.add(p.positions.buffer);
    buffers.add(p.indices.buffer);
  }
  let total = 0;
  for (const b of buffers) total += b.byteLength;
  return total;
}

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const cases = FAMILIES.flatMap((family) => SEEDS.map((seed) => [family, seed] as [Family, number]));

describe("readPlateMesh keeps every limit on hostile files", () => {
  it.each(cases)("%s, seed %i", async (family, seed) => {
    const file = hostile(family, seed);
    const run = await metered(file.bytes);
    const what = `${file.label} (${family} seed ${seed})`;

    // A mesh, or too_large; never damaged, no_mesh or a crash.
    if (run.outcome instanceof PlateMeshError) {
      expect(run.outcome.problem, `${what}: ${run.outcome.message}`).toBe("too_large");
    } else {
      expect(run.outcome.triangles, what).toBeLessThanOrEqual(LIMITS.triangles as number);
    }

    const report = run.report;
    expect(report, `${what}: no budget report`).toBeDefined();
    if (report === undefined) return;
    // Memory: the peak of live mesh arrays, and every allocation charged.
    expect(report.peakLiveBytes, what).toBeLessThanOrEqual(LIMITS.meshBytes as number);
    expect(run.allocated, `${what}: arrays allocated but not charged`).toBe(report.allocatedBytes);
    // Inflate: the total across every part and every read, every inflated
    // byte charged but the one chunk refused when the total is reached.
    expect(report.inflatedBytes, what).toBeLessThanOrEqual(LIMITS.inflateBytes as number);
    expect(run.inflated - report.inflatedBytes, what).toBeGreaterThanOrEqual(0);
    expect(run.inflated - report.inflatedBytes, what).toBeLessThanOrEqual(CHUNK_SLACK);
    // Work: every inflated character was charged as it was scanned (the files
    // are ASCII, one character a byte), and the total stays within the limit.
    expect(report.work, what).toBeGreaterThanOrEqual(report.inflatedBytes);
    expect(report.work, what).toBeLessThanOrEqual(LIMITS.work as number);
    expect(report.walkSteps, what).toBeLessThanOrEqual(LIMITS.walkSteps as number);
    // Nothing left charged but what the result holds.
    expect(report.liveBytes, what).toBe(
      run.outcome instanceof PlateMeshError ? 0 : liveBytesOf(run.outcome),
    );
    // Each part read at most twice: once for its objects, once more for meshes found needed later.
    const perPart = new Map<string, number>();
    for (const name of run.reads) perPart.set(name, (perPart.get(name) ?? 0) + 1);
    for (const [name, n] of perPart) {
      if (name.startsWith("Metadata/")) expect(n, `${what}: ${name}`).toBe(1);
      else expect(n, `${what}: ${name} read ${n} times`).toBeLessThanOrEqual(2);
    }
  });
});

describe("the review findings, by name", () => {
  it("#383: a part read again for a new object never makes a second copy of a mesh it holds", async () => {
    // A chain of 15 in a part of its own over one 12,282-vertex mesh: every
    // level needs one new object from the part. Holding the mesh once costs
    // about 295 KB, at most four times that with the growth of its arrays.
    const run = await metered(hostile("chain", 3).bytes, { ...LIMITS, triangles: 1_000_000 });
    const label = hostile("chain", 3).label;
    expect(label).toMatch(/in a part/);
    const meshOnce = 12_282 * 12 + 12_280 * 12;
    expect(run.allocated, label).toBeLessThanOrEqual(4 * meshOnce + 64 * 1024);
  });

  it("#384: the bytes inflated across every part and read stay within the total", async () => {
    const file = hostile("overlapping", 6);
    const run = await metered(file.bytes);
    expect(run.inflated, file.label).toBeLessThanOrEqual(
      (LIMITS.inflateBytes as number) + CHUNK_SLACK,
    );
    expect(run.outcome, file.label).toBeInstanceOf(PlateMeshError);
    expect((run.outcome as PlateMeshError).problem).toBe("too_large");
  });

  it("a part every level reaches through its own name is read at most twice", async () => {
    const file = hostile("sameNamePath", 5);
    const run = await metered(file.bytes);
    const reads = run.reads.filter((n) => n === "3D/Objects/self.model").length;
    expect(reads, file.label).toBeLessThanOrEqual(2);
  });

  it("tags as long as the scanner allows, with no = in them, are read in one pass each", async () => {
    // A backtracking attribute regex took minutes on each of these tags, on
    // the server's main thread and outside the work budget (review of PR
    // #368). Read under the default limits, so every tag reaches attrs().
    for (const seed of [1, 2, 3]) {
      const file = hostile("longTags", seed);
      const started = performance.now();
      const run = await metered(file.bytes, {});
      const took = performance.now() - started;
      expect(run.outcome, file.label).not.toBeInstanceOf(PlateMeshError);
      // Only the tetrahedron: object 100's long vertex leaves its mesh unreadable.
      expect((run.outcome as PlateMesh).pieces, file.label).toHaveLength(1);
      expect((run.outcome as PlateMesh).triangles, file.label).toBe(4);
      expect(took, file.label).toBeLessThan(5000);
    }
  });

  it("a placed mesh's triangles count when it is placed, so a chain over a big mesh stops before its mesh is read", async () => {
    // 11 instances of a 5,497-vertex mesh draw about 60,000 triangles, over
    // the 20,000 asked for: refused while walking, before M is held.
    const file = hostile("chain", 7);
    expect(file.label).toMatch(/chain of 1[0-6]/);
    const run = await metered(file.bytes, { ...LIMITS, triangles: 20_000 });
    expect(run.outcome).toBeInstanceOf(PlateMeshError);
    expect((run.outcome as PlateMeshError).problem).toBe("too_large");
    expect(run.report?.peakLiveBytes ?? Number.POSITIVE_INFINITY).toBeLessThan(64 * 1024);
  });
});

describe("each mesh is read once and only what the result uses is kept", () => {
  /** A project with root objects and plate 1's instances, every mesh in 3D/3dmodel.model. */
  function rootOnly(
    resources: string[],
    items: string[],
    instances: Array<[number, number]>,
  ): Buffer {
    const ids = [...new Set(instances.map(([id]) => id))];
    return overlappingZip([
      { name: "3D/3dmodel.model", data: modelXml(resources, items) },
      {
        name: "Metadata/model_settings.config",
        data: settingsXml(
          ids.map((id) => ({ id })),
          [{ index: 1, instances }],
        ),
      },
    ]);
  }

  it("a mesh taken on a part's first read is not read again when the part is read for another", async () => {
    // A (big, a plate object: taken on the root's first read) and B, made of
    // the small mesh C, which is found needed only after that read.
    const alone = await metered(
      rootOnly([meshObject(1, stripMesh(20_000))], [buildItem(1)], [[1, 0]]),
    );
    const both = await metered(
      rootOnly(
        [
          meshObject(1, stripMesh(20_000)),
          meshObject(3, stripMesh(10)),
          componentObject(2, [{ objectId: 3 }]),
        ],
        [buildItem(1), buildItem(2, moved(50, 0))],
        [
          [1, 0],
          [2, 0],
        ],
      ),
    );
    expect(both.reads.filter((n) => n === "3D/3dmodel.model")).toHaveLength(2);
    // Only C's small arrays on top of A's: A was not read a second time.
    expect(both.allocated - alone.allocated).toBeLessThanOrEqual(2 * 3 * 256 * 4);
  });

  it("a mesh read but placed nowhere is freed before the result is handed back", async () => {
    // Object 1's mesh is taken on the root's first read, as a plate object,
    // but its instance 5 has no build item, so nothing places it.
    const run = await metered(
      rootOnly(
        [meshObject(1, stripMesh(5_000)), meshObject(2, stripMesh(10))],
        [buildItem(1), buildItem(2, moved(50, 0))],
        [
          [1, 5],
          [2, 0],
        ],
      ),
    );
    expect(run.outcome).not.toBeInstanceOf(PlateMeshError);
    const mesh = run.outcome as PlateMesh;
    expect(mesh.pieces).toHaveLength(1);
    expect(run.report?.liveBytes).toBe(liveBytesOf(mesh));
    expect(run.report?.peakLiveBytes ?? 0).toBeGreaterThan(liveBytesOf(mesh));
  });
});

describe("the limits a caller may set", () => {
  it("can be lowered but never raised past the defaults", async () => {
    const file = hostile("hugeMesh", 1);
    const raised = await metered(file.bytes, {
      meshBytes: PLATE_MESH_LIMITS.meshBytes * 10,
      inflateBytes: PLATE_MESH_LIMITS.inflateBytes * 10,
    });
    expect(raised.report?.limits.meshBytes).toBe(PLATE_MESH_LIMITS.meshBytes);
    expect(raised.report?.limits.inflateBytes).toBe(PLATE_MESH_LIMITS.inflateBytes);
    const lowered = await metered(file.bytes, { meshBytes: 64 * 1024 });
    expect(lowered.report?.limits.meshBytes).toBe(64 * 1024);
    expect((lowered.outcome as PlateMeshError).problem).toBe("too_large");
  });
});

describe("the limits hold by construction", () => {
  const source = readFileSync(new URL("../src/plate-mesh.ts", import.meta.url), "utf8");
  /** The text of a top-level class or function, up to the next one. */
  const body = (start: string): string => {
    const at = source.indexOf(start);
    expect(at, start).toBeGreaterThanOrEqual(0);
    const next = source.slice(at + start.length).search(/\n(class|async function|function) /);
    return source.slice(at, next < 0 ? undefined : at + start.length + next);
  };

  it("makes mesh arrays only inside the budget, which charges before it allocates", () => {
    const allocations = [...source.matchAll(/new (Float32Array|Uint32Array)\(/g)];
    expect(allocations).toHaveLength(2);
    const budget = body("class Budget {");
    for (const a of allocations) expect(budget).toContain(a[0]);
    const charge = budget.indexOf("this.charge(length * 4);");
    expect(charge).toBeGreaterThanOrEqual(0);
    expect(charge).toBeLessThan(budget.indexOf("new Float32Array("));
    // No other way to a typed array: no slice, from, of or copy of one.
    expect(source).not.toMatch(/\.slice\(0, 3 \*|Float32Array\.from|Uint32Array\.from/);
  });

  it("inflates only through inflateEntry, which charges each chunk before handing it on", () => {
    expect([...source.matchAll(/\bpump\(/g)]).toHaveLength(1);
    const inflate = body("async function inflateEntry(");
    expect(inflate).toContain("pump(");
    const charge = inflate.indexOf("budget.inflate(chunk.length);");
    expect(charge).toBeGreaterThanOrEqual(0);
    expect(charge).toBeLessThan(inflate.indexOf("take(chunk);"));
    expect(source).not.toMatch(/readCapped/);
  });
});

describe("the third round of review findings, by name", () => {
  it("#392: 9,999 plate instances of an object of 99,990 skipped components take one walk of it, not 9,999", async () => {
    const started = performance.now();
    // 9,999 copies and the tetrahedron: exactly the 10,000 requests the instance limit allows.
    const run = await metered(duplicateSkipped(99_990, 9_999), {});
    const took = performance.now() - started;
    expect(run.outcome).not.toBeInstanceOf(PlateMeshError);
    // The tetrahedron, once; object 50 places nothing.
    expect((run.outcome as PlateMesh).instances).toHaveLength(1);
    // Walking object 50 once is about 100,000 steps; once per instance would be 1e9.
    expect(run.report?.walkSteps ?? Number.POSITIVE_INFINITY).toBeLessThan(20_000_000);
    expect(run.report?.work ?? Number.POSITIVE_INFINITY).toBeLessThan(20_000_000);
    expect(took).toBeLessThan(5_000);
  }, 120_000);

  it.each([0, 1, 2, 3, 4])(
    "#393: transforms that overflow (case %i) place nothing; every transform handed back is finite as a float32",
    async (variant) => {
      const run = await metered(overflowing(variant), {});
      expect(run.outcome).not.toBeInstanceOf(PlateMeshError);
      const mesh = run.outcome as PlateMesh;
      for (const inst of mesh.instances) {
        for (const n of inst.transform)
          expect(Number.isFinite(Math.fround(n)), String(n)).toBe(true);
      }
      // Only the tetrahedron is placed.
      expect(mesh.instances).toHaveLength(1);
    },
  );

  it.each([0xffffffff, 0x100000000, 0x100000001, 2 ** 40])(
    "#394: a triangle naming vertex %i is refused, never wrapped to a small number",
    async (index) => {
      const run = await metered(wideIndex(index, true), {});
      expect(run.outcome).toBeInstanceOf(PlateMeshError);
      expect((run.outcome as PlateMeshError).problem).toBe("no_mesh");
    },
  );
});

describe("every result is a mesh that passes the validator, or a verdict on the file", () => {
  it.each(cases)("%s, seed %i", async (family, seed) => {
    const file = hostile(family, seed);
    const run = await metered(file.bytes);
    if (run.outcome instanceof PlateMeshError) return;
    // The validator the server runs on the main thread before anything is stored.
    expect(() => validatePlateMesh(run.outcome, LIMITS), file.label).not.toThrow();
  });
});

describe("the component walk budget", () => {
  it("a walk of copies that all overflow ends on the walk budget", async () => {
    // Walk steps have their own limit, apart from the characters scanned:
    // about 27 ns a step, so the whole budget is a few seconds.
    expect(PLATE_MESH_LIMITS.walkSteps).toBe(200_000_000);
    expect(PLATE_MESH_LIMITS.work).toBe(2_000_000_000);
    const scale = "1e20 0 0 0 1e20 0 0 0 1e20 0 0 0";
    const components = Array.from({ length: 90_000 }, () => ({ objectId: 1, transform: scale }));
    const items = Array.from({ length: 3_000 }, () => buildItem(2, scale));
    const bytes = buildZip([
      {
        name: "3D/3dmodel.model",
        data: modelXml([meshObject(1, boxMesh(10)), componentObject(2, components)], items),
      },
      {
        name: "Metadata/model_settings.config",
        data: settingsXml(
          [{ id: 1 }, { id: 2 }],
          [{ index: 1, instances: items.map((_, i): [number, number] => [2, i]) }],
        ),
      },
    ]);
    const started = performance.now();
    const run = await metered(bytes, {});
    const took = performance.now() - started;
    expect(run.outcome).toBeInstanceOf(PlateMeshError);
    expect((run.outcome as PlateMeshError).problem).toBe("too_large");
    expect((run.outcome as PlateMeshError).message).toContain("component walk");
    expect(run.report?.walkSteps).toBe(PLATE_MESH_LIMITS.walkSteps);
    expect(took).toBeLessThan(30_000);
  }, 30_000);
});
