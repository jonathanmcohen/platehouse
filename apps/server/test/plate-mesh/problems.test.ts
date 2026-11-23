// What the plate mesh service remembers about plates it could not make a
// mesh for: a verdict on the file is kept for good; a timeout (PlateMeshBusy)
// is kept against the file, not the plate, and for a short while only.
import { PlateMeshError } from "@platehouse/threemf";
import { describe, expect, test } from "vitest";
import {
  createProblemMemory,
  PLATE_MESH_BUSY_RETRY_MS,
  REMEMBERED_PROBLEMS,
} from "../../src/plate-mesh/problems.js";
import { PlateMeshBusy } from "../../src/plate-mesh/worker-read.js";

function memory(max?: number) {
  const clock = { t: 1_000_000 };
  return { clock, mem: createProblemMemory({ now: () => clock.t, max }) };
}

describe("the problem memory", () => {
  test("its defaults are the documented ones", () => {
    expect(REMEMBERED_PROBLEMS).toBe(1000);
    expect(PLATE_MESH_BUSY_RETRY_MS).toBe(10 * 60_000);
  });

  test("a verdict that is not PlateMeshBusy is remembered for good, for that plate", () => {
    const { clock, mem } = memory();
    mem.remember("p1", "blob-a", new PlateMeshError("no_mesh", "no meshes"));
    expect(mem.lookup("p1", "blob-a")).toBe("no_mesh");
    expect(mem.lookup("p2", "blob-a")).toBeUndefined();
    clock.t += 100 * PLATE_MESH_BUSY_RETRY_MS;
    expect(mem.lookup("p1", "blob-a")).toBe("no_mesh");
  });

  test("a first PlateMeshBusy answers too_large for every plate of that file until the retry time has passed", () => {
    const { clock, mem } = memory();
    mem.remember("p1", "blob-a", new PlateMeshBusy("timed out"));
    expect(mem.lookup("p1", "blob-a")).toBe("too_large");
    expect(mem.lookup("p2", "blob-a")).toBe("too_large");
    expect(mem.lookup("p3", "blob-b")).toBeUndefined();
    clock.t += PLATE_MESH_BUSY_RETRY_MS - 1;
    expect(mem.lookup("p2", "blob-a")).toBe("too_large");
    clock.t += 1;
    expect(mem.lookup("p1", "blob-a")).toBeUndefined();
    expect(mem.lookup("p2", "blob-a")).toBeUndefined();
  });

  test("a second PlateMeshBusy for the same file is remembered for good", () => {
    const { clock, mem } = memory();
    mem.remember("p1", "blob-a", new PlateMeshBusy("timed out"));
    clock.t += PLATE_MESH_BUSY_RETRY_MS;
    expect(mem.lookup("p2", "blob-a")).toBeUndefined();
    mem.remember("p2", "blob-a", new PlateMeshBusy("timed out again"));
    clock.t += 100 * PLATE_MESH_BUSY_RETRY_MS;
    expect(mem.lookup("p1", "blob-a")).toBe("too_large");
    expect(mem.lookup("p9", "blob-a")).toBe("too_large");
  });

  test("a busy verdict remembered twice inside the window stays temporary", () => {
    const { clock, mem } = memory();
    mem.remember("p1", "blob-a", new PlateMeshBusy("timed out"));
    clock.t += 1000;
    mem.remember("p2", "blob-a", new PlateMeshBusy("timed out too"));
    clock.t += PLATE_MESH_BUSY_RETRY_MS;
    expect(mem.lookup("p1", "blob-a")).toBeUndefined();
  });

  test("a busy verdict for one file does not answer for the same plate once its file is another", () => {
    const { mem } = memory();
    mem.remember("p1", "blob-a", new PlateMeshBusy("timed out"));
    expect(mem.lookup("p1", "blob-a")).toBe("too_large");
    expect(mem.lookup("p1", "blob-b")).toBeUndefined();
  });

  test("past max entries, the oldest is forgotten first", () => {
    const { mem } = memory(2);
    mem.remember("p1", "blob-a", new PlateMeshError("no_mesh", "x"));
    mem.remember("p2", "blob-a", new PlateMeshError("no_mesh", "x"));
    mem.remember("p3", "blob-b", new PlateMeshBusy("timed out"));
    expect(mem.lookup("p1", "blob-a")).toBeUndefined();
    expect(mem.lookup("p2", "blob-a")).toBe("no_mesh");
    expect(mem.lookup("p3", "blob-b")).toBe("too_large");
    mem.remember("p4", "blob-a", new PlateMeshError("no_mesh", "x"));
    expect(mem.lookup("p2", "blob-a")).toBeUndefined();
    expect(mem.lookup("p3", "blob-b")).toBe("too_large");
  });
});
