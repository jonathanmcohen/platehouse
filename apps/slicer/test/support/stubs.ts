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
 * A fake landrun. It writes its arguments to landrun.log, then, for the
 * command after "--", writes the file named by -o (or fails like OpenSCAD).
 */
export function fakeLandrun(
  dir: string,
  mode: { kind: "ok"; content: string } | { kind: "fail"; stderr: string },
): { bin: string; argsLog: string } {
  const argsLog = join(dir, "landrun.log");
  const tail =
    mode.kind === "ok"
      ? `printf '%s' '${mode.content}' > "$out"
exit 0
`
      : `printf '%s\\n' '${mode.stderr}' >&2
exit 1
`;
  const bin = writeScript(
    join(dir, "landrun"),
    `#!/bin/sh
: > '${argsLog}'
for a in "$@"; do printf '%s\\n' "$a" >> '${argsLog}'; done
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-o" ]; then out="$2"; fi
  shift
done
${tail}`,
  );
  return { bin, argsLog };
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
