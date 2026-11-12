// OpenSCAD in the built image (AC-052): renders STL and PNG headless, shows
// OpenSCAD's own message on an error, and cannot read a file outside its own
// job folder. /opt/platehouse/sandbox-probe.stl is a small STL the image
// ships for this test; each control opens the same file without landrun, so
// the refusal is the sandbox's and not a missing or unreadable file.
//
// The security review of PR #36 (issue #47) asked for more than the probe:
// a file in a sibling folder under /work (another job's), /etc/passwd, and a
// shell opening a TCP connection through bash's /dev/tcp. The sandbox's
// --rox rules no longer let OpenSCAD start a shell at all, so the network
// case runs bash under the server's rules with bash itself let in by hand.
import { slicerContract } from "@platehouse/slicer-contract";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { landrunArgs } from "../../src/sandbox.js";
import { type RunningSlicer, startSlicer } from "./support/slicer.js";

let slicer: RunningSlicer;
beforeAll(async () => {
  slicer = await startSlicer();
  // A folder beside the job folders, standing for another job's, with a
  // copy of the probe and a link to /etc/passwd. Its name is not a job
  // folder name, so the server's sweep leaves it alone.
  const r = slicer.exec([
    "sh",
    "-c",
    `mkdir -p ${SIBLING} && cp ${PROBE} ${SIBLING}/model.stl && ln -sf /etc/passwd ${SIBLING}/passwd.stl && mkdir -p ${SHELL_DIR}`,
  ]);
  if (r.code !== 0) throw new Error(`could not set up the sibling folder: ${r.stderr}`);
});
afterAll(() => slicer?.stop());

const PROBE = "/opt/platehouse/sandbox-probe.stl";
const SIBLING = "/work/sibling-job";
/** A job-like folder for the shell cases, which run landrun by hand. */
const SHELL_DIR = "/work/shell-check";
const CANNOT_OPEN = "Can't open import file";

function post(path: string, body: string) {
  return fetch(`${slicer.base}${path}`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body,
  });
}

/** The status, with the slicer's error message when there is one, for a readable failure. */
async function statusOf(res: Response): Promise<string> {
  if (res.status === 200) return "200";
  return `${res.status} ${await res.clone().text()}`;
}

/** Runs OpenSCAD on `import(file)` without landrun; returns its exit code and output. */
function importWithoutSandbox(file: string) {
  return slicer.exec([
    "sh",
    "-c",
    `d=$(mktemp -d /work/control-XXXXXX) && printf 'import("${file}");\\n' > "$d/in.scad" && HOME="$d" /opt/openscad/AppRun --backend=manifold -o "$d/out.stl" "$d/in.scad" 2>&1; st=$?; test -s "$d/out.stl" && echo WROTE; exit $st`,
  ]);
}

/** landrun with the server's own rules, run by hand in SHELL_DIR. */
function landrunInContainer(command: string[], extraRox: string[] = []) {
  const args = landrunArgs({ dir: SHELL_DIR, openscadDir: "/opt/openscad", command });
  if (extraRox.length > 0) {
    const at = args.indexOf("--rox") + 1;
    args[at] = [args[at], ...extraRox].join(",");
  }
  return slicer.exec(["/usr/local/bin/landrun", ...args]);
}

describe("OpenSCAD in the image", () => {
  test("a cube renders to STL", async () => {
    const res = await post("/v1/scad/stl", "cube([10, 10, 10]);\n");
    expect(await statusOf(res)).toBe("200");
    expect(res.headers.get("content-type")).toBe("model/stl");
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(84);
  });

  test("a cube renders to PNG", async () => {
    const res = await post("/v1/scad/png", "cube([10, 10, 10]);\n");
    expect(await statusOf(res)).toBe("200");
    expect(res.headers.get("content-type")).toBe("image/png");
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });

  // The first render ran the self-test: the kernel's Landlock ABI, then the
  // probe import, refused by OpenSCAD itself.
  test("the sandbox self-test passed before the first render, and the log says why", () => {
    const line = slicer
      .logs()
      .split("\n")
      .find((l) => l.includes("sandbox self-test:"));
    expect(line).toBeDefined();
    expect(line).toMatch(
      /sandbox self-test: ok: Landlock ABI \d+( or newer)?; landrun blocked a read of \/opt\/platehouse\/sandbox-probe\.stl: .*Can't open import file/,
    );
  });

  test("scad render error returns OpenSCAD's message", async () => {
    const res = await post("/v1/scad/stl", "cube([10, 10, 10]\n");
    expect(res.status).toBe(422);
    const body = slicerContract.renderError.parse(await res.json());
    // OpenSCAD's own parser message, so the failure is OpenSCAD's and not
    // landrun failing to start it.
    expect(body.message).toMatch(/parser error|syntax error/i);
  });

  const OUTSIDE: [string, string][] = [
    ["the image's sandbox probe", PROBE],
    ["a file in a sibling folder under /work", `${SIBLING}/model.stl`],
    ["/etc/passwd, through a link named .stl", `${SIBLING}/passwd.stl`],
  ];

  test.each(OUTSIDE)(
    "scad import of %s, outside its own job folder, fails (AC-052)",
    async (_label, file) => {
      const res = await post("/v1/scad/stl", `import("${file}");\n`);
      expect(res.status).toBe(422);
      const body = slicerContract.renderError.parse(await res.json());
      // OpenSCAD ran and could not open the file, which a landrun start-up
      // failure or a parse error would not say.
      expect(body.message).toContain(`${CANNOT_OPEN} '${file}'`);
    },
  );

  test.each(OUTSIDE)(
    "control: without landrun OpenSCAD opens %s, so landrun is what blocks it",
    (_label, file) => {
      const r = importWithoutSandbox(file);
      expect(r.stdout).not.toContain(CANNOT_OPEN);
      // the two STL files render; /etc/passwd is not an STL, so OpenSCAD
      // opens it and fails to read it as one
      if (!file.endsWith("passwd.stl")) {
        expect(r.code, r.stdout).toBe(0);
        expect(r.stdout).toContain("WROTE");
      }
    },
  );

  test("OpenSCAD's sandbox runs no shell: bash under the server's landrun rules cannot start", () => {
    const r = landrunInContainer(["/bin/bash", "-c", "echo started"]);
    expect(r.stdout).not.toContain("started");
    expect(r.code).not.toBe(0);
    // control: the same bash runs without landrun
    expect(slicer.exec(["/bin/bash", "-c", "echo started"]).stdout).toContain("started");
  });

  test("a shell let in by hand still cannot open a TCP connection through /dev/tcp", async () => {
    // A listener on the container's loopback, and proof that bash without
    // landrun reaches it.
    slicer.exec([
      "sh",
      "-c",
      `nohup node -e "require('node:net').createServer((s) => s.end('hi')).listen(18080, '127.0.0.1')" >/dev/null 2>&1 &`,
    ]);
    const connect = "exec 3<>/dev/tcp/127.0.0.1/18080 && echo connected";
    let control = slicer.exec(["/usr/bin/bash", "-c", connect]);
    for (let i = 0; i < 50 && !control.stdout.includes("connected"); i++) {
      await new Promise((r) => setTimeout(r, 100));
      control = slicer.exec(["/usr/bin/bash", "-c", connect]);
    }
    expect(control.stdout, control.stderr).toContain("connected");

    const r = landrunInContainer(
      ["/usr/bin/bash", "-c", `echo started; ${connect}`],
      ["/usr/bin/bash"],
    );
    // bash ran under the sandbox, and its connect was refused
    expect(r.stdout, r.stderr).toContain("started");
    expect(r.stdout).not.toContain("connected");
    expect(r.stderr).toMatch(/Permission denied/);
  });

  // The job folders' tmpfs carries noexec, nosuid and nodev, as Hades mounts
  // it (Task 26 copies these options into compose); every test in this
  // directory runs the image on such a mount.
  test("/work is mounted noexec, nosuid and nodev", () => {
    const mounts = slicer.exec(["cat", "/proc/mounts"]).stdout.split("\n");
    const work = mounts.find((l) => l.split(" ")[1] === "/work");
    expect(work).toBeDefined();
    const options = (work ?? "").split(" ")[3]?.split(",") ?? [];
    expect(options).toEqual(expect.arrayContaining(["noexec", "nosuid", "nodev"]));
  });
});
