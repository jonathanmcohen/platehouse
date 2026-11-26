// OpenSCAD in the built image: renders STL and PNG headless, shows
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
import { landrunArgs, sandboxRules } from "../../src/sandbox.js";
import { PROC_ENVIRON, SELF_TEST_REFUSALS } from "../../src/scad.js";
import { IMAGE_PATHS, type RunningSlicer, runInImage, startSlicer } from "./support/slicer.js";

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

/** Runs OpenSCAD on `source` without landrun; returns its exit code and output. */
function renderWithoutSandbox(source: string) {
  return slicer.exec([
    "sh",
    "-c",
    `d=$(mktemp -d /work/control-XXXXXX) && printf '%s\\n' "$1" > "$d/in.scad" && HOME="$d" /opt/openscad/AppRun --backend=manifold -o "$d/out.stl" "$d/in.scad" 2>&1; st=$?; test -s "$d/out.stl" && echo WROTE; exit $st`,
    "sh",
    source,
  ]);
}

/** landrun with the server's own rules, run by hand in SHELL_DIR. */
function landrunInContainer(command: string[], extraRox: string[] = []) {
  const rules = sandboxRules("openscad", { ...IMAGE_PATHS, dir: SHELL_DIR });
  const args = landrunArgs({ rules, command });
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

  // The first render ran the self-test: the kernel's Landlock ABI, then four
  // reads outside the job folder, each refused by OpenSCAD itself: the probe,
  // its copy in another job's folder, and /proc/self/environ by an include
  // and by surface().
  test("the sandbox self-test passed before the first render, and the log says why", () => {
    const line = slicer
      .logs()
      .split("\n")
      .find((l) => l.includes("sandbox self-test:"));
    expect(line).toBeDefined();
    expect(line).toMatch(
      new RegExp(
        [
          "sandbox self-test: ok: Landlock ABI \\d+( or newer)?; landrun blocked every read outside the job folder: ",
          `import\\(\\) of /opt/platehouse/sandbox-probe\\.stl: [^;]*${SELF_TEST_REFUSALS.import}[^;]*; `,
          `import\\(\\) of /work/[0-9a-f-]{36}/sandbox-probe\\.stl: [^;]*${SELF_TEST_REFUSALS.import}[^;]*; `,
          `include of /proc/self/environ: [^;]*${SELF_TEST_REFUSALS.include}[^;]*; `,
          `surface\\(\\) of /proc/self/environ: [^;]*${SELF_TEST_REFUSALS.surface}`,
        ].join(""),
      ),
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

  // [label, .scad source, OpenSCAD's refusal, the path it names]
  const OUTSIDE: [string, string, string, string][] = [
    ["the image's sandbox probe", `import("${PROBE}");`, SELF_TEST_REFUSALS.import, PROBE],
    [
      "a file in a sibling folder under /work",
      `import("${SIBLING}/model.stl");`,
      SELF_TEST_REFUSALS.import,
      `${SIBLING}/model.stl`,
    ],
    [
      "/etc/passwd, through a link named .stl",
      `import("${SIBLING}/passwd.stl");`,
      SELF_TEST_REFUSALS.import,
      `${SIBLING}/passwd.stl`,
    ],
    [
      "/proc/self/environ, by an include",
      `include <${PROC_ENVIRON}>`,
      SELF_TEST_REFUSALS.include,
      PROC_ENVIRON,
    ],
    [
      "/proc/self/environ, by surface()",
      `surface(file = "${PROC_ENVIRON}");`,
      SELF_TEST_REFUSALS.surface,
      PROC_ENVIRON,
    ],
  ];

  test.each(OUTSIDE)(
    "scad read of %s, outside its own job folder, fails",
    async (_label, source, phrase, path) => {
      const res = await post("/v1/scad/stl", `${source}\n`);
      expect(res.status).toBe(422);
      const body = slicerContract.renderError.parse(await res.json());
      // OpenSCAD ran and could not open the file, which a landrun start-up
      // failure or a parse error would not say: one of its lines (the
      // message joins them with " / ") has the refusal and the quoted path.
      const lines = body.message.split(" / ");
      expect(
        lines.some((l) => l.includes(phrase) && l.includes(`'${path}'`)),
        body.message,
      ).toBe(true);
    },
  );

  test.each(OUTSIDE)(
    "control: without landrun OpenSCAD opens %s, so landrun is what blocks it",
    (_label, source, phrase, path) => {
      const r = renderWithoutSandbox(source);
      expect(r.stdout).not.toContain(phrase);
      // the two STL files render; /etc/passwd is not an STL and
      // /proc/self/environ is not a .scad or a surface, so OpenSCAD opens
      // them and fails to read them
      if (path.endsWith("model.stl") || path === PROBE) {
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

  // Security review of PR #123 (issue #153 item 6): the /etc/passwd link
  // above sits in a sibling folder that is denied anyway, so it cannot show
  // that a link inside the job's own folder is followed to its target. This
  // one is in the folder landrun gives read and write access to, and points
  // at the probe outside it.
  test("a link inside the job's own folder to a file outside it cannot be read under landrun", () => {
    const setup = slicer.exec([
      "sh",
      "-c",
      `ln -sf ${PROBE} ${SHELL_DIR}/inside-link.stl && printf 'import("inside-link.stl");\\n' > ${SHELL_DIR}/link.scad`,
    ]);
    expect(setup.code, setup.stderr).toBe(0);
    const r = landrunInContainer([
      "/opt/openscad/AppRun",
      "--backend=manifold",
      "-o",
      `${SHELL_DIR}/link.stl`,
      `${SHELL_DIR}/link.scad`,
    ]);
    expect(`${r.stdout}${r.stderr}`).toContain(SELF_TEST_REFUSALS.import);
    // control: without landrun the same link opens and renders
    const control = renderWithoutSandbox(`import("${SHELL_DIR}/inside-link.stl");`);
    expect(control.stdout).not.toContain(SELF_TEST_REFUSALS.import);
    expect(control.stdout).toContain("WROTE");
  });

  // Issue #153 item 3: a process that calls setsid() leaves its job's process
  // group, so the kill at the time cap misses it, and it is re-parented to
  // tini. The server kills such processes left behind when a job is released. A
  // setsid'd sleep started through docker exec stands for one: once its
  // shell exits, its parent is PID 1, as an escaped OpenSCAD child's would
  // be. A process docker exec starts directly has parent 0 and is not hit.
  test("a process re-parented to PID 1 does not outlive the next job", async () => {
    // The sleep writes its own pid (exec keeps it), whether setsid forked or not.
    const started = slicer.exec([
      "sh",
      "-c",
      `setsid sh -c 'echo $$ > /work/escapee.pid; exec sleep 600' </dev/null >/dev/null 2>&1 &
       for i in $(seq 50); do [ -s /work/escapee.pid ] && break; sleep 0.1; done; cat /work/escapee.pid`,
    ]);
    const pid = started.stdout.trim();
    expect(pid, started.stderr).toMatch(/^\d+$/);
    const ppidOf = () =>
      slicer
        .exec([
          "sh",
          "-c",
          `cat /proc/${pid}/stat 2>/dev/null | sed 's/.*) [A-Z] \\([0-9]*\\) .*/\\1/'`,
        ])
        .stdout.trim();
    // control: it is alive, and its parent is tini
    expect(ppidOf()).toBe("1");

    const res = await post("/v1/scad/stl", "cube([1, 1, 1]);\n");
    expect(await statusOf(res)).toBe("200");
    let left = ppidOf();
    for (let i = 0; i < 50 && left !== ""; i++) {
      await new Promise((r) => setTimeout(r, 100));
      left = ppidOf();
    }
    expect(left, `process ${pid} is still there`).toBe("");
    // Other orphans may go with it, such as the listener the /dev/tcp test
    // above left running through docker exec.
    expect(slicer.logs()).toMatch(new RegExp(`left behind by the job: [0-9, ]*\\b${pid}\\b`));
  });

  test("a re-parented process and its child are both gone after the next job", async () => {
    const started = slicer.exec([
      "sh",
      "-c",
      `setsid sh -c 'sleep 600 & echo $! > /work/leftover-a.pid; sleep 600 & echo $! > /work/leftover-b.pid; wait' </dev/null >/dev/null 2>&1 &
       for i in $(seq 50); do [ -s /work/leftover-b.pid ] && break; sleep 0.1; done; cat /work/leftover-a.pid /work/leftover-b.pid`,
    ]);
    const pids = started.stdout.trim().split("\n");
    expect(pids, started.stderr).toHaveLength(2);
    for (const pid of pids) expect(pid).toMatch(/^\d+$/);
    const present = (pid: string) =>
      slicer.exec(["sh", "-c", `test -d /proc/${pid} && echo up`]).stdout.trim() === "up";
    // control: both are running before the job
    for (const pid of pids) expect(present(pid), `process ${pid} did not start`).toBe(true);

    const res = await post("/v1/scad/stl", "cube([1, 1, 1]);\n");
    expect(await statusOf(res)).toBe("200");
    for (let i = 0; i < 50 && pids.some(present); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    for (const pid of pids) expect(present(pid), `process ${pid} is still there`).toBe(false);
  });

  // Issue #153 item 5: the image's build strips every setuid and setgid bit
  // and fails if any is left; this checks the built image. The check is about
  // what is in the image, not how it runs, so it does not need the hardened
  // runtime: it runs in a fresh throwaway container from the same image, as
  // root with Docker's default capabilities, which can read every folder
  // (root in the hardened container has no capabilities, and cannot). No
  // folder is left out, and any error find reports (a folder it could not
  // search) fails the test, as a found file does.
  test("no file in the image is setuid or setgid", () => {
    const r = runInImage("find", ["/", "-xdev", "-perm", "/6000", "-type", "f"]);
    expect({ code: r.code, stdout: r.stdout, stderr: r.stderr }).toEqual({
      code: 0,
      stdout: "",
      stderr: "",
    });
  });

  // The job folders' tmpfs carries noexec, nosuid and nodev, as the reference
  // server mounts it (examples/docker-compose.yml carries the same options);
  // every test in this
  // directory runs the image on such a mount.
  test("/work is mounted noexec, nosuid and nodev", () => {
    const mounts = slicer.exec(["cat", "/proc/mounts"]).stdout.split("\n");
    const work = mounts.find((l) => l.split(" ")[1] === "/work");
    expect(work).toBeDefined();
    const options = (work ?? "").split(" ")[3]?.split(",") ?? [];
    expect(options).toEqual(expect.arrayContaining(["noexec", "nosuid", "nodev"]));
  });
  // Issue #480: every sandboxed program starts as "choom -n 1000 -- prlimit
  // ...", so when the container runs out of memory the kernel stops the
  // render before the slicer. The render is started and not awaited; one
  // shell inside the container looks for an openscad process, so no time is
  // lost between docker execs, and prints its OOM score and the server's.
  test("during a render, OpenSCAD's OOM score is 1000 and the server's is 0", async () => {
    // Sixty-four million loop steps keep OpenSCAD's interpreter busy for
    // several seconds, with no large model and almost no memory.
    const heavy =
      "echo(len([for (i = [0:399]) for (j = [0:399]) for (k = [0:399]) if (i * j * k < 0) 1]));\ncube(1);";
    const render = post("/v1/scad/stl", heavy).then(statusOf, (e: unknown) => `fetch failed: ${e}`);
    const script = `
      : > /work/oom-seen.txt
      for i in $(seq 600); do
        for d in /proc/[0-9]*; do
          c=$(cat "$d/comm" 2>/dev/null) || continue
          grep -qx "$c" /work/oom-seen.txt || echo "$c" >> /work/oom-seen.txt
          # The AppImage's launcher runs OpenSCAD under the name AppRun.
          case "$c" in openscad|AppRun) ;; *) continue ;; esac
          score=$(cat "$d/oom_score_adj" 2>/dev/null) || continue
          for n in /proc/[0-9]*; do
            # Node names its main thread "node-MainThread" in comm.
            case "$(cat "$n/comm" 2>/dev/null)" in node*) ;; *) continue ;; esac
            [ "$(sed -n 's/^PPid:[[:space:]]*//p' "$n/status" 2>/dev/null)" = 1 ] || continue
            echo "openscad=$score server=$(cat "$n/oom_score_adj")"
            exit 0
          done
        done
        sleep 0.05
      done
      echo "no openscad process seen; names seen: $(tr '\\n' ' ' < /work/oom-seen.txt)"
      exit 1`;
    // slicer.exec blocks this process, so let the request go out first; the
    // server renders while the shell below looks.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const seen = slicer.exec(["sh", "-c", script]);
    const rendered = await render;
    expect(
      { seen: seen.stdout.trim(), rendered, log: slicer.logs().slice(-1500) },
      "the OOM scores, the render's answer and the server's log",
    ).toMatchObject({ seen: "openscad=1000 server=0", rendered: "200" });
  });
});
