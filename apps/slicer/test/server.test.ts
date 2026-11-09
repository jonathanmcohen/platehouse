// The slicer server (build plan Task 11) against stub programs: contract v1
// over HTTP, one heavy job (slice, render or STEP conversion) at a time with
// 409 busy for the rest, the kill at SLICE_TIMEOUT_SECONDS, the body limits,
// the request timeouts and the Orca arguments of the T1 recipe.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIMITS, slicerContract } from "@platehouse/slicer-contract";
import { buildSliceable } from "@platehouse/threemf/test/sliceable";
import { afterEach, describe, expect, test, vi } from "vitest";
import { buildProfiles, loadIndex } from "../src/profiles.js";
import { createSlicer, loadConfig, type Slicer, type SlicerConfig } from "../src/server.js";
import { streamChunked } from "./support/http.js";
import { profileTree, put, TREE_PRINTERS } from "./support/profiles.js";
import {
  fakeLandrun,
  fakeOrca,
  fakeStepWorker,
  fakeTime,
  type OrcaMode,
  stubDir,
} from "./support/stubs.js";

// node:fs as it is, except that a test can make rmSync fail for the paths it
// names, the way a recursive delete fails with ENOTEMPTY or EBUSY on a folder
// a killed program is still writing to. Every rmSync call is recorded with
// its options. A test can also set the free space statfsSync reports for a
// path, so /work can be made to fill up and empty again.
const rmFails = vi.hoisted(() => ({
  under: null as string | null,
  calls: [] as { path: string; options: unknown }[],
}));
const workSpace = vi.hoisted(() => ({
  free: null as ((path: string) => number) | null,
}));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const rmSync: typeof fs.rmSync = (path, options) => {
    rmFails.calls.push({ path: String(path), options });
    if (rmFails.under !== null && String(path).startsWith(rmFails.under)) {
      throw Object.assign(new Error(`ENOTEMPTY: directory not empty, rmdir '${String(path)}'`), {
        code: "ENOTEMPTY",
      });
    }
    return fs.rmSync(path, options);
  };
  const statfsSync = ((path: import("node:fs").PathLike, options?: unknown) => {
    const real = fs.statfsSync(path, options as never);
    if (workSpace.free === null) return real;
    return { ...real, bavail: workSpace.free(String(path)), bsize: 1 };
  }) as typeof fs.statfsSync;
  return {
    ...fs,
    default: { ...fs, rmSync, statfsSync },
    rmSync,
    statfsSync,
  };
});

const P1S = "Bambu Lab P1S 0.4 nozzle";
const A1 = "Bambu Lab A1 0.4 nozzle";
const P1S_PLA = "Bambu PLA Basic @BBL P1S 0.4 nozzle";
const running: Slicer[] = [];

afterEach(async () => {
  rmFails.under = null;
  rmFails.calls = [];
  workSpace.free = null;
  while (running.length) await running.pop()?.close();
});

function setup(
  over: Partial<SlicerConfig> = {},
  orca: OrcaMode = { kind: "ok", time: 1, weight: 1, grams: [1] },
  tree: string = profileTree(),
) {
  const stubs = stubDir();
  const profilesDir = mkdtempSync(join(tmpdir(), "slicer-profiles-"));
  buildProfiles(loadIndex(tree), profilesDir);
  const workDir = mkdtempSync(join(tmpdir(), "slicer-work-"));
  const fake = fakeOrca(stubs, orca);
  const sandboxProbe = join(stubs, "sandbox-probe.stl");
  writeFileSync(sandboxProbe, "solid probe\nendsolid probe\n");
  const config: SlicerConfig = {
    port: 0,
    workDir,
    profilesDir,
    orcaBin: fake.bin,
    timeBin: fakeTime(stubs),
    openscadBin: "/opt/openscad/AppRun",
    openscadDir: "/opt/openscad",
    landrunBin: fakeLandrun(stubs, { kind: "ok", content: "solid x" }).bin,
    sandboxProbe,
    stepWorker: fakeStepWorker(stubs, { kind: "ok", content: "glTF" }),
    slicePlateSeconds: 120,
    sliceTimeoutSeconds: 30,
    scadTimeoutSeconds: 30,
    stepTimeoutSeconds: 30,
    orcaVersion: "2.5.0",
    openscadVersion: "2026.11-RC0",
    // The test machine's disk always has a mebibyte free; the floor's own
    // tests set it high.
    workMinFreeBytes: 1024 * 1024,
    limits: LIMITS,
    ...over,
  };
  return { config, stubs, fake, workDir };
}

async function start(config: SlicerConfig): Promise<string> {
  const slicer = createSlicer(config);
  running.push(slicer);
  await new Promise<void>((resolve) => slicer.server.listen(0, "127.0.0.1", resolve));
  const { port } = slicer.server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

const sliceUrl = (base: string, printer: string, plate: string | number) =>
  `${base}/v1/slice?printer=${encodeURIComponent(printer)}&plate=${plate}`;

async function postSlice(
  base: string,
  body: Buffer | string,
  printer = P1S,
  plate: string | number = 1,
) {
  return fetch(sliceUrl(base, printer, plate), {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body,
  });
}

const sliceable = () => buildSliceable({ plates: 2, filaments: 2 });

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Waits until `file` exists and is not empty. */
async function waitForFile(file: string): Promise<void> {
  await waitFor(() => {
    try {
      return readFileSync(file, "utf8").length > 0;
    } catch {
      return false;
    }
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A raw request that sends headers only, to test refusals before the body. */
function headersOnly(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "POST", headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        body += c;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.flushHeaders();
  });
}

describe("configuration", () => {
  // The image sets both versions from its build arguments; health reports
  // them and the app re-estimates when Orca's changes (AC-036).
  const VERSIONS = { ORCA_VERSION: "2.5.0", OPENSCAD_VERSION: "2026.11-RC0" };

  test("SLICE_PLATE_SECONDS defaults to the gate's 120 and the kill to that plus 60", () => {
    const c = loadConfig(VERSIONS);
    expect(c.slicePlateSeconds).toBe(120);
    expect(c.sliceTimeoutSeconds).toBe(180);
    expect(c.port).toBe(8080);
    expect(c.workDir).toBe("/work");
    expect(c.orcaVersion).toBe("2.5.0");
    expect(loadConfig({ ...VERSIONS, SLICE_PLATE_SECONDS: "200" }).sliceTimeoutSeconds).toBe(260);
    expect(
      loadConfig({ ...VERSIONS, SLICE_PLATE_SECONDS: "200", SLICE_TIMEOUT_SECONDS: "500" })
        .sliceTimeoutSeconds,
    ).toBe(500);
  });

  test("a bad number names the key", () => {
    expect(() => loadConfig({ ...VERSIONS, SLICE_PLATE_SECONDS: "soon" })).toThrow(
      /SLICE_PLATE_SECONDS/,
    );
    expect(() => loadConfig({ ...VERSIONS, PORT: "-1" })).toThrow(/PORT/);
  });

  test("a missing version fails at start, naming the key", () => {
    expect(() => loadConfig({ OPENSCAD_VERSION: "2026.11-RC0" })).toThrow(/ORCA_VERSION/);
    expect(() => loadConfig({ ORCA_VERSION: "2.5.0" })).toThrow(/OPENSCAD_VERSION/);
  });
});

describe("health and profiles", () => {
  test("health reports the contract, the versions and busy false", async () => {
    const base = await start(setup().config);
    const res = await fetch(`${base}/v1/health`);
    expect(res.status).toBe(200);
    expect(slicerContract.health.parse(await res.json())).toEqual({
      contract: 1,
      orca: "2.5.0",
      openscad: "2026.11-RC0",
      busy: false,
    });
  });

  test("profiles lists every BBL nozzle machine and nothing else", async () => {
    const base = await start(setup().config);
    const res = await fetch(`${base}/v1/profiles`);
    expect(res.status).toBe(200);
    const body = slicerContract.profiles.parse(await res.json());
    expect(body.printers.map((p) => p.id)).toEqual(TREE_PRINTERS);
    expect(body.printers).toContainEqual({
      id: P1S,
      model: "Bambu Lab P1S",
      modelId: "C12",
      nozzle: 0.4,
    });
    expect(body.filaments).toContainEqual({
      printer: P1S,
      type: "PLA",
      profile: "Bambu PLA Basic @BBL P1S 0.4 nozzle",
      source: "bambu",
    });
    expect(body.filaments).toContainEqual({
      printer: A1,
      type: "PLA",
      profile: "Generic PLA @BBL A1",
      source: "generic",
    });
    for (const f of body.filaments) expect(TREE_PRINTERS, JSON.stringify(f)).toContain(f.printer);
  });

  test("an unknown path is 404 not_found", async () => {
    const base = await start(setup().config);
    const res = await fetch(`${base}/v2/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});

describe("slicing", () => {
  test("an ok slice returns Orca's numbers with the file's filaments, then clears its work folder", async () => {
    const s = setup({}, { kind: "ok", time: 1234.5, weight: 12.3456, grams: [6.1, 6.2456] });
    const base = await start(s.config);
    const res = await postSlice(base, sliceable(), P1S, 2);
    expect(res.status).toBe(200);
    const body = slicerContract.sliceResult.parse(await res.json());
    expect(body).toMatchObject({
      contract: 1,
      orca: "2.5.0",
      plate: 2,
      status: "ok",
      printer: P1S,
      process: "0.20mm Standard @BBL X1C",
      filamentProfiles: [P1S_PLA, P1S_PLA],
      timeSeconds: 1234.5,
      weightGrams: 12.3456,
      filaments: [
        {
          slot: 1,
          type: "PLA",
          color: "#FFFFFF",
          grams: 6.1,
          profile: P1S_PLA,
          profileSource: "bambu",
        },
        {
          slot: 2,
          type: "PLA",
          color: "#1F1F1F",
          grams: 6.2456,
          profile: P1S_PLA,
          profileSource: "bambu",
        },
      ],
      peakRssBytes: 2048 * 1024,
    });
    expect(readdirSync(s.workDir)).toEqual([]);
  });

  test("a printer with no Bambu preset for the type loads the generic one and reports it", async () => {
    const s = setup({}, { kind: "ok", time: 10, weight: 2, grams: [1, 1] });
    const base = await start(s.config);
    const body = slicerContract.sliceResult.parse(
      await (await postSlice(base, sliceable(), A1, 1)).json(),
    );
    expect(body).toMatchObject({
      status: "ok",
      printer: A1,
      filamentProfiles: ["Generic PLA @BBL A1", "Generic PLA @BBL A1"],
      filaments: [
        { slot: 1, profile: "Generic PLA @BBL A1", profileSource: "generic" },
        { slot: 2, profile: "Generic PLA @BBL A1", profileSource: "generic" },
      ],
    });
    const args = readFileSync(s.fake.argsLog, "utf8").trimEnd().split("\n");
    const loaded = (args[args.indexOf("--load-filaments") + 1] ?? "").split(";");
    expect(loaded.map((f) => JSON.parse(readFileSync(f, "utf8")).name)).toEqual([
      "Generic PLA @BBL A1",
      "Generic PLA @BBL A1",
    ]);
  });

  test("with neither a Bambu nor a generic preset the file keeps its own filament and says so", async () => {
    const tree = profileTree();
    // No PLA preset of any kind is compatible with the A1 in this tree.
    put(tree, "BBL/filament/A1/Generic PLA @BBL A1.json", {
      type: "filament",
      name: "Generic PLA @BBL A1",
      inherits: "Generic PLA @base",
      from: "system",
      instantiation: "true",
      compatible_printers: [],
    });
    put(tree, "BBL/filament/Generic PLA Silk.json", {
      type: "filament",
      name: "Generic PLA Silk",
      inherits: "Generic PLA @base",
      from: "system",
      instantiation: "true",
      compatible_printers: [P1S],
    });
    const s = setup({}, { kind: "ok", time: 10, weight: 2, grams: [1, 1] }, tree);
    const base = await start(s.config);
    const body = slicerContract.sliceResult.parse(
      await (await postSlice(base, sliceable(), A1, 1)).json(),
    );
    expect(body).toMatchObject({
      status: "ok",
      filamentProfiles: [null, null],
      filaments: [
        { slot: 1, profile: null, profileSource: "file" },
        { slot: 2, profile: null, profileSource: "file" },
      ],
    });
    const args = readFileSync(s.fake.argsLog, "utf8").trimEnd().split("\n");
    expect(args).not.toContain("--load-filaments");
  });

  test("Orca gets the T1 recipe: one plate, statistics, --mstpp, the machine preset alone and the printer's default filament per slot", async () => {
    const s = setup({ slicePlateSeconds: 95 });
    const base = await start(s.config);
    await postSlice(base, sliceable(), P1S, 2);
    const args = readFileSync(s.fake.argsLog, "utf8").trimEnd().split("\n");
    const after = (flag: string) => args[args.indexOf(flag) + 1] ?? "";
    expect(after("--slice")).toBe("2");
    expect(after("--mstpp")).toBe("95");
    expect(args).toContain("--export-statistics");
    expect(args).toContain("--allow-newer-file");
    const settings = after("--load-settings");
    expect(settings).not.toContain(";");
    expect(JSON.parse(readFileSync(settings, "utf8")).name).toBe(P1S);
    const filaments = after("--load-filaments").split(";");
    expect(filaments).toHaveLength(2);
    for (const f of filaments) expect(JSON.parse(readFileSync(f, "utf8")).name).toBe(P1S_PLA);
    expect(after("--outputdir").startsWith(s.workDir)).toBe(true);
    expect(after("--datadir").startsWith(s.workDir)).toBe(true);
    expect(args.at(-1)?.startsWith(s.workDir)).toBe(true);
    expect(args.at(-1)?.endsWith(".3mf")).toBe(true);
  });

  test("a refusal reports Orca's code, the mapped reason and Orca's message", async () => {
    const msg = "The selected printer is not compatible with the process preset in the 3mf.";
    const base = await start(setup({}, { kind: "result", code: -17, error: msg }).config);
    const body = slicerContract.sliceResult.parse(
      await (await postSlice(base, sliceable())).json(),
    );
    expect(body).toEqual({
      contract: 1,
      orca: "2.5.0",
      plate: 1,
      status: "failed",
      code: -17,
      reason: "process_not_compatible",
      detail: msg,
    });
  });

  test("-101 and -62 are refusals with their own reasons; an empty error string falls back to Orca's message", async () => {
    let base = await start(setup({}, { kind: "result", code: -101, error: "" }).config);
    let body = slicerContract.sliceResult.parse(await (await postSlice(base, sliceable())).json());
    expect(body).toMatchObject({
      status: "failed",
      code: -101,
      reason: "toolpath_conflict",
      detail: "G-code path conflicts",
    });
    base = await start(setup({}, { kind: "result", code: -62, error: "temps" }).config);
    body = slicerContract.sliceResult.parse(await (await postSlice(base, sliceable())).json());
    expect(body).toMatchObject({ status: "failed", code: -62, reason: "filament_temperature" });
  });

  test("Orca's own -58 is a timeout", async () => {
    const base = await start(setup({}, { kind: "result", code: -58, error: "too slow" }).config);
    const body = slicerContract.sliceResult.parse(
      await (await postSlice(base, sliceable())).json(),
    );
    expect(body).toMatchObject({ status: "failed", code: -58, reason: "timeout" });
  });

  test("the detail is cut at 2000 characters", async () => {
    const base = await start(
      setup({}, { kind: "result", code: -100, error: "e".repeat(5000) }).config,
    );
    const body = slicerContract.sliceResult.parse(
      await (await postSlice(base, sliceable())).json(),
    );
    expect(body.status === "failed" && body.detail.length).toBe(2000);
  });

  test("a crash with no result.json is slicer_error with no code", async () => {
    const base = await start(setup({}, { kind: "crash", exit: 139 }).config);
    const body = slicerContract.sliceResult.parse(
      await (await postSlice(base, sliceable())).json(),
    );
    expect(body).toMatchObject({ status: "failed", code: null, reason: "slicer_error" });
    expect(body.status === "failed" && body.detail).toMatch(/139/);
  });

  test("success without statistics is slicer_error, never an ok without numbers", async () => {
    const base = await start(setup({}, { kind: "noStats" }).config);
    const body = slicerContract.sliceResult.parse(
      await (await postSlice(base, sliceable())).json(),
    );
    expect(body).toMatchObject({ status: "failed", code: 0, reason: "slicer_error" });
  });

  test("second concurrent slice is 409", async () => {
    const s = setup({ sliceTimeoutSeconds: 3 }, { kind: "sleep" });
    const base = await start(s.config);
    const first = postSlice(base, sliceable());
    await waitFor(() => {
      try {
        return readFileSync(s.fake.pids, "utf8").length > 0;
      } catch {
        return false;
      }
    });
    const health = slicerContract.health.parse(await (await fetch(`${base}/v1/health`)).json());
    expect(health.busy).toBe(true);
    const second = await postSlice(base, sliceable());
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "busy" });
    expect((await first).status).toBe(200);
    const after = slicerContract.health.parse(await (await fetch(`${base}/v1/health`)).json());
    expect(after.busy).toBe(false);
  });

  test("a plate over SLICE_TIMEOUT_SECONDS is killed with its whole process group and answered timeout", async () => {
    const s = setup({ sliceTimeoutSeconds: 1 }, { kind: "sleep" });
    const base = await start(s.config);
    const started = Date.now();
    const res = await postSlice(base, sliceable());
    const body = slicerContract.sliceResult.parse(await res.json());
    expect(body).toMatchObject({ status: "failed", code: null, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(10_000);
    const [shell, child] = readFileSync(s.fake.pids, "utf8").trim().split(" ").map(Number);
    await waitFor(() => !alive(shell as number) && !alive(child as number));
    expect(readdirSync(s.workDir)).toEqual([]);
  });

  test("a body that is not a zip is 422 not_3mf and Orca never runs", async () => {
    const s = setup();
    const base = await start(s.config);
    const res = await postSlice(base, "solid cube\nendsolid cube\n");
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "not_3mf" });
    expect(() => readFileSync(s.fake.argsLog)).toThrow();
  });

  test("a zip with no Bambu plate data is 422 not_3mf", async () => {
    const zip = Buffer.from("504b0506000000000000000000000000000000000000", "hex");
    const base = await start(setup().config);
    const res = await postSlice(base, zip);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "not_3mf" });
  });

  test("a Content-Length over 512 MiB is 413 before any body is read", async () => {
    const base = await start(setup().config);
    const res = await headersOnly(sliceUrl(base, P1S, 1), {
      "content-type": "application/octet-stream",
      "content-length": String(LIMITS.sliceBodyBytes + 1),
    });
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body)).toEqual({ error: "too_large" });
  });

  // fetch sends a Buffer body with its Content-Length, so this one is refused
  // before the body is read. A chunked body with no Content-Length is tested
  // under "a failed request never takes the server down".
  test("a body whose Content-Length is past the limit is 413 and leaves nothing behind", async () => {
    const s = setup({ limits: { ...LIMITS, sliceBodyBytes: 1000 } });
    const base = await start(s.config);
    const res = await postSlice(base, Buffer.alloc(5000, 1));
    expect(res.status).toBe(413);
    expect(readdirSync(s.workDir)).toEqual([]);
  });

  test.each([
    ["plate 0", P1S, "0"],
    ["plate 129", P1S, "129"],
    ["no plate", P1S, ""],
    ["an unknown printer", "Bambu Lab Q9 0.4 nozzle", "1"],
    ["a non-menu printer", "Bambu Lab Retired 0.4 nozzle", "1"],
  ])("%s is 400 bad_request", async (_label, printer, plate) => {
    const base = await start(setup().config);
    const res = await postSlice(base, sliceable(), printer, plate);
    expect(res.status).toBe(400);
    expect(slicerContract.error.parse(await res.json()).error).toBe("bad_request");
  });
});

// landrun runs best effort (see sandbox.test.ts), so the server proves the
// sandbox works before it renders: it renders a .scad that imports a file
// outside the job folder, through the same landrun, and passes the check only
// when OpenSCAD reports it cannot open that file. Only a pass is remembered.
// Anything else (the import works, the probe file is missing, or the render
// fails for another reason such as a timeout) refuses that render, and the
// next render runs the check again.
describe("sandbox self-test", () => {
  const lines = (file: string) => readFileSync(file, "utf8").trim().split("\n").length;
  const render = (base: string, kind = "stl") =>
    fetch(`${base}/v1/scad/${kind}`, { method: "POST", body: "cube(10);" });

  test("renders run once the self-test has seen the sandbox block a read outside the job folder", async () => {
    const s = setup();
    const lr = fakeLandrun(s.stubs, { kind: "ok", content: "solid ok" });
    const base = await start({ ...s.config, landrunBin: lr.bin });
    for (let i = 0; i < 2; i++) {
      const res = await render(base);
      expect(res.status).toBe(200);
    }
    // one self-test, then the two renders
    expect(lines(lr.runsLog)).toBe(3);
    expect(readdirSync(s.workDir)).toEqual([]);
  });

  test("when the sandbox lets OpenSCAD read outside its folder, every render is refused", async () => {
    const s = setup();
    const lr = fakeLandrun(s.stubs, { kind: "ok", content: "solid ok" }, { probe: "read" });
    const base = await start({ ...s.config, landrunBin: lr.bin });
    for (const kind of ["stl", "png"]) {
      const res = await render(base, kind);
      expect(res.status).toBe(422);
      expect(slicerContract.renderError.parse(await res.json()).message).toMatch(/sandbox/i);
    }
    // the self-test ran before each request and no render ran
    expect(lines(lr.runsLog)).toBe(2);
    expect(() => readFileSync(lr.argsLog)).toThrow();
  });

  test("a self-test render that fails for another reason refuses that render, and the next one checks again", async () => {
    const s = setup();
    const lr = fakeLandrun(s.stubs, { kind: "ok", content: "solid ok" }, { probe: "other" });
    const base = await start({ ...s.config, landrunBin: lr.bin });
    let res = await render(base);
    expect(res.status).toBe(422);
    expect(slicerContract.renderError.parse(await res.json()).message).toMatch(/sandbox/i);
    expect(lines(lr.runsLog)).toBe(1);

    lr.setProbe("blocked");
    res = await render(base);
    expect(res.status).toBe(200);
    // a second self-test, which passed, then the render
    expect(lines(lr.runsLog)).toBe(3);

    // the pass is remembered: no third self-test
    lr.setProbe("read");
    res = await render(base);
    expect(res.status).toBe(200);
    expect(lines(lr.runsLog)).toBe(4);
  });

  test("a self-test render that times out proves nothing and is checked again", async () => {
    const s = setup({ scadTimeoutSeconds: 1 });
    const lr = fakeLandrun(s.stubs, { kind: "ok", content: "solid ok" }, { probe: "hang" });
    const base = await start({ ...s.config, landrunBin: lr.bin });
    let res = await render(base);
    expect(res.status).toBe(422);
    expect(slicerContract.renderError.parse(await res.json()).message).toMatch(/sandbox/i);

    lr.setProbe("blocked");
    res = await render(base);
    expect(res.status).toBe(200);
    expect(lines(lr.runsLog)).toBe(3);
    expect(readdirSync(s.workDir)).toEqual([]);
  });

  test("a missing probe file refuses every render, since the self-test would prove nothing", async () => {
    const s = setup();
    const lr = fakeLandrun(s.stubs, { kind: "ok", content: "solid ok" });
    const base = await start({
      ...s.config,
      landrunBin: lr.bin,
      sandboxProbe: join(s.stubs, "no-such-probe.stl"),
    });
    const res = await render(base);
    expect(res.status).toBe(422);
    expect(slicerContract.renderError.parse(await res.json()).message).toMatch(/sandbox/i);
  });

  test("SANDBOX_PROBE defaults to the file the image ships", () => {
    const c = loadConfig({ ORCA_VERSION: "2.5.0", OPENSCAD_VERSION: "2026.11-RC0" });
    expect(c.sandboxProbe).toBe("/opt/platehouse/sandbox-probe.stl");
  });
});

describe("OpenSCAD and STEP", () => {
  test("scad/stl runs OpenSCAD through landrun and returns the STL", async () => {
    const s = setup();
    const lr = fakeLandrun(s.stubs, { kind: "ok", content: "solid ok" });
    const base = await start({ ...s.config, landrunBin: lr.bin });
    const res = await fetch(`${base}/v1/scad/stl`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "cube(10);",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("model/stl");
    expect(await res.text()).toBe("solid ok");
    const args = readFileSync(lr.argsLog, "utf8").trimEnd().split("\n");
    const at = args.indexOf("--");
    expect(args.slice(at + 1, at + 3)).toEqual(["/opt/openscad/AppRun", "--backend=manifold"]);
    expect(readdirSync(s.workDir)).toEqual([]);
  });

  test("scad/png returns image/png", async () => {
    const s = setup();
    const lr = fakeLandrun(s.stubs, { kind: "ok", content: "PNG" });
    const base = await start({ ...s.config, landrunBin: lr.bin });
    const res = await fetch(`${base}/v1/scad/png`, { method: "POST", body: "cube(10);" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  test("a render error is 422 render_failed with OpenSCAD's own message", async () => {
    const s = setup();
    const lr = fakeLandrun(s.stubs, {
      kind: "fail",
      stderr: "ERROR: Parser error in file input.scad, line 1",
    });
    const base = await start({ ...s.config, landrunBin: lr.bin });
    const res = await fetch(`${base}/v1/scad/stl`, { method: "POST", body: "cube(" });
    expect(res.status).toBe(422);
    const body = slicerContract.renderError.parse(await res.json());
    expect(body.message).toContain("Parser error");
  });

  test("a .scad over 1 MiB is 413", async () => {
    const base = await start(setup().config);
    const res = await headersOnly(`${base}/v1/scad/stl`, {
      "content-type": "text/plain",
      "content-length": String(LIMITS.scadBodyBytes + 1),
    });
    expect(res.status).toBe(413);
  });

  test("step/glb returns the worker's GLB, and a worker failure is 422 convert_failed", async () => {
    const s = setup();
    let base = await start(s.config);
    let res = await fetch(`${base}/v1/step/glb`, { method: "POST", body: "ISO-10303-21;" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("model/gltf-binary");
    expect(await res.text()).toBe("glTF");
    const failing = fakeStepWorker(stubDir(), { kind: "fail", stderr: "no shapes in the file" });
    base = await start({ ...s.config, stepWorker: failing });
    res = await fetch(`${base}/v1/step/glb`, { method: "POST", body: "ISO-10303-21;" });
    expect(res.status).toBe(422);
    expect(slicerContract.convertError.parse(await res.json()).message).toContain("no shapes");
  });

  test("the STEP body reaches the worker byte for byte", async () => {
    const s = setup({ stepWorker: fakeStepWorker(stubDir(), { kind: "echo" }) });
    const base = await start(s.config);
    const body = Buffer.alloc(3 * 1024 * 1024);
    for (let i = 0; i < body.length; i++) body[i] = (i * 31 + 7) % 256;
    const res = await fetch(`${base}/v1/step/glb`, { method: "POST", body });
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(body)).toBe(true);
    expect(readdirSync(s.workDir)).toEqual([]);
  });

  test("a second STEP conversion while one runs is 409 busy at once, and only one worker runs", async () => {
    const stubs = stubDir();
    const log = join(stubs, "step.log");
    const s = setup({ stepWorker: fakeStepWorker(stubs, { kind: "slow", log, ms: 1500 }) });
    const base = await start(s.config);
    const post = () => fetch(`${base}/v1/step/glb`, { method: "POST", body: "ISO-10303-21;" });
    const first = post();
    await waitForFile(log);
    const second = await post();
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "busy" });
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["start"]);
    expect((await first).status).toBe(200);
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["start", "end"]);
    expect(readdirSync(s.workDir)).toEqual([]);
  });

  test("a STEP file over 256 MiB is 413", async () => {
    const base = await start(setup().config);
    const res = await headersOnly(`${base}/v1/step/glb`, {
      "content-type": "application/octet-stream",
      "content-length": String(LIMITS.stepBodyBytes + 1),
    });
    expect(res.status).toBe(413);
  });
});

// The container runs one heavy job at a time: a slice, an OpenSCAD render
// (with its sandbox self-test) or a STEP conversion. Its 4g memory limit is
// sized from a single slice. A request for any of them while one runs gets
// 409 busy at once, before its body is read, so no socket is held waiting.
describe("one heavy job at a time", () => {
  const step = (base: string) =>
    fetch(`${base}/v1/step/glb`, { method: "POST", body: "ISO-10303-21;" });
  const scad = (base: string, kind: "stl" | "png") =>
    fetch(`${base}/v1/scad/${kind}`, { method: "POST", body: "cube(10);" });

  async function expectBusy(res: Response): Promise<void> {
    expect(res.status).toBe(409);
    expect(slicerContract.error.parse(await res.json())).toEqual({ error: "busy" });
  }

  test("STEP and both OpenSCAD routes are 409 busy while a slice runs", async () => {
    const s = setup({ sliceTimeoutSeconds: 3 }, { kind: "sleep" });
    const lr = fakeLandrun(s.stubs, { kind: "ok", content: "solid ok" });
    const base = await start({ ...s.config, landrunBin: lr.bin });
    const first = postSlice(base, sliceable());
    await waitForFile(s.fake.pids);
    await expectBusy(await step(base));
    await expectBusy(await scad(base, "stl"));
    await expectBusy(await scad(base, "png"));
    // no render or self-test ran
    expect(() => readFileSync(lr.runsLog)).toThrow();
    expect((await first).status).toBe(200);
    // and once the slice is done, a render runs again
    expect((await scad(base, "stl")).status).toBe(200);
  });

  test("a slice, a render and a second STEP are 409 busy while a STEP conversion runs", async () => {
    const stubs = stubDir();
    const log = join(stubs, "step.log");
    const s = setup({ stepWorker: fakeStepWorker(stubs, { kind: "slow", log, ms: 1500 }) });
    const base = await start(s.config);
    const first = step(base);
    await waitForFile(log);
    const health = slicerContract.health.parse(await (await fetch(`${base}/v1/health`)).json());
    expect(health.busy).toBe(true);
    await expectBusy(await postSlice(base, sliceable()));
    await expectBusy(await scad(base, "stl"));
    await expectBusy(await step(base));
    expect(() => readFileSync(s.fake.argsLog)).toThrow();
    expect((await first).status).toBe(200);
    const after = slicerContract.health.parse(await (await fetch(`${base}/v1/health`)).json());
    expect(after.busy).toBe(false);
  });

  test("a slice, a STEP and a second render are 409 busy while a render runs", async () => {
    const s = setup({ scadTimeoutSeconds: 2 });
    // The self-test hangs until the cap, so the first render holds the lock.
    const lr = fakeLandrun(s.stubs, { kind: "ok", content: "solid ok" }, { probe: "hang" });
    const base = await start({ ...s.config, landrunBin: lr.bin });
    const first = scad(base, "stl");
    await waitForFile(lr.runsLog);
    await expectBusy(await postSlice(base, sliceable()));
    await expectBusy(await step(base));
    await expectBusy(await scad(base, "png"));
    expect(() => readFileSync(s.fake.argsLog)).toThrow();
    expect((await first).status).toBe(422);
    expect(readFileSync(lr.runsLog, "utf8").trim().split("\n")).toHaveLength(1);
    expect(readdirSync(s.workDir)).toEqual([]);
  });

  test("a busy answer comes at once, while the running job still runs", async () => {
    const stubs = stubDir();
    const log = join(stubs, "step.log");
    const s = setup({ stepWorker: fakeStepWorker(stubs, { kind: "slow", log, ms: 2000 }) });
    const base = await start(s.config);
    const first = step(base);
    await waitForFile(log);
    const asked = Date.now();
    await expectBusy(await step(base));
    expect(Date.now() - asked).toBeLessThan(1000);
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["start"]);
    await first;
  });

  // A refusal closes the connection while the client may still be sending a
  // large body. Closed with unread bytes in its receive queue, a socket is
  // reset, and the reset can throw away the answer before the client reads
  // it, so the server lingers: it half-closes, drains what still arrives and
  // drops the socket only once the client has gone or the drain time is up.
  // Sent chunked, a 64 MiB body is 409 on every route. Sent by fetch with its
  // Content-Length, it is 413 on the OpenSCAD routes (over their 1 MiB) and
  // 409 on the others; either way the answer arrives.
  const BIG = 64 * 1024 * 1024;
  test.each([
    ["slice", (base: string) => sliceUrl(base, P1S, 1), 409],
    ["scad/stl", (base: string) => `${base}/v1/scad/stl`, 413],
    ["scad/png", (base: string) => `${base}/v1/scad/png`, 413],
    ["step/glb", (base: string) => `${base}/v1/step/glb`, 409],
  ] as const)(
    "%s: a large body sent while busy still gets its answer, not a reset",
    async (_route, url, declared) => {
      const s = setup({ sliceTimeoutSeconds: 3 }, { kind: "sleep" });
      const base = await start(s.config);
      const first = postSlice(base, sliceable());
      await waitForFile(s.fake.pids);
      const res = await streamChunked(url(base), BIG, { chunk: 1024 * 1024 });
      expect(res).toEqual({ status: 409, body: JSON.stringify({ error: "busy" }) });
      const fetched = await fetch(url(base), { method: "POST", body: Buffer.alloc(BIG, 1) });
      expect(fetched.status).toBe(declared);
      expect(await fetched.json()).toEqual({ error: declared === 409 ? "busy" : "too_large" });
      expect((await first).status).toBe(200);
    },
  );

  test("an oversized body is still 413 while busy, not 409", async () => {
    const s = setup({ sliceTimeoutSeconds: 3 }, { kind: "sleep" });
    const base = await start(s.config);
    const first = postSlice(base, sliceable());
    await waitForFile(s.fake.pids);
    const res = await headersOnly(`${base}/v1/step/glb`, {
      "content-type": "application/octet-stream",
      "content-length": String(LIMITS.stepBodyBytes + 1),
    });
    expect(res.status).toBe(413);
    await first;
  });
});

// Node's default requestTimeout (300 s) counts from the first byte of a
// request until its whole body has arrived, and answers 408 past it. The
// largest legitimate body is a 512 MiB .3mf, so the server sets its own
// limits: long enough for that body at 1 MiB/s plus the longest time cap,
// and never off (0 would let a stalled client hold a socket forever).
describe("request timeouts", () => {
  const MIB = 1024 * 1024;
  const longestUploadSeconds = LIMITS.sliceBodyBytes / MIB; // 512 MiB at 1 MiB/s

  async function serverOf(over: Partial<SlicerConfig>) {
    const slicer = createSlicer(setup(over).config);
    running.push(slicer);
    await new Promise<void>((resolve) => slicer.server.listen(0, "127.0.0.1", resolve));
    return slicer.server;
  }

  test("a large body upload is not cut off before its cap", async () => {
    const server = await serverOf({
      sliceTimeoutSeconds: 180,
      scadTimeoutSeconds: 120,
      stepTimeoutSeconds: 120,
    });
    expect(server.requestTimeout).toBeGreaterThan(300_000);
    expect(server.requestTimeout).toBeGreaterThanOrEqual((longestUploadSeconds + 180) * 1000);
  });

  test("the request timeout grows with the longest time cap", async () => {
    const server = await serverOf({
      sliceTimeoutSeconds: 30,
      scadTimeoutSeconds: 30,
      stepTimeoutSeconds: 900,
    });
    expect(server.requestTimeout).toBeGreaterThanOrEqual((longestUploadSeconds + 900) * 1000);
  });

  test("the headers timeout is set, below the request timeout, and neither is off", async () => {
    const server = await serverOf({});
    expect(server.headersTimeout).toBe(60_000);
    expect(server.headersTimeout).toBeLessThanOrEqual(server.requestTimeout);
    expect(server.requestTimeout).toBeGreaterThan(0);
  });
});

// A body that goes wrong (too large with no Content-Length, or a client that
// dies mid-upload) and a job folder that cannot be made must cost that one
// request, never the server: it keeps answering, does not stay busy and
// leaves nothing in WORK_DIR.
describe("a failed request never takes the server down", () => {
  const SMALL = { ...LIMITS, sliceBodyBytes: 1000, scadBodyBytes: 1000, stepBodyBytes: 1000 };
  const ROUTES = [
    ["slice", (base: string) => sliceUrl(base, P1S, 1)],
    ["scad/stl", (base: string) => `${base}/v1/scad/stl`],
    ["scad/png", (base: string) => `${base}/v1/scad/png`],
    ["step/glb", (base: string) => `${base}/v1/step/glb`],
  ] as const;

  async function expectServing(base: string, workDir?: string): Promise<void> {
    const res = await fetch(`${base}/v1/health`);
    expect(res.status).toBe(200);
    const health = slicerContract.health.parse(await res.json());
    expect(health.busy).toBe(false);
    if (workDir) expect(readdirSync(workDir)).toEqual([]);
  }

  test.each(ROUTES)(
    "%s: a chunked body (no Content-Length) that runs past the limit is 413, and the server still answers",
    async (_route, url) => {
      const s = setup({ limits: SMALL });
      const base = await start(s.config);
      const res = await streamChunked(url(base), 64 * 1024, { chunk: 512 });
      expect(res).toEqual({ status: 413, body: JSON.stringify({ error: "too_large" }) });
      await expectServing(base, s.workDir);
      // and the next request is served as normal
      const again = await streamChunked(url(base), 64 * 1024, { chunk: 512 });
      expect(again).toEqual({ status: 413, body: JSON.stringify({ error: "too_large" }) });
    },
  );

  test.each(ROUTES)(
    "%s: a client that dies mid-upload costs only its own request",
    async (_route, url) => {
      const s = setup();
      const base = await start(s.config);
      const res = await streamChunked(url(base), 1024 * 1024, { chunk: 4096, abortAfter: 16384 });
      expect(res).toEqual({ error: "aborted by the client" });
      await waitFor(() => readdirSync(s.workDir).length === 0);
      await expectServing(base, s.workDir);
    },
  );

  test.each(ROUTES)(
    "%s: a job folder that cannot be made is 500, and the server is not left busy",
    async (_route, url) => {
      const s = setup();
      // WORK_DIR is a plain file, so no job folder can be made under it.
      const workDir = join(s.stubs, "work-is-a-file");
      writeFileSync(workDir, "");
      const base = await start({ ...s.config, workDir });
      for (let i = 0; i < 2; i++) {
        const res = await fetch(url(base), { method: "POST", body: sliceable() });
        expect(res.status).toBe(500);
      }
      await expectServing(base);
    },
  );

  // The crash guard's 500 goes out before the body is read, as a refusal
  // does, so it closes the same way: lingering, so a client still sending a
  // large file reads the 500 instead of a reset (ECONNRESET or EPIPE).
  // Chunked, a 64 MiB body reaches the job folder on every route; sent by
  // fetch with its Content-Length it is 413 on the OpenSCAD routes, before
  // any folder is made, and 500 on the others.
  const BIG = 64 * 1024 * 1024;
  test.each([
    ["slice", (base: string) => sliceUrl(base, P1S, 1), 500],
    ["scad/stl", (base: string) => `${base}/v1/scad/stl`, 413],
    ["scad/png", (base: string) => `${base}/v1/scad/png`, 413],
    ["step/glb", (base: string) => `${base}/v1/step/glb`, 500],
  ] as const)(
    "%s: a large body to a job folder that cannot be made still gets its 500, not a reset",
    async (_route, url, declared) => {
      const s = setup();
      const workDir = join(s.stubs, "work-is-a-file");
      writeFileSync(workDir, "");
      const base = await start({ ...s.config, workDir });
      const res = await streamChunked(url(base), BIG, { chunk: 1024 * 1024 });
      expect(res).toEqual({ status: 500, body: "internal error\n" });
      const fetched = await fetch(url(base), { method: "POST", body: Buffer.alloc(BIG, 1) });
      expect(fetched.status).toBe(declared);
      await expectServing(base);
    },
  );

  // The lock is freed even when the job folder cannot be deleted: a delete
  // that throws must not leave the server answering 409 busy to every job
  // while /v1/health still says it is up.
  test("a job folder that cannot be deleted still frees the lock, and the next slice runs", async () => {
    const s = setup();
    const base = await start(s.config);
    rmFails.under = s.workDir;
    for (let i = 0; i < 2; i++) {
      const res = await postSlice(base, sliceable());
      expect(res.status).toBe(200);
      expect(slicerContract.sliceResult.parse(await res.json()).status).toBe("ok");
    }
    await expectServing(base);
  });

  // The sandbox self-test runs in its own folder before the first render. A
  // delete of that folder that fails must not turn a passed check into a 500
  // for the render that triggered it.
  test.each(["stl", "png"])(
    "scad/%s: a render whose self-test folder cannot be deleted still gets its answer",
    async (kind) => {
      const s = setup();
      const lr = fakeLandrun(s.stubs, { kind: "ok", content: "solid ok" });
      const base = await start({ ...s.config, landrunBin: lr.bin });
      rmFails.under = s.workDir;
      for (let i = 0; i < 2; i++) {
        const res = await fetch(`${base}/v1/scad/${kind}`, { method: "POST", body: "cube(10);" });
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("solid ok");
      }
      // one self-test, which passed and was remembered, then the two renders
      expect(readFileSync(lr.runsLog, "utf8").trim().split("\n")).toHaveLength(3);
      await expectServing(base);
    },
  );

  test.each(ROUTES)(
    "%s: a client that dies mid-upload frees the lock even when its folder cannot be deleted",
    async (_route, url) => {
      const s = setup();
      const base = await start(s.config);
      rmFails.under = s.workDir;
      const res = await streamChunked(url(base), 1024 * 1024, { chunk: 4096, abortAfter: 16384 });
      expect(res).toEqual({ error: "aborted by the client" });
      let busy = true;
      const until = Date.now() + 3000;
      while (busy && Date.now() < until) {
        const health = slicerContract.health.parse(await (await fetch(`${base}/v1/health`)).json());
        busy = health.busy;
        if (busy) await new Promise((r) => setTimeout(r, 25));
      }
      expect(busy).toBe(false);
      // the folder it could not delete is still there
      expect(readdirSync(s.workDir)).toHaveLength(1);
      rmFails.under = null;
      const next = await postSlice(base, sliceable());
      expect(next.status).toBe(200);
      await expectServing(base);
    },
  );
});

// A job folder that fails to delete would otherwise stay under /work, a 1g
// tmpfs, until the container restarts, and one 512 MiB upload's folder can
// fill half of it. So deletes retry, leftover job folders are swept at
// start-up and after every job, and health fails while /work, with no job
// running, has less free space than the floor (WORK_MIN_FREE_MIB).
describe("leftover job folders and /work space", () => {
  const JOB_A = "0b6f1d4e-3c2a-4f8e-9a71-5d2c8e6b4a10";
  const JOB_B = "7e2d9c1b-8a4f-4b3e-a6d5-1f0c9b8e7d62";

  test("start-up removes job folders left in WORK_DIR and nothing else", async () => {
    const s = setup();
    mkdirSync(join(s.workDir, JOB_A, "out"), { recursive: true });
    writeFileSync(join(s.workDir, JOB_A, "input.3mf"), "left behind");
    mkdirSync(join(s.workDir, JOB_B));
    // HOME is /work in the image, so other things can live there too
    mkdirSync(join(s.workDir, ".cache"));
    writeFileSync(join(s.workDir, "notes.txt"), "not a job folder");
    await start(s.config);
    expect(readdirSync(s.workDir).sort()).toEqual([".cache", "notes.txt"]);
  });

  test("folders failed deletes left behind are removed after the next job", async () => {
    const s = setup();
    const lr = fakeLandrun(s.stubs, { kind: "ok", content: "solid ok" });
    const base = await start({ ...s.config, landrunBin: lr.bin });
    rmFails.under = s.workDir;
    expect((await postSlice(base, sliceable())).status).toBe(200);
    // a render leaves its own folder and its self-test's
    const render = await fetch(`${base}/v1/scad/stl`, { method: "POST", body: "cube(1);" });
    expect(render.status).toBe(200);
    expect(readdirSync(s.workDir)).toHaveLength(3);
    rmFails.under = null;
    expect((await postSlice(base, sliceable())).status).toBe(200);
    expect(readdirSync(s.workDir)).toEqual([]);
  });

  test("a job folder delete retries ENOTEMPTY and EBUSY instead of giving up at once", async () => {
    const s = setup();
    const base = await start(s.config);
    expect((await postSlice(base, sliceable())).status).toBe(200);
    const deletes = rmFails.calls.filter((c) => c.path.startsWith(s.workDir));
    expect(deletes.length).toBeGreaterThan(0);
    for (const d of deletes) {
      expect(d.options).toMatchObject({ recursive: true, force: true });
      expect((d.options as { maxRetries?: number }).maxRetries).toBeGreaterThan(0);
    }
  });

  test("health is 500 with a plain-text reason when /work has less free space than the floor", async () => {
    const s = setup({ workMinFreeBytes: Number.MAX_SAFE_INTEGER });
    const base = await start(s.config);
    const res = await fetch(`${base}/v1/health`);
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await res.text()).toMatch(
      / has \d+ MiB free, below the \d+ MiB floor \(WORK_MIN_FREE_MIB\)\n$/,
    );
  });

  test("a running job's own use of /work never fails health; the floor applies once it is done", async () => {
    const s = setup(
      { sliceTimeoutSeconds: 3, workMinFreeBytes: Number.MAX_SAFE_INTEGER },
      { kind: "sleep" },
    );
    const base = await start(s.config);
    const first = postSlice(base, sliceable());
    await waitForFile(s.fake.pids);
    const during = await fetch(`${base}/v1/health`);
    expect(during.status).toBe(200);
    expect(slicerContract.health.parse(await during.json()).busy).toBe(true);
    expect((await first).status).toBe(200);
    expect((await fetch(`${base}/v1/health`)).status).toBe(500);
  });

  test("health sweeps leftover job folders when /work is below the floor, so it recovers without a job or a restart", async () => {
    const s = setup({ workMinFreeBytes: 640 * 1024 * 1024 });
    const base = await start(s.config);
    // /work is full while any job folder is left in it, and roomy once empty
    workSpace.free = () => (readdirSync(s.workDir).length > 0 ? 0 : 1024 * 1024 * 1024);
    rmFails.under = s.workDir;
    expect((await postSlice(base, sliceable())).status).toBe(200);
    expect(readdirSync(s.workDir)).toHaveLength(1);
    // the folder still will not delete, so health stays 500
    expect((await fetch(`${base}/v1/health`)).status).toBe(500);
    expect(readdirSync(s.workDir)).toHaveLength(1);
    // a moment later it deletes, and the next health check clears it with no
    // job in between
    rmFails.under = null;
    const res = await fetch(`${base}/v1/health`);
    expect(res.status).toBe(200);
    expect(slicerContract.health.parse(await res.json()).busy).toBe(false);
    expect(readdirSync(s.workDir)).toEqual([]);
  });

  test("health above the floor sweeps nothing", async () => {
    const s = setup();
    const base = await start(s.config);
    mkdirSync(join(s.workDir, JOB_A));
    rmFails.calls = [];
    expect((await fetch(`${base}/v1/health`)).status).toBe(200);
    expect(rmFails.calls).toEqual([]);
    expect(readdirSync(s.workDir)).toEqual([JOB_A]);
  });

  test("WORK_MIN_FREE_MIB defaults to 640 MiB and can be set", () => {
    const VERSIONS = { ORCA_VERSION: "2.5.0", OPENSCAD_VERSION: "2026.11-RC0" };
    expect(loadConfig(VERSIONS).workMinFreeBytes).toBe(640 * 1024 * 1024);
    expect(loadConfig({ ...VERSIONS, WORK_MIN_FREE_MIB: "100" }).workMinFreeBytes).toBe(
      100 * 1024 * 1024,
    );
    expect(() => loadConfig({ ...VERSIONS, WORK_MIN_FREE_MIB: "lots" })).toThrow(
      /WORK_MIN_FREE_MIB/,
    );
  });
});
