// STEP to GLB, so a browser only ever loads a mesh: occt-import-js returns
// three.js-style arrays, and the slicer packs them into one binary glTF 2.0
// file. Ported from the slicing gate's lib/glb.mjs and its tests; gate item
// (h) proved the path on NIST CTC-01.
import { chmodSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { meshesToGlb, type OcctMesh, runStepWorker, type StepWorkerOptions } from "../src/step.js";
import { fakeLandrun, fakePrlimit, fakeStepWorker, stubDir } from "./support/stubs.js";
import { removeTempDirs, tempDir } from "./support/tmp.js";

afterEach(removeTempDirs);

function parse(glb: Buffer) {
  expect(glb.subarray(0, 4).toString("ascii")).toBe("glTF");
  expect(glb.readUInt32LE(4)).toBe(2);
  expect(glb.readUInt32LE(8)).toBe(glb.length);
  const jsonLength = glb.readUInt32LE(12);
  expect(glb.readUInt32LE(16)).toBe(0x4e4f534a);
  const json = JSON.parse(glb.subarray(20, 20 + jsonLength).toString("utf8"));
  const binAt = 20 + jsonLength;
  expect(glb.readUInt32LE(binAt + 4)).toBe(0x004e4942);
  return { json, binLength: glb.readUInt32LE(binAt) };
}

const triangle: OcctMesh = {
  attributes: {
    position: { array: [0, 0, 0, 1, 0, 0, 0, 2, 3] },
    normal: { array: [0, 0, 1, 0, 0, 1, 0, 0, 1] },
  },
  index: { array: [0, 1, 2] },
};

describe("meshesToGlb", () => {
  test("one indexed triangle becomes a valid GLB 2.0 with position min/max", () => {
    const { json, binLength } = parse(meshesToGlb([triangle]));
    expect(json.asset.version).toBe("2.0");
    expect(json.meshes).toHaveLength(1);
    const pos = json.accessors[json.meshes[0].primitives[0].attributes.POSITION];
    expect(pos).toMatchObject({ count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 2, 3] });
    expect(json.accessors[json.meshes[0].primitives[0].indices]).toMatchObject({
      count: 3,
      type: "SCALAR",
    });
    expect(binLength).toBe(json.buffers[0].byteLength);
  });

  test("several meshes, one without normals, share one buffer with 4-byte aligned views", () => {
    const bare: OcctMesh = {
      attributes: { position: { array: [0, 0, 0, 1, 1, 1, 2, 2, 2] } },
      index: { array: [0, 1, 2] },
    };
    const { json } = parse(meshesToGlb([triangle, bare]));
    expect(json.meshes).toHaveLength(2);
    expect(json.meshes[1].primitives[0].attributes.NORMAL).toBeUndefined();
    for (const v of json.bufferViews) expect(v.byteOffset % 4).toBe(0);
    expect(json.scenes[0].nodes).toEqual([0, 1]);
  });

  test("no meshes is an error, not an empty file", () => {
    expect(() => meshesToGlb([])).toThrow(/no meshes/);
  });
});

/**
 * The worker's options as the server passes them, with a fake prlimit and a
 * fake landrun that run the worker in their place (support/stubs.ts).
 */
function options(worker: string, over: Partial<StepWorkerOptions> = {}): StepWorkerOptions {
  const stubs = stubDir();
  return {
    worker,
    timeoutSeconds: 30,
    maxOutputBytes: 1024,
    sandboxed: true,
    prlimitBin: fakePrlimit(stubs).bin,
    landrunBin: fakeLandrun(stubs, { kind: "ok", content: "" }).bin,
    openscadDir: "/opt/openscad",
    orcaDir: "/opt/orca",
    profilesDir: "/opt/platehouse/profiles",
    nodeDir: dirname(dirname(process.execPath)),
    appDir: "/opt/platehouse/app",
    ...over,
  };
}

// The worker's output is always led in with "The converter said: ".
describe("runStepWorker messages", () => {
  const run = (worker: string, over: Partial<StepWorkerOptions> = {}) =>
    runStepWorker(options(worker, over), tempDir("slicer-step-"));

  test("a failed conversion's message from the worker's output starts with the converter lead-in", async () => {
    const r = await run(
      fakeStepWorker(stubDir(), { kind: "fail", stderr: "no shapes in the file" }),
    );
    expect(r).toEqual({ ok: false, message: "The converter said: no shapes in the file" });
  });

  test("a multi-line worker output is one line that starts with the lead-in", async () => {
    const r = await run(
      fakeStepWorker(stubDir(), { kind: "fail", stderr: "first\nsecond\u202e\nthird" }),
    );
    expect(r).toEqual({ ok: false, message: "The converter said: first / second / third" });
  });

  test("the slicer's own sentences carry no lead-in", async () => {
    const big = await run(fakeStepWorker(stubDir(), { kind: "big", bytes: 2048 }));
    expect(big.ok).toBe(false);
    if (!big.ok) {
      expect(big.message).toMatch(/^The converted mesh is 1 MiB, over the 0 MiB limit/);
    }
    const slow = await run(
      fakeStepWorker(stubDir(), { kind: "sleep", pidFile: `${tempDir("slicer-pid-")}/pid` }),
      { timeoutSeconds: 1 },
    );
    expect(slow).toEqual({
      ok: false,
      message: "The conversion took longer than 1 s and was stopped.",
    });
  });
});

// The worker runs untrusted input, so its output is read the way a render's
// is (readRenderOutput in scad.ts): never through a link, never past the cap.
describe("runStepWorker output", () => {
  const MESSAGE_NOT_REGULAR = "The converted mesh was not a regular file, so it was not read.";

  test("an output that is a link is refused unread, wherever it points", async () => {
    const outside = join(tempDir("slicer-outside-"), "secret.txt");
    writeFileSync(outside, "not for the client");
    const worker = fakeStepWorker(stubDir(), { kind: "symlink", target: outside });
    const r = await runStepWorker(options(worker), tempDir("slicer-step-"));
    expect(r).toEqual({ ok: false, message: MESSAGE_NOT_REGULAR });
  });

  test("an output that is a folder is refused unread", async () => {
    const worker = fakeStepWorker(stubDir(), { kind: "folder" });
    const r = await runStepWorker(options(worker), tempDir("slicer-step-"));
    expect(r).toEqual({ ok: false, message: MESSAGE_NOT_REGULAR });
  });

  // prlimit's file-size limit: the kernel sends SIGXFSZ to a program that
  // writes past it. Here a stand-in for prlimit dies of that signal itself.
  test("a worker the file-size limit stopped answers the over-the-limit message", async () => {
    const dir = stubDir();
    const prlimit = join(dir, "prlimit-xfsz");
    writeFileSync(prlimit, "#!/bin/sh\nkill -XFSZ $$\nexit 1\n");
    chmodSync(prlimit, 0o755);
    const worker = fakeStepWorker(dir, { kind: "ok", content: "glTF" });
    const r = await runStepWorker(
      options(worker, { prlimitBin: prlimit }),
      tempDir("slicer-step-"),
    );
    expect(r).toEqual({
      ok: false,
      message:
        "The converted mesh went over the 0 MiB limit for a mesh, so it was stopped while writing it.",
    });
  });

  // Node ignores SIGXFSZ, so under the file-size limit the worker's write
  // fails instead (EFBIG) once the file reaches the limit, and the worker
  // exits 1. The file it leaves is the limit's size.
  test("a worker whose write the file-size limit cut off answers the over-the-limit message", async () => {
    const worker = fakeStepWorker(stubDir(), { kind: "cutOff", bytes: 1024 });
    const r = await runStepWorker(options(worker), tempDir("slicer-step-"));
    expect(r).toEqual({
      ok: false,
      message:
        "The converted mesh went over the 0 MiB limit for a mesh, so it was stopped while writing it.",
    });
  });

  test("a worker that fails with a smaller output still answers with its own words", async () => {
    const worker = fakeStepWorker(stubDir(), { kind: "cutOff", bytes: 10 });
    const r = await runStepWorker(options(worker), tempDir("slicer-step-"));
    expect(r).toEqual({ ok: false, message: "The converter said: EFBIG: file too large, write" });
  });
});
