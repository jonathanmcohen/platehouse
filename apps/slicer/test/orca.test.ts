// sliceOutcome on its own: how one Orca run and the result.json it left
// become the contract's answer. The server tests drive the same function
// through the stub programs; these cases set the exit status and signal
// directly, including a signal, which the stubs cannot give (the server
// runs Orca under GNU time, which turns a signal into an exit status).
//
// Orca 2.5.0 ends every refusal by recording its code in result.json and
// returning that code from main (record_exit_reson, then flush_and_exit, in
// src/OrcaSlicer.cpp at v2.5.0), so a clean refusal exits (256 + code) & 0xff:
// 239 for -17. GNU time 1.9 exits with its child's status, or 128 + the
// signal when the child was killed. So a refusal code with any other known
// status, or with a signal, means Orca crashed after it wrote the code.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slicerContract } from "@platehouse/slicer-contract";
import { afterEach, describe, expect, test } from "vitest";
import { type SliceContext, sliceOutcome } from "../src/orca.js";
import type { GroupResult } from "../src/sandbox.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const CTX: SliceContext = {
  orcaVersion: "2.5.0",
  plate: 1,
  printer: "Bambu Lab P1S 0.4 nozzle",
  process: null,
  filamentProfiles: [],
  projectFilaments: [],
  timeoutSeconds: 30,
};

/** The exit status of a clean exit with this return code. */
const clean = (code: number) => (code + 256) % 256;

/** sliceOutcome for a run that wrote this return code and ended with this status or signal. */
function outcome(
  code: number,
  end: { code: number | null; signal?: NodeJS.Signals | null },
  error = "",
) {
  const outDir = mkdtempSync(join(tmpdir(), "slicer-orca-"));
  dirs.push(outDir);
  writeFileSync(join(outDir, "result.json"), JSON.stringify({ return_code: code, error_string: error }));
  const run: GroupResult = {
    code: end.code,
    signal: end.signal ?? null,
    timedOut: false,
    wallMs: 10,
    stdoutTail: "",
    stderrTail: "",
  };
  return slicerContract.sliceResult.parse(
    sliceOutcome(CTX, run, { outDir, timeFile: join(outDir, "time.txt") }),
  );
}

describe("a non-zero return code", () => {
  // A clean exit with any code from -1 to -127 has a status from 129 to 255,
  // so here the rule cannot be "a status over 128 is a crash", as it is on
  // the code-0 path.
  test.each([
    [-17, "process_not_compatible"],
    [-16, "machine_not_supported"],
    [-52, "bed_too_small"],
    [-62, "filament_temperature"],
    [-101, "toolpath_conflict"],
    [-58, "timeout"],
    [-100, "slicer_error"],
    [-50, "slicer_error"],
  ] as const)("%i with its clean exit status keeps its reason, %s", (code, reason) => {
    const body = outcome(code, { code: clean(code) }, "Orca's text");
    expect(body).toEqual({
      contract: 1,
      orca: "2.5.0",
      plate: 1,
      status: "failed",
      code,
      reason,
      detail: "Orca's text",
    });
  });

  test("a refusal followed by exit 139 (a segfault under GNU time) is a crash, not a refusal", () => {
    const body = outcome(-17, { code: 139 }, "The selected printer is not compatible.");
    expect(body).toMatchObject({ status: "failed", code: -17, reason: "slicer_error" });
    expect(body.status === "failed" && body.detail).toBe(
      "Orca wrote return code -17 (the selected printer is not compatible with the process preset in the 3mf), then exited with 139",
    );
  });

  test("a refusal followed by a signal is a crash, not a refusal", () => {
    const body = outcome(-66, { code: null, signal: "SIGSEGV" });
    expect(body).toMatchObject({ status: "failed", code: -66, reason: "slicer_error" });
    expect(body.status === "failed" && body.detail).toBe(
      "Orca wrote return code -66 (filaments cannot be mapped to extruders), then was killed by SIGSEGV",
    );
  });

  test("a refusal with another status a clean exit would not give is a crash", () => {
    // -101 exits 155 when clean, never 1.
    const body = outcome(-101, { code: 1 });
    expect(body).toMatchObject({ status: "failed", code: -101, reason: "slicer_error" });
    expect(body.status === "failed" && body.detail).toMatch(/then exited with 1$/);
  });

  test("an unknown exit status with no signal is no evidence of a crash", () => {
    const body = outcome(-17, { code: null });
    expect(body).toMatchObject({ status: "failed", code: -17, reason: "process_not_compatible" });
  });
});
