// STEP to GLB in the built image. The sample is NIST MBE PMI test
// case CTC-01, geometry only, the public file gate item (h) used; CI
// downloads it, checks its sha256 and names it in STEP_SAMPLE. It is public
// NIST test data, not a designer file.
import { readFileSync } from "node:fs";
import { slicerContract } from "@platehouse/slicer-contract";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { landrunArgs, NODE_LIBS, prlimitCommand, sandboxRules } from "../../src/sandbox.js";
import { IMAGE_PATHS, type RunningSlicer, runInImage, startSlicer } from "./support/slicer.js";

/** A folder standing for the worker's own job folder. */
const OWN = "/work/a";
/**
 * A folder standing for another job's. Neither name is a job folder name, so
 * the server's sweep leaves both alone.
 */
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

  // ABI 6 scopes signals and abstract Unix sockets to the sandbox's own
  // domain: a process outside it (here, one started by docker exec) cannot be
  // signalled or reached. Each case has a control without landrun.

  /** Starts `setsid sleep 600` outside the sandbox and returns its pid. */
  function startSleep(name: string): string {
    const file = `/work/${name}.pid`;
    const started = slicer.exec([
      "sh",
      "-c",
      `setsid sh -c 'echo $$ > ${file}; exec sleep 600' </dev/null >/dev/null 2>&1 &
       for i in $(seq 50); do [ -s ${file} ] && break; sleep 0.1; done; cat ${file}`,
    ]);
    const pid = started.stdout.trim();
    expect(pid, `${started.stdout}${started.stderr} (exit ${started.code})`).toMatch(/^\d+$/);
    return pid;
  }
  /**
   * The sleep's /proc stat line, or "gone"; fails if the exec itself failed
   * (a stopped container).
   */
  function statOf(pid: string): string {
    const r = slicer.exec(["sh", "-c", `cat /proc/${pid}/stat 2>/dev/null || echo gone`]);
    expect(r.code, `exec failed (exit ${r.code}): ${r.stdout}${r.stderr}`).toBe(0);
    return r.stdout.trim();
  }
  const isAlive = (stat: string) => stat !== "gone" && !/^\d+ \(.*\) Z /.test(stat);
  const killPid = (pid: string) =>
    `try { process.kill(${Number(pid)}, "SIGTERM"); process.stdout.write("ok") } catch (e) { process.stdout.write(String(e.code)) }`;

  test("it cannot signal a process outside the sandbox", () => {
    const pid = startSleep("scope-signal");
    try {
      expect(isAlive(statOf(pid)), `the sleep ${pid} did not start: ${statOf(pid)}`).toBe(true);
      const r = node(killPid(pid));
      expect(r.stdout.trim(), `${r.stderr} (exit ${r.code})`).toBe("EPERM");
      const after = statOf(pid);
      expect(isAlive(after), `the sleep ${pid} did not survive: ${after}`).toBe(true);
    } finally {
      slicer.exec(["kill", pid]);
    }
  });

  test("control: without landrun the same kill works", () => {
    const pid = startSleep("scope-signal-control");
    try {
      const r = node(killPid(pid), false);
      expect(r.stdout.trim(), `${r.stderr} (exit ${r.code})`).toBe("ok");
      let after = statOf(pid);
      for (let i = 0; i < 50 && isAlive(after); i++) {
        slicer.exec(["sleep", "0.1"]);
        after = statOf(pid);
      }
      expect(isAlive(after), `the sleep ${pid} is still there: ${after}`).toBe(false);
    } finally {
      slicer.exec(["kill", pid]);
    }
  });

  test("it cannot connect to an abstract Unix socket outside the sandbox", () => {
    const abstract = "\\0platehouse-scope-test";
    const connectAbstract = `require("node:net").connect("${abstract}")
      .on("connect", () => { process.stdout.write("connected"); process.exit(0) })
      .on("error", (e) => { process.stdout.write(String(e.code)); process.exit(0) })`;
    const listener = `require("node:net").createServer().listen("${abstract}", () => require("node:fs").writeFileSync("/work/scope-socket.up", "up")); setTimeout(() => process.exit(0), 600000)`;
    const started = slicer.exec([
      "sh",
      "-c",
      `rm -f /work/scope-socket.up /work/scope-socket.pid
       setsid sh -c 'echo $$ > /work/scope-socket.pid; exec /opt/node/bin/node -e "$1"' sh "$1" </dev/null >/work/scope-socket.log 2>&1 &
       for i in $(seq 50); do [ -s /work/scope-socket.up ] && break; sleep 0.1; done
       cat /work/scope-socket.pid; cat /work/scope-socket.up; cat /work/scope-socket.log`,
      "sh",
      listener,
    ]);
    const [pid = "", up = ""] = started.stdout.trim().split("\n");
    try {
      expect(`${pid}\n${up}`, `${started.stdout}${started.stderr} (exit ${started.code})`).toMatch(
        /^\d+\nup$/,
      );
      const r = node(connectAbstract);
      expect(r.stdout.trim(), `${r.stderr} (exit ${r.code})`).toBe("EPERM");
      // control: without landrun the listener answers
      const control = node(connectAbstract, false);
      expect(control.stdout.trim(), `${control.stderr} (exit ${control.code})`).toBe("connected");
    } finally {
      if (/^\d+$/.test(pid)) slicer.exec(["kill", pid]);
    }
  });
});

// landrun sets no-new-privileges on the process it runs, whatever the
// container's own setting. These runs are in a throwaway container without
// no-new-privileges, as user 10001, so the control shows the flag is landrun's.
describe("landrun sets no-new-privileges", () => {
  const status = `process.stdout.write(require("node:fs").readFileSync("/proc/self/status", "utf8"))`;

  test("the sandboxed Node has NoNewPrivs 1, and the same Node without landrun 0", () => {
    const args = landrunArgs({
      rules: sandboxRules("step", { ...IMAGE_PATHS, dir: "/tmp" }),
      command: ["/opt/node/bin/node", "-e", status],
    });
    // /proc is read-only in the rules for this one run, to read /proc/self/status.
    const at = args.indexOf("--ro") + 1;
    args[at] = [args[at], "/proc"].join(",");
    const sandboxed = runInImage("/usr/local/bin/landrun", args, { user: "10001" });
    expect(sandboxed.stdout, `${sandboxed.stderr} (exit ${sandboxed.code})`).toMatch(
      /NoNewPrivs:\s+1/,
    );
    const control = runInImage("/opt/node/bin/node", ["-e", status], { user: "10001" });
    expect(control.stdout, `${control.stderr} (exit ${control.code})`).toMatch(/NoNewPrivs:\s+0/);
  });
});
