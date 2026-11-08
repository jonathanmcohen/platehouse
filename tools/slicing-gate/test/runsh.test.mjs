// Drives run.sh with stub docker and timeout commands on PATH, so the
// container flags, the one-container-per-plate loop, the host backstop and the
// guards are checked without Docker. The stubs log every docker call.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const RUN = join(dirname(fileURLToPath(import.meta.url)), "..", "run.sh");
const PARENT = "/tmp/platehouse-gate";
const parentExisted = existsSync(PARENT);
const made = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
  if (!parentExisted) rmSync(PARENT, { recursive: true, force: true });
});

const DOCKER = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_LOG"
case "$1" in
  build) exit "\${STUB_BUILD_RC:-0}" ;;
  info|kill|rm) exit 0 ;;
  image) [ "$2" = inspect ] && exit "\${STUB_IMAGE_MISSING:-0}"; exit 0 ;;
  images) exit 0 ;;
  run)
    out=""
    for a in "$@"; do case "$a" in *:/out:rw) out="\${a%%:/out:rw}" ;; esac; done
    for a in "$@"; do last2="$last1"; last1="$a"; done
    case "$last2" in
      plan) printf 'j0001\\nj0002\\n' > "$out/jobs.txt"; exit 0 ;;
      checks) exit 0 ;;
      report) exit "\${STUB_VERDICT:-0}" ;;
      slice) [ "$last1" = j0001 ] && [ -n "\${STUB_SLICE1_RC:-}" ] && exit "$STUB_SLICE1_RC"; [ "$last1" = j0002 ] && exit 124; exit 0 ;;
    esac
    case "$last1" in
      plan) [ -n "\${STUB_PLAN_RC:-}" ] && exit "$STUB_PLAN_RC"; printf 'j0001\\nj0002\\n' > "$out/jobs.txt"; exit 0 ;;
      checks) exit 0 ;;
      report) exit "\${STUB_VERDICT:-0}" ;;
    esac
    exit 0 ;;
esac
exit 0
`;
// Drops timeout's own options and runs the command, like a timeout that never fires.
const TIMEOUT = `#!/usr/bin/env bash
while [ $# -gt 0 ]; do case "$1" in --*|-s) [ "$1" = -s ] && shift; shift ;; [0-9]*) shift; break ;; *) break ;; esac; done
exec "$@"
`;

function stubs() {
  const dir = mkdtempSync(join(tmpdir(), "gate-stub-"));
  made.push(dir);
  writeFileSync(join(dir, "docker"), DOCKER);
  writeFileSync(join(dir, "timeout"), TIMEOUT);
  chmodSync(join(dir, "docker"), 0o755);
  chmodSync(join(dir, "timeout"), 0o755);
  return dir;
}

function gateDir() {
  mkdirSync(PARENT, { recursive: true });
  const dir = mkdtempSync(join(PARENT, "test-"));
  made.push(dir);
  mkdirSync(join(dir, "in", "sample"), { recursive: true });
  writeFileSync(join(dir, "in", "selection.json"), "{}");
  return dir;
}

function run(args, { gate, stubDir, extra = {} }) {
  const log = join(stubDir, "log.txt");
  const r = spawnSync("bash", [RUN, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}`, GATE_DIR: gate, STUB_LOG: log, ...extra },
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  return { ...r, calls };
}

test("run.sh runs plan, one container per plate, checks and report with Task 1's limits", () => {
  const stubDir = stubs();
  const gate = gateDir();
  const r = run([], { gate, stubDir, extra: { STUB_VERDICT: "3" } });
  assert.equal(r.status, 3, r.stderr);
  const uid = String(process.getuid());
  const gid = String(process.getgid());
  const flags =
    `--rm --network none --cpus 4 --memory 8g --memory-swap 8g --read-only --tmpfs /work:rw,size=4g,mode=1777 ` +
    `--cap-drop ALL --security-opt no-new-privileges:true --user ${uid}:${gid} ` +
    `--volume ${gate}/in:/in:ro --volume ${gate}/out:/out:rw platehouse-gate:t1 node /opt/gate/gate.mjs`;
  assert.ok(r.calls.includes(`run ${flags} plan`), r.calls.join("\n"));
  assert.ok(r.calls.includes(`run --name platehouse-gate-j0001 ${flags} slice j0001`));
  assert.ok(r.calls.includes(`run --name platehouse-gate-j0002 ${flags} slice j0002`));
  assert.equal(r.calls.filter((c) => c.includes(" slice ")).length, 2);
  assert.ok(r.calls.includes("kill platehouse-gate-j0002"), "a backstop timeout kills the container");
  assert.ok(!r.calls.includes("kill platehouse-gate-j0001"));
  assert.ok(r.calls.includes(`run ${flags} checks`));
  assert.ok(r.calls.includes(`run ${flags} report`));
  assert.ok(!r.calls.some((c) => c.startsWith("build")), "an existing image is not rebuilt");
  assert.equal(readFileSync(join(gate, "out", "host-exit.tsv"), "utf8"), "j0001\t0\nj0002\t124\n");
});

test("run.sh builds the image when it is missing or --build is given", () => {
  const stubDir = stubs();
  const r = run([], { gate: gateDir(), stubDir, extra: { STUB_IMAGE_MISSING: "1" } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.calls.some((c) => c.startsWith("build --platform linux/amd64 -t platehouse-gate:t1 ")));
  const r2 = run(["--build"], { gate: gateDir(), stubDir: stubs() });
  assert.ok(r2.calls.some((c) => c.startsWith("build ")));
});

test("run.sh exits 2, not FAIL, when the image build fails", () => {
  const stubDir = stubs();
  const r = run(["--build"], { gate: gateDir(), stubDir, extra: { STUB_BUILD_RC: "1" } });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /image build failed/);
  assert.ok(!r.calls.some((c) => c.startsWith("run ")), "nothing runs after a failed build");
});

test("run.sh exits 2 when the plan step fails, whatever docker run returned", () => {
  for (const rc of ["1", "125"]) {
    const stubDir = stubs();
    const r = run([], { gate: gateDir(), stubDir, extra: { STUB_PLAN_RC: rc } });
    assert.equal(r.status, 2, `docker run ${rc}: ${r.stderr}`);
    assert.match(r.stderr, /plan step failed/);
    assert.ok(!r.calls.some((c) => c.includes(" slice ")), "no plate runs after a failed plan");
  }
});

test("run.sh passes the report's own exit codes 0 to 3 through", () => {
  for (const rc of [0, 1, 2, 3]) {
    const r = run([], { gate: gateDir(), stubDir: stubs(), extra: { STUB_VERDICT: String(rc) } });
    assert.equal(r.status, rc, `report ${rc}: ${r.stderr}`);
  }
});

test("run.sh exits 2 when docker fails the report step, not with docker's own code", () => {
  for (const rc of ["125", "137"]) {
    const r = run([], { gate: gateDir(), stubDir: stubs(), extra: { STUB_VERDICT: rc } });
    assert.equal(r.status, 2, `docker run ${rc}: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`report step failed \\(exit ${rc}\\)`));
  }
});

test("run.sh exits 2, not FAIL, when docker cannot start a plate's container", () => {
  const stubDir = stubs();
  const gate = gateDir();
  const r = run([], { gate, stubDir, extra: { STUB_SLICE1_RC: "125" } });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /could not start the container for j0001 \(exit 125\)/);
  assert.ok(!r.calls.some((c) => c.endsWith(" report")), "no report is written as an Orca result");
  assert.equal(readFileSync(join(gate, "out", "host-exit.tsv"), "utf8"), "j0001\t125\n");
});

// gate.mjs slice exits 0 whatever Orca did (Orca's code goes in the job record)
// and 2 only when its own command fails; 126 and 127 mean the container could
// not run the command at all. None of them is a slicer result.
test("run.sh exits 2, not FAIL, when a plate's container exits 2, 126 or 127", () => {
  for (const rc of ["2", "126", "127"]) {
    const gate = gateDir();
    const r = run([], { gate, stubDir: stubs(), extra: { STUB_SLICE1_RC: rc } });
    assert.equal(r.status, 2, `slice container ${rc}: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`slice for j0001 could not run \\(exit ${rc}\\); the gate could not run`));
    assert.ok(!r.calls.some((c) => c.includes(" slice j0002")), `no further plate runs after ${rc}`);
    assert.ok(!r.calls.some((c) => c.endsWith(" report")), `no report is written as an Orca result after ${rc}`);
    assert.equal(readFileSync(join(gate, "out", "host-exit.tsv"), "utf8"), `j0001\t${rc}\n`);
  }
});

test("run.sh refuses a non-empty output dir, a GATE_DIR outside /tmp/platehouse-gate, and missing inputs", () => {
  const stubDir = stubs();
  const gate = gateDir();
  assert.equal(run([], { gate, stubDir }).status, 0);
  const again = run([], { gate, stubDir });
  assert.equal(again.status, 2);
  assert.match(again.stderr, /not empty/);
  const outside = run([], { gate: "/var/tmp/elsewhere", stubDir });
  assert.equal(outside.status, 2);
  assert.match(outside.stderr, /GATE_DIR must be/);
  const bare = gateDir();
  rmSync(join(bare, "in", "selection.json"));
  assert.match(run([], { gate: bare, stubDir }).stderr, /selection\.json/);
});

test("run.sh --clean deletes the scratch dir and the image and verifies", () => {
  const stubDir = stubs();
  const gate = gateDir();
  const r = run(["--clean"], { gate, stubDir });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(gate), false);
  assert.ok(r.calls.includes("image rm platehouse-gate:t1"));
  assert.match(r.stdout, /neither remains/);
});
