// OpenSCAD renders (AC-052, build plan Task 11): POST /v1/scad/stl and
// /v1/scad/png. The .scad text is written alone into a fresh job folder and
// OpenSCAD 2026.11-RC0 renders it under landrun (see sandbox.ts), with no
// network in the container, a time cap and OPENSCADPATH unset. A render that
// fails answers with the tail of OpenSCAD's own stderr.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { landrunArgs, runGroup, type ScadOutput, scadArgs, tailLines } from "./sandbox.js";

export interface ScadConfig {
  landrunBin: string;
  openscadBin: string;
  openscadDir: string;
  scadTimeoutSeconds: number;
}

export type RenderResult = { ok: true; bytes: Buffer } | { ok: false; message: string };

export async function renderScad(
  config: ScadConfig,
  dir: string,
  kind: ScadOutput,
  source: Buffer,
  track?: (kill: (() => void) | null) => void,
): Promise<RenderResult> {
  const input = "input.scad";
  const output = `output.${kind}`;
  writeFileSync(join(dir, input), source);
  const command = [config.openscadBin, ...scadArgs(kind, input, output)];
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
  if (run.timedOut) {
    return {
      ok: false,
      message: `OpenSCAD took longer than ${config.scadTimeoutSeconds} s and was stopped.`,
    };
  }
  const out = join(dir, output);
  if (run.code === 0 && existsSync(out) && statSync(out).size > 0) {
    return { ok: true, bytes: readFileSync(out) };
  }
  const message = tailLines(`${run.stderrTail}\n${run.stdoutTail}`);
  return {
    ok: false,
    message:
      message ||
      `OpenSCAD exited with ${run.signal ?? run.code} and wrote no ${kind.toUpperCase()}.`,
  };
}
