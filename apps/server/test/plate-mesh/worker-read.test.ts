// Issue #358, review finding #392 and the class behind it: a .3mf is parsed
// for its plate mesh in a worker thread, never on the server's main thread.
// The worker has a heap limit and a wall-clock timeout; past either, or if it
// dies, the plate is too_large and the server goes on. Whatever the worker
// sends back passes the validator on the main thread before it is used.
import { writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Worker } from "node:worker_threads";
import { PlateMeshError, ReadUnavailable } from "@platehouse/threemf";
import { buildSliceable } from "@platehouse/threemf/test/sliceable";
import { beforeAll, describe, expect, test } from "vitest";
import { hostile, wideIndex } from "../../../../packages/threemf/test/support/hostile.js";
import {
  PLATE_MESH_TIMEOUT_MS,
  readPlateMeshInWorker,
  type WorkerReadOptions,
} from "../../src/plate-mesh/worker-read.js";

/** The worker runs the TypeScript source here, as the server does from source in e2e. */
const SOURCE: Partial<WorkerReadOptions> = {
  execArgv: [
    "--conditions=source",
    "--import",
    fileURLToPath(new URL("../support/ts-hooks.ts", import.meta.url)),
  ],
};

let dir: string;
const file = (name: string, bytes: Buffer) => {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "platehouse-worker-read-"));
});

async function verdict(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (err) {
    if (err instanceof PlateMeshError) return err.problem;
    throw err;
  }
  return "mesh";
}

describe("readPlateMeshInWorker", () => {
  test("reads a plate in a worker and hands back a mesh that passed the validator", async () => {
    const path = file("cubes.3mf", buildSliceable({ plates: 2, filaments: 2 }));
    const mesh = await readPlateMeshInWorker(path, 2, SOURCE);
    expect(mesh.plate).toBe(2);
    expect(mesh.instances).toHaveLength(2);
    expect(mesh.pieces[0]?.positions).toBeInstanceOf(Float32Array);
    expect(mesh.pieces[0]?.indices).toBeInstanceOf(Uint32Array);
    expect(mesh.triangles).toBe(24);
  });

  test("gives the worker a timeout of its own by default", () => {
    expect(PLATE_MESH_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
    expect(PLATE_MESH_TIMEOUT_MS).toBeLessThanOrEqual(120_000);
  });

  test("keeps the main thread answering while the worker reads a large file", async () => {
    const path = file("huge.3mf", hostile("hugeMesh", 7).bytes);
    const gaps: number[] = [];
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      gaps.push(now - last);
      last = now;
    }, 10);
    const started = performance.now();
    try {
      await verdict(readPlateMeshInWorker(path, 1, SOURCE));
    } finally {
      clearInterval(timer);
    }
    const took = performance.now() - started;
    // The read takes long enough to mean something, and the timer never waited long.
    expect(took).toBeGreaterThan(200);
    expect(Math.max(...gaps)).toBeLessThan(250);
    expect(gaps.length).toBeGreaterThan(took / 50);
  });

  test("terminates a worker past its timeout, and the plate is too_large", async () => {
    const path = file("slow.3mf", hostile("hugeMesh", 7).bytes);
    let gone: Promise<number> | undefined;
    const started = performance.now();
    const answer = await verdict(
      readPlateMeshInWorker(path, 1, {
        ...SOURCE,
        timeoutMs: 100,
        onSpawn: (w: Worker) => {
          gone = new Promise((resolve) => w.once("exit", resolve));
        },
      }),
    );
    expect(answer).toBe("too_large");
    expect(performance.now() - started).toBeLessThan(3_000);
    // The worker itself is gone, not left running in the background.
    expect(gone).toBeDefined();
    await gone;
  });

  test("a worker past its heap limit is too_large, and the next read still works", async () => {
    const path = file("heap.3mf", hostile("hugeMesh", 7).bytes);
    const answer = await verdict(
      readPlateMeshInWorker(path, 1, {
        ...SOURCE,
        resourceLimits: { maxOldGenerationSizeMb: 8, maxYoungGenerationSizeMb: 2 },
      }),
    );
    expect(answer).toBe("too_large");
    const ok = file("after.3mf", buildSliceable({ plates: 1, filaments: 1 }));
    expect((await readPlateMeshInWorker(ok, 1, SOURCE)).instances).toHaveLength(1);
  });

  test("a worker that dies without answering is too_large", async () => {
    const path = file("any.3mf", buildSliceable({ plates: 1, filaments: 1 }));
    const answer = await verdict(
      readPlateMeshInWorker(path, 1, {
        ...SOURCE,
        url: new URL("./support/crash-worker.ts", import.meta.url),
      }),
    );
    expect(answer).toBe("too_large");
  });

  test("an answer from the worker that fails the validator is no_mesh", async () => {
    const path = file("any2.3mf", buildSliceable({ plates: 1, filaments: 1 }));
    const answer = await verdict(
      readPlateMeshInWorker(path, 1, {
        ...SOURCE,
        url: new URL("./support/bad-worker.ts", import.meta.url),
      }),
    );
    expect(answer).toBe("no_mesh");
  });

  test("the reader's own verdict on the file comes back as it is", async () => {
    const path = file("wide.3mf", wideIndex(2 ** 32, true));
    expect(await verdict(readPlateMeshInWorker(path, 1, SOURCE))).toBe("no_mesh");
  });

  test("a file that cannot be opened is ReadUnavailable, not a verdict", async () => {
    await expect(
      readPlateMeshInWorker(join(dir, "missing.3mf"), 1, SOURCE),
    ).rejects.toBeInstanceOf(ReadUnavailable);
  });
});
