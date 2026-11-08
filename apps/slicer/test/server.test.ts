// The slicer server (build plan Task 11) against stub programs: contract v1
// over HTTP, one slice at a time (409), the kill at SLICE_TIMEOUT_SECONDS,
// the body limits and the Orca arguments of the T1 recipe.
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIMITS, slicerContract } from "@platehouse/slicer-contract";
import { buildSliceable } from "@platehouse/threemf/test/sliceable";
import { afterEach, describe, expect, test } from "vitest";
import { buildProfiles, loadIndex } from "../src/profiles.js";
import { createSlicer, loadConfig, type Slicer, type SlicerConfig } from "../src/server.js";
import { profileTree, TREE_PRINTERS } from "./support/profiles.js";
import {
  fakeLandrun,
  fakeOrca,
  fakeStepWorker,
  fakeTime,
  type OrcaMode,
  stubDir,
} from "./support/stubs.js";

const P1S = "Bambu Lab P1S 0.4 nozzle";
const running: Slicer[] = [];

afterEach(async () => {
  while (running.length) await running.pop()?.close();
});

function setup(
  over: Partial<SlicerConfig> = {},
  orca: OrcaMode = { kind: "ok", time: 1, weight: 1, grams: [1] },
) {
  const stubs = stubDir();
  const profilesDir = mkdtempSync(join(tmpdir(), "slicer-profiles-"));
  buildProfiles(loadIndex(profileTree()), profilesDir);
  const workDir = mkdtempSync(join(tmpdir(), "slicer-work-"));
  const fake = fakeOrca(stubs, orca);
  const config: SlicerConfig = {
    port: 0,
    workDir,
    profilesDir,
    orcaBin: fake.bin,
    timeBin: fakeTime(stubs),
    openscadBin: "/opt/openscad/AppRun",
    openscadDir: "/opt/openscad",
    landrunBin: fakeLandrun(stubs, { kind: "ok", content: "solid x" }).bin,
    stepWorker: fakeStepWorker(stubs, { kind: "ok", content: "glTF" }),
    slicePlateSeconds: 120,
    sliceTimeoutSeconds: 30,
    scadTimeoutSeconds: 30,
    stepTimeoutSeconds: 30,
    orcaVersion: "2.5.0",
    openscadVersion: "2026.11-RC0",
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
  test("SLICE_PLATE_SECONDS defaults to the gate's 120 and the kill to that plus 60", () => {
    const c = loadConfig({});
    expect(c.slicePlateSeconds).toBe(120);
    expect(c.sliceTimeoutSeconds).toBe(180);
    expect(c.port).toBe(8080);
    expect(c.workDir).toBe("/work");
    expect(loadConfig({ SLICE_PLATE_SECONDS: "200" }).sliceTimeoutSeconds).toBe(260);
    expect(
      loadConfig({ SLICE_PLATE_SECONDS: "200", SLICE_TIMEOUT_SECONDS: "500" }).sliceTimeoutSeconds,
    ).toBe(500);
  });

  test("a bad number names the key", () => {
    expect(() => loadConfig({ SLICE_PLATE_SECONDS: "soon" })).toThrow(/SLICE_PLATE_SECONDS/);
    expect(() => loadConfig({ PORT: "-1" })).toThrow(/PORT/);
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
    expect(body.filaments).toContainEqual({ type: "PLA", profile: "Generic PLA" });
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
      filamentProfiles: ["Generic PLA", "Generic PLA"],
      timeSeconds: 1234.5,
      weightGrams: 12.3456,
      filaments: [
        { slot: 1, type: "PLA", color: "#FFFFFF", grams: 6.1 },
        { slot: 2, type: "PLA", color: "#1F1F1F", grams: 6.2456 },
      ],
      peakRssBytes: 2048 * 1024,
    });
    expect(readdirSync(s.workDir)).toEqual([]);
  });

  test("Orca gets the T1 recipe: one plate, statistics, --mstpp, the machine preset alone and a generic filament per slot", async () => {
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
    for (const f of filaments) expect(JSON.parse(readFileSync(f, "utf8")).name).toBe("Generic PLA");
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

  test("a chunked body that runs past the limit is 413 and leaves nothing behind", async () => {
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

  test("a STEP file over 256 MiB is 413", async () => {
    const base = await start(setup().config);
    const res = await headersOnly(`${base}/v1/step/glb`, {
      "content-type": "application/octet-stream",
      "content-length": String(LIMITS.stepBodyBytes + 1),
    });
    expect(res.status).toBe(413);
  });
});
