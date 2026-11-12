// Stub programs for the slicer's unit tests: a fake OrcaSlicer CLI, a fake
// GNU time, a fake landrun and a fake STEP worker. The server runs them
// exactly as it runs the real ones, so these tests cover the request
// handling, the arguments, the mutex and the kill; the container tests cover
// the real programs.
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function stubDir(): string {
  return mkdtempSync(join(tmpdir(), "slicer-stub-"));
}

function writeScript(file: string, body: string): string {
  writeFileSync(file, body);
  chmodSync(file, 0o755);
  return file;
}

export type OrcaMode =
  | { kind: "ok"; time: number; weight: number; grams: number[] }
  | { kind: "result"; code: number; error: string }
  | { kind: "crash"; exit: number }
  | { kind: "noStats" }
  | { kind: "sleep" };

/**
 * A fake orca-slicer. It writes every argument, one per line, to args.log in
 * its own folder, then acts out the mode: "sleep" writes its pid and its
 * child's pid to pids.txt and waits for a kill.
 */
export function fakeOrca(
  dir: string,
  mode: OrcaMode,
): { bin: string; argsLog: string; pids: string } {
  const argsLog = join(dir, "args.log");
  const pids = join(dir, "pids.txt");
  const head = `#!/bin/sh
: > '${argsLog}'
for a in "$@"; do printf '%s\\n' "$a" >> '${argsLog}'; done
out=""; plate=""
while [ $# -gt 0 ]; do
  case "$1" in
    --outputdir) out="$2"; shift ;;
    --slice) plate="$2"; shift ;;
  esac
  shift
done
`;
  let body: string;
  switch (mode.kind) {
    case "ok": {
      const filaments = mode.grams
        .map((g, i) => `{"id":${i + 1},"weight":${g},"volume":1}`)
        .join(",");
      body = `printf '{"return_code":0,"error_string":"Success."}' > "$out/result.json"
printf '{"version":1,"summary":{"time":${mode.time},"weight":${mode.weight},"filaments":[${filaments}]}}' > "$out/plate_$plate.statistics.json"
exit 0
`;
      break;
    }
    case "result":
      body = `printf '%s' '${JSON.stringify({ return_code: mode.code, error_string: mode.error })}' > "$out/result.json"
exit 1
`;
      break;
    case "crash":
      body = `echo 'Segmentation fault' >&2
exit ${mode.exit}
`;
      break;
    case "noStats":
      body = `printf '{"return_code":0,"error_string":"Success."}' > "$out/result.json"
exit 0
`;
      break;
    case "sleep":
      body = `sleep 30 &
child=$!
printf '%s %s\\n' "$$" "$child" > '${pids}'
wait
`;
      break;
  }
  return { bin: writeScript(join(dir, "orca"), head + body), argsLog, pids };
}

/** A fake GNU time: "-v -o FILE cmd ..." runs cmd and writes time -v lines to FILE. */
export function fakeTime(dir: string): string {
  return writeScript(
    join(dir, "time"),
    `#!/bin/sh
shift
shift
out="$1"
shift
"$@"
st=$?
printf '\\tMaximum resident set size (kbytes): 2048\\n\\tExit status: %s\\n' "$st" > "$out"
exit $st
`,
  );
}

/**
 * How the fake landrun answers the server's sandbox self-test (a .scad that
 * imports the sandbox probe):
 * - "blocked": a working sandbox. OpenSCAD's own warning naming the probe.
 * - "read": no sandbox. The import works and the render succeeds.
 * - "other": the render fails for a reason that proves nothing about the
 *   sandbox (here landrun failing to start).
 * - "hang": the render runs past the time cap and is killed.
 */
export type ProbeMode = "blocked" | "read" | "other" | "hang";

/**
 * The kernel's Landlock ABI as the fake landrun reports it when it runs
 * without --best-effort (the self-test's ABI check). landrun v0.1.17 then asks
 * for ABI 9: on an older kernel it refuses with go-landlock's "Got Landlock
 * ABI vN" message and exits 1, and from ABI 9 on it runs the command.
 * "garbled" fails with a message that names no ABI.
 */
export type AbiMode = number | "garbled";

/**
 * A fake landrun. It writes its arguments to landrun.log, then, for the
 * command after "--", writes the file named by -o (or fails like OpenSCAD).
 * setProbe changes how it answers the self-test from the next run on, and
 * setAbi the Landlock ABI it reports (default 8, GitHub's runner). A run
 * without --best-effort is the ABI check: it is counted in landrun-abi.log,
 * not in landrun.log or landrun-runs.log. "big" writes a sparse output file of
 * `bytes` bytes, so a test can pass the render output cap without filling the
 * disk. "fsize" acts out prlimit's file-size limit: it writes part of the
 * output, then dies of SIGXFSZ, as the kernel kills a program that writes
 * past RLIMIT_FSIZE.
 */
export function fakeLandrun(
  dir: string,
  mode:
    | { kind: "ok"; content: string }
    | { kind: "fail"; stderr: string }
    | { kind: "big"; bytes: number }
    | { kind: "fsize" },
  opts: { probe?: ProbeMode; abi?: AbiMode } = {},
): {
  bin: string;
  argsLog: string;
  runsLog: string;
  abiLog: string;
  setProbe: (probe: ProbeMode) => void;
  setAbi: (abi: AbiMode) => void;
} {
  const argsLog = join(dir, "landrun.log");
  const runsLog = join(dir, "landrun-runs.log");
  const abiLog = join(dir, "landrun-abi.log");
  const probeFile = join(dir, "landrun-probe-mode");
  const abiFile = join(dir, "landrun-abi-mode");
  const setProbe = (probe: ProbeMode) => writeFileSync(probeFile, probe);
  const setAbi = (abi: AbiMode) => writeFileSync(abiFile, String(abi));
  setProbe(opts.probe ?? "blocked");
  setAbi(opts.abi ?? 8);
  let tail: string;
  switch (mode.kind) {
    case "ok":
      tail = `printf '%s' '${mode.content}' > "$out"
exit 0
`;
      break;
    case "fail":
      tail = `printf '%s\\n' '${mode.stderr}' >&2
exit 1
`;
      break;
    case "big":
      tail = `dd if=/dev/zero of="$out" bs=1 count=1 seek=${mode.bytes - 1} 2>/dev/null
exit 0
`;
      break;
    case "fsize":
      tail = `printf 'solid partial' > "$out"
kill -XFSZ $$
exit 1
`;
      break;
  }
  // landrun v0.1.17 without --best-effort, as it fails on an older kernel
  // (internal/log, go-landlock restrict.go).
  const abiCheck = `strict=yes
for a in "$@"; do [ "$a" = "--best-effort" ] && strict=no; done
if [ "$strict" = yes ]; then
  printf 'run\\n' >> '${abiLog}'
  abi=$(cat '${abiFile}')
  case "$abi" in
    garbled)
      printf '%s\\n' '[landrun:error] 2026/11/11 00:00:00 something else went wrong' >&2
      exit 1 ;;
  esac
  if [ "$abi" -ge 9 ]; then exit 0; fi
  printf '[landrun:error] 2026/11/11 00:00:00 Failed to apply sandbox: failed to apply Landlock restrictions: missing kernel Landlock support. Got Landlock ABI v%s, wanted {Landlock V9; FS: all; Net: all; Scoped: all}\\n' "$abi" >&2
  exit 1
fi
`;
  // A .scad that imports the sandbox probe is the server's self-test.
  // OpenSCAD reports a file it cannot open (src/io/import_stl.cc) as
  // "WARNING: Can't open import file '<path>', import() at line <n>".
  const probe = `if grep -q sandbox-probe "$input"; then
  path=$(sed -n 's/^import("\\(.*\\)");$/\\1/p' "$input")
  case "$(cat '${probeFile}')" in
    blocked)
      printf "WARNING: Can't open import file '%s', import() at line 1\\n" "$path" >&2
      exit 1 ;;
    other)
      printf '%s\\n' 'landrun: failed to start: operation not permitted' >&2
      exit 1 ;;
    hang)
      sleep 30
      exit 1 ;;
  esac
fi
`;
  const bin = writeScript(
    join(dir, "landrun"),
    `#!/bin/sh
${abiCheck}printf 'run\\n' >> '${runsLog}'
input=""
for a in "$@"; do input="$a"; done
if ! grep -q sandbox-probe "$input" 2>/dev/null; then
  : > '${argsLog}'
  for a in "$@"; do printf '%s\\n' "$a" >> '${argsLog}'; done
fi
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-o" ]; then out="$2"; fi
  shift
done
${probe}${tail}`,
  );
  return { bin, argsLog, runsLog, abiLog, setProbe, setAbi };
}

/**
 * A fake prlimit: "prlimit LIMITS... -- cmd ..." writes every argument of
 * its latest run, one per line, to prlimit.log, then runs cmd in its place,
 * as prlimit does once it has set the limits.
 */
export function fakePrlimit(dir: string): { bin: string; argsLog: string } {
  const argsLog = join(dir, "prlimit.log");
  const bin = writeScript(
    join(dir, "prlimit"),
    `#!/bin/sh
: > '${argsLog}'
for a in "$@"; do printf '%s\\n' "$a" >> '${argsLog}'; done
while [ $# -gt 0 ]; do
  if [ "$1" = "--" ]; then shift; break; fi
  shift
done
exec "$@"
`,
  );
  return { bin, argsLog };
}

/**
 * A fake STEP worker module: node worker.mjs <in> <out>. "echo" copies the
 * input to the output; "slow" appends "start" and "end" lines to `log`
 * around a wait of `ms`, so a test can see whether two conversions overlap.
 */
export function fakeStepWorker(
  dir: string,
  mode:
    | { kind: "ok"; content: string }
    | { kind: "fail"; stderr: string }
    | { kind: "echo" }
    | { kind: "slow"; log: string; ms: number },
): string {
  const file = join(dir, "step-worker.mjs");
  let body: string;
  switch (mode.kind) {
    case "ok":
      body = `import { writeFileSync } from "node:fs";
writeFileSync(process.argv[3], ${JSON.stringify(mode.content)});
`;
      break;
    case "fail":
      body = `process.stderr.write(${JSON.stringify(`${mode.stderr}\n`)});
process.exit(1);
`;
      break;
    case "echo":
      body = `import { copyFileSync } from "node:fs";
copyFileSync(process.argv[2], process.argv[3]);
`;
      break;
    case "slow":
      body = `import { appendFileSync, writeFileSync } from "node:fs";
appendFileSync(${JSON.stringify(mode.log)}, "start\\n");
await new Promise((r) => setTimeout(r, ${mode.ms}));
appendFileSync(${JSON.stringify(mode.log)}, "end\\n");
writeFileSync(process.argv[3], "glTF");
`;
      break;
  }
  writeFileSync(file, body);
  return file;
}
