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
 * A fake landrun. It writes its arguments to landrun.log, then, for the
 * command after "--", writes the file named by -o (or fails like OpenSCAD).
 * setProbe changes how it answers the self-test from the next run on.
 */
export function fakeLandrun(
  dir: string,
  mode: { kind: "ok"; content: string } | { kind: "fail"; stderr: string },
  opts: { probe?: ProbeMode } = {},
): { bin: string; argsLog: string; runsLog: string; setProbe: (probe: ProbeMode) => void } {
  const argsLog = join(dir, "landrun.log");
  const runsLog = join(dir, "landrun-runs.log");
  const probeFile = join(dir, "landrun-probe-mode");
  const setProbe = (probe: ProbeMode) => writeFileSync(probeFile, probe);
  setProbe(opts.probe ?? "blocked");
  const tail =
    mode.kind === "ok"
      ? `printf '%s' '${mode.content}' > "$out"
exit 0
`
      : `printf '%s\\n' '${mode.stderr}' >&2
exit 1
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
printf 'run\\n' >> '${runsLog}'
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
  return { bin, argsLog, runsLog, setProbe };
}

/** A fake STEP worker module: node worker.mjs <in> <out>. */
export function fakeStepWorker(
  dir: string,
  mode: { kind: "ok"; content: string } | { kind: "fail"; stderr: string },
): string {
  const file = join(dir, "step-worker.mjs");
  const body =
    mode.kind === "ok"
      ? `import { writeFileSync } from "node:fs";
writeFileSync(process.argv[3], ${JSON.stringify(mode.content)});
`
      : `process.stderr.write(${JSON.stringify(`${mode.stderr}\n`)});
process.exit(1);
`;
  writeFileSync(file, body);
  return file;
}
