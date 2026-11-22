// The plate mesh reader's limits hold by construction (issue #358, review
// findings #383 and #384): for any input, one readPlateMesh call never holds
// more than its memory budget in mesh arrays, never inflates more than its
// total, never does more than its parsing work, and stops with too_large at
// the point a limit would be passed.
//
// The checks do not take the reader's word for it. Every hostile file from
// the seeded generator (support/hostile.ts) is read with two meters the
// reader cannot see: every Float32Array and Uint32Array allocated while it
// runs (tracking subclasses put in place of the globals for the call), and
// every inflated byte handed out by the zip layer (pump, wrapped), with the
// name of each entry read. The reader's own report (onBudget) must agree
// with those meters, and stay within the limits it was given.
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
} from "../src/index.js";
import { writeTmp } from "./support/fixture-builder.js";
import { FAMILIES, type Family, hostile } from "./support/hostile.js";

const MiB = 1024 * 1024;

/** Lower limits than the defaults, so each case reaches them quickly. */
const LIMITS: Partial<PlateMeshLimits> = {
  meshBytes: 4 * MiB,
  inflateBytes: 8 * MiB,
  work: 3_000_000,
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
    constructor(...args: ConstructorParameters<typeof Float32Array>) {
      super(...(args as [number]));
      allocated += allocates(args, this.byteLength);
    }
  }
  class U32 extends RealU32 {
    constructor(...args: ConstructorParameters<typeof Uint32Array>) {
      super(...(args as [number]));
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
    // Inflate: the total across every part and every read.
    expect(report.inflatedBytes, what).toBeLessThanOrEqual(LIMITS.inflateBytes as number);
    expect(run.inflated, what).toBeLessThanOrEqual((LIMITS.inflateBytes as number) + CHUNK_SLACK);
    // Work.
    expect(report.work, what).toBeLessThanOrEqual(LIMITS.work as number);
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
    expect(run.inflated, file.label).toBeLessThanOrEqual((LIMITS.inflateBytes as number) + CHUNK_SLACK);
    expect(run.outcome, file.label).toBeInstanceOf(PlateMeshError);
    expect((run.outcome as PlateMeshError).problem).toBe("too_large");
  });

  it("a part every level reaches through its own name is read at most twice", async () => {
    const file = hostile("sameNamePath", 5);
    const run = await metered(file.bytes);
    const reads = run.reads.filter((n) => n === "3D/Objects/self.model").length;
    expect(reads, file.label).toBeLessThanOrEqual(2);
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
