// OpenSCAD renders (AC-052, build plan Task 11): POST /v1/scad/stl and
// /v1/scad/png. The .scad text is written alone into a fresh job folder and
// OpenSCAD 2026.11-RC0 renders it under landrun (see sandbox.ts), with no
// network in the container, a time cap and OPENSCADPATH unset. A render that
// fails answers with the tail of OpenSCAD's own stderr.
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { landrunArgs, runGroup, type ScadOutput, scadArgs, tailLines } from "./sandbox.js";

export interface ScadConfig {
  landrunBin: string;
  openscadBin: string;
  openscadDir: string;
  scadTimeoutSeconds: number;
}

export type RenderResult =
  | { ok: true; bytes: Buffer }
  | {
      ok: false;
      /** What the caller shows: the tail of OpenSCAD's output, or why it stopped. */
      message: string;
      /** Everything captured from stderr and stdout (up to 64 KiB of each). */
      output: string;
    };

export async function renderScad(
  config: ScadConfig,
  dir: string,
  kind: ScadOutput,
  source: Buffer,
  track?: (kill: (() => void) | null) => void,
): Promise<RenderResult> {
  const input = "input.scad";
  const outputName = `output.${kind}`;
  writeFileSync(join(dir, input), source);
  const command = [config.openscadBin, ...scadArgs(kind, input, outputName)];
  const run = await runGroup(
    config.landrunBin,
    landrunArgs({ dir, openscadDir: config.openscadDir, command }),
    {
      cwd: dir,
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: dir, TMPDIR: dir, LANG: "C.UTF-8" },
      timeoutMs: config.scadTimeoutSeconds * 1000,
      ...(track ? { track } : {}),
    },
  );
  const output = `${run.stderrTail}\n${run.stdoutTail}`;
  if (run.timedOut) {
    return {
      ok: false,
      message: `OpenSCAD took longer than ${config.scadTimeoutSeconds} s and was stopped.`,
      output,
    };
  }
  const out = join(dir, outputName);
  if (run.code === 0 && existsSync(out) && statSync(out).size > 0) {
    return { ok: true, bytes: readFileSync(out) };
  }
  const message = tailLines(output);
  return {
    ok: false,
    message:
      message ||
      `OpenSCAD exited with ${run.signal ?? run.code} and wrote no ${kind.toUpperCase()}.`,
    output,
  };
}

export interface SandboxCheck {
  ok: boolean;
  detail: string;
}

/** OpenSCAD's warning for a file import() cannot open (src/io/import_stl.cc). */
const CANNOT_OPEN = "Can't open import file";

/**
 * Proves the sandbox works before a render runs. landrun runs best effort,
 * which would run OpenSCAD unsandboxed on a kernel without Landlock, so this
 * renders a .scad that imports `probe`, a file outside the job folder,
 * through the same landrun call a real render uses.
 *
 * The check passes only when OpenSCAD itself reports that it cannot open the
 * probe: "Can't open import file" naming the probe's path. Any other failure
 * (a timeout, a crash, landrun failing to start, a full /work) proves nothing
 * about the sandbox, so it fails the check as inconclusive. A missing probe
 * file fails it too: the import would fail for that reason alone.
 */
export async function sandboxSelfTest(
  config: ScadConfig,
  dir: string,
  probe: string,
): Promise<SandboxCheck> {
  if (!existsSync(probe) || statSync(probe).size === 0) {
    return {
      ok: false,
      detail: `the sandbox probe ${probe} is missing, so the sandbox cannot be checked`,
    };
  }
  const r = await renderScad(
    config,
    dir,
    "stl",
    Buffer.from(`import(${JSON.stringify(probe)});\n`),
  );
  if (r.ok) {
    return {
      ok: false,
      detail: `OpenSCAD read ${probe} from outside its job folder under landrun`,
    };
  }
  const paths = new Set([probe, realpathSync(probe)]);
  const refusal = r.output
    .split("\n")
    .find((line) => line.includes(CANNOT_OPEN) && [...paths].some((p) => line.includes(p)));
  if (refusal) {
    return { ok: true, detail: `landrun blocked a read of ${probe}: ${refusal.trim()}` };
  }
  return {
    ok: false,
    detail: `the check was inconclusive: OpenSCAD did not report that it could not open ${probe} (${r.message.split("\n").at(-1) ?? ""})`,
  };
}
