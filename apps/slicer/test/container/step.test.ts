// STEP to GLB in the built image. The sample is NIST MBE PMI test
// case CTC-01, geometry only, the public file gate item (h) used; CI
// downloads it, checks its sha256 and names it in STEP_SAMPLE. It is public
// NIST test data, not a designer file.
import { readFileSync } from "node:fs";
import { slicerContract } from "@platehouse/slicer-contract";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { NODE_LIBS, prlimitCommand, sandboxRules } from "../../src/sandbox.js";
import { IMAGE_PATHS, type RunningSlicer, startSlicer } from "./support/slicer.js";

/** A folder standing for the worker's own job folder. */
const OWN = "/work/a";
/** A folder standing for another job's. Neither name is a job folder name, so the server's sweep leaves both alone. */
const OTHER = "/work/b";

let slicer: RunningSlicer;
beforeAll(async () => {
  slicer = await startSlicer();
  const r = slicer.exec([
    "sh",
    "-c",
    `mkdir -p ${OWN} ${OTHER} && echo own > ${OWN}/own.txt && echo other > ${OTHER}/marker.txt`,
  ]);
  if (r.code !== 0) throw new Error(`could not set up the job folders: ${r.stderr}`);
});
afterAll(() => slicer?.stop());

describe("STEP in the image", () => {
  test("every library Node links is in NODE_LIBS, and every NODE_LIBS file is in the image", () => {
    const real = (path: string): string => {
      const r = slicer.exec(["readlink", "-f", path]);
      if (r.code !== 0) throw new Error(`readlink -f ${path} failed: ${r.stderr}`);
      return r.stdout.trim();
    };
    const ldd = slicer.exec(["ldd", "/opt/node/bin/node"]);
    expect(ldd.code, ldd.stderr).toBe(0);
    // Each line is "name => /path (0x...)", or the loader's "/path (0x...)";
    // linux-vdso is the kernel's, with no file.
    const lines = ldd.stdout
      .split("\n")
      .filter((l) => l.trim() !== "" && !l.includes("linux-vdso"));
    const linked = lines.map((line) => {
      const path = /(?:=>\s*)?(\/\S+)\s+\(0x[0-9a-f]+\)/.exec(line)?.[1];
      if (!path) throw new Error(`cannot read this ldd line: ${line}`);
      return real(path);
    });
    expect(linked.length).toBeGreaterThanOrEqual(NODE_LIBS.length - 1);
    const allowed = new Set(NODE_LIBS.map(real));
    expect(linked.filter((path) => !allowed.has(path))).toEqual([]);
    for (const lib of NODE_LIBS) {
      const r = slicer.exec(["test", "-f", lib]);
      expect(r.code, `${lib} is not a file in the image`).toBe(0);
    }
  });

  test("STEP sample converts to GLB", async () => {
    const sample = process.env.STEP_SAMPLE;
    if (!sample) throw new Error("STEP_SAMPLE must name the NIST CTC-01 STEP file");
    const res = await fetch(`${slicer.base}/v1/step/glb`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: readFileSync(sample),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("model/gltf-binary");
    const glb = Buffer.from(await res.arrayBuffer());
    expect(glb.subarray(0, 4).toString("ascii")).toBe("glTF");
    expect(glb.readUInt32LE(8)).toBe(glb.length);
    expect(glb.length).toBeGreaterThan(10_000);
  });

  test("a file that is not STEP is 422 convert_failed", async () => {
    const res = await fetch(`${slicer.base}/v1/step/glb`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: "not a step file",
    });
    expect(res.status).toBe(422);
    expect(slicerContract.convertError.parse(await res.json()).error).toBe("convert_failed");
  });
});

// The STEP worker's own sandbox, from inside: Node run under exactly the
// prlimit and landrun arguments the server gives the worker (the same
// exported functions, with its job folder set to OWN), as the slicer user.
// Each case has a control without landrun, so the refusal is the sandbox's.
//
// Node cannot run under OrcaSlicer's rules (they let only Orca's own tree
// and the system libraries run), so Orca's sandbox cannot be probed this
// way. Its containment rests on the unit test that pins its rules, with its
// job folder the only writable path (sandbox.test.ts), and on the kernel
// enforcing them; the slice tests show Orca still slices under them.
describe("the STEP worker's sandbox in the image", () => {
  /** Runs `node -e script` under the worker's prlimit and landrun, or without landrun. */
  function node(script: string, sandboxed = true) {
    const command = ["/opt/node/bin/node", "-e", script];
    const args = prlimitCommand({
      program: "step",
      timeoutSeconds: 120,
      landrun: sandboxed
        ? {
            bin: "/usr/local/bin/landrun",
            rules: sandboxRules("step", { ...IMAGE_PATHS, dir: OWN }),
          }
        : null,
      command,
    });
    return slicer.exec(["/usr/bin/prlimit", ...args]);
  }
  const read = (file: string) =>
    `try { process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(file)}, "utf8")) } catch (e) { process.stdout.write(String(e.code)) }`;
  const connect = `require("node:net").connect(8080, "127.0.0.1")
    .on("connect", () => { process.stdout.write("connected"); process.exit(0) })
    .on("error", (e) => { process.stdout.write(String(e.code)); process.exit(0) })`;

  test("it reads a file in its own job folder", () => {
    const r = node(read(`${OWN}/own.txt`));
    expect(r.stdout.trim(), r.stderr).toBe("own");
  });

  test("it cannot read a file in another job's folder", () => {
    const r = node(read(`${OTHER}/marker.txt`));
    expect(r.stdout.trim(), r.stderr).toBe("EACCES");
    // control: the same read without landrun works
    expect(node(read(`${OTHER}/marker.txt`), false).stdout.trim()).toBe("other");
  });

  test("it cannot open a TCP connection, not even to the slicer's own port", () => {
    const r = node(connect);
    expect(r.stdout.trim(), r.stderr).toBe("EACCES");
    // control: without landrun the server's port answers
    expect(node(connect, false).stdout.trim()).toBe("connected");
  });
});
