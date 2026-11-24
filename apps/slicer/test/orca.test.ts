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
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIMITS, slicerContract } from "@platehouse/slicer-contract";
import { afterEach, describe, expect, test } from "vitest";
import { cut, type SliceContext, sliceOutcome } from "../src/orca.js";
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
  writeFileSync(
    join(outDir, "result.json"),
    JSON.stringify({ return_code: code, error_string: error }),
  );
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
      contract: 2,
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

// Orca writes result.json and the statistics file in its own folder, which
// the sandbox lets it change, so they are read the way a render's output is
// (readOutputFile in sandbox.ts): never through a link, never a FIFO or
// other non-regular file, and never past a size cap. GNU time's report sits
// in the job folder above Orca's, out of Orca's reach, and is read the same
// way. A file that fails those checks fails the slice, at once.
describe("files Orca leaves are read only when they are small regular files", () => {
  const OK_RUN: GroupResult = {
    code: 0,
    signal: null,
    timedOut: false,
    wallMs: 10,
    stdoutTail: "",
    stderrTail: "",
  };
  const STATS = JSON.stringify({ summary: { time: 60, weight: 3, filaments: [] } });
  const TIME = "\tMaximum resident set size (kbytes): 2048\n";

  /** A job folder with Orca's out/ in its own folder and GNU time's report above it. */
  function job() {
    const dir = mkdtempSync(join(tmpdir(), "slicer-orca-job-"));
    dirs.push(dir);
    const outDir = join(dir, "orca", "out");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "result.json"), JSON.stringify({ return_code: 0 }));
    writeFileSync(join(outDir, "plate_1.statistics.json"), STATS);
    const timeFile = join(dir, "time.txt");
    writeFileSync(timeFile, TIME);
    return { dir, outDir, timeFile };
  }

  /** Replaces `file` with a FIFO, a link to /dev/zero, or a file one byte over `limit`. */
  function spoil(file: string, kind: "fifo" | "symlink" | "big", limit: number) {
    rmSync(file);
    if (kind === "fifo") expect(spawnSync("mkfifo", [file]).status).toBe(0);
    if (kind === "symlink") symlinkSync("/dev/zero", file);
    if (kind === "big") writeFileSync(file, Buffer.alloc(limit + 1, 32));
  }

  const outcomeOf = (j: { outDir: string; timeFile: string }) =>
    slicerContract.sliceResult.parse(sliceOutcome(CTX, OK_RUN, j));

  test("control: the same files, all regular and small, give an ok slice", () => {
    expect(outcomeOf(job())).toMatchObject({
      status: "ok",
      timeSeconds: 60,
      peakRssBytes: 2048 * 1024,
    });
  });

  const FILES = [
    {
      label: "result.json",
      path: (j: { outDir: string }) => join(j.outDir, "result.json"),
      limit: 64 * 1024,
      code: null,
      limitText: "64 KiB",
      name: "Orca's result.json",
    },
    {
      label: "the statistics file",
      path: (j: { outDir: string }) => join(j.outDir, "plate_1.statistics.json"),
      limit: 1024 * 1024,
      code: 0,
      limitText: "1 MiB",
      name: "Orca's plate_1.statistics.json",
    },
    {
      label: "GNU time's report",
      path: (j: { timeFile: string }) => j.timeFile,
      limit: 64 * 1024,
      code: 0,
      limitText: "64 KiB",
      name: "GNU time's report",
    },
  ] as const;

  for (const f of FILES) {
    test.each(["fifo", "symlink"] as const)(`${f.label} as a %s fails the slice unread`, (kind) => {
      const j = job();
      spoil(f.path(j as never), kind, f.limit);
      expect(outcomeOf(j)).toEqual({
        contract: 2,
        orca: "2.5.0",
        plate: 1,
        status: "failed",
        code: f.code,
        reason: "slicer_error",
        detail: `${f.name} was not a regular file, so it was not read.`,
      });
    });

    test(`${f.label} one byte over ${f.limitText} fails the slice unread`, () => {
      const j = job();
      spoil(f.path(j as never), "big", f.limit);
      expect(outcomeOf(j)).toMatchObject({
        status: "failed",
        code: f.code,
        reason: "slicer_error",
        detail: `${f.name} is over the ${f.limitText} limit, so it was not read.`,
      });
    });
  }

  test("an out/ that is a link, even to a folder with good files, fails the slice unread", () => {
    const j = job();
    const elsewhere = join(j.dir, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "result.json"), JSON.stringify({ return_code: 0 }));
    writeFileSync(join(elsewhere, "plate_1.statistics.json"), STATS);
    rmSync(j.outDir, { recursive: true });
    symlinkSync(elsewhere, j.outDir);
    expect(outcomeOf(j)).toMatchObject({
      status: "failed",
      code: null,
      reason: "slicer_error",
      detail: "Orca's output folder was not a folder, so nothing in it was read.",
    });
  });

  test("a missing out/ is a slice that wrote no result.json", () => {
    const j = job();
    rmSync(j.outDir, { recursive: true });
    const body = outcomeOf(j);
    expect(body).toMatchObject({ status: "failed", code: null, reason: "slicer_error" });
    expect(body.status === "failed" && body.detail).toMatch(/^Orca wrote no result\.json/);
  });
});

describe("cut", () => {
  test("never ends on a lone high surrogate", () => {
    const emoji = String.fromCodePoint(0x1f600);
    const text = `${"a".repeat(LIMITS.detailChars - 1)}${emoji}tail`;
    const out = cut(text);
    expect(out.length).toBeLessThanOrEqual(LIMITS.detailChars);
    const last = out.charCodeAt(out.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    expect(out).toBe("a".repeat(LIMITS.detailChars - 1));
  });

  test("keeps a whole emoji that fits", () => {
    const emoji = String.fromCodePoint(0x1f600);
    const text = `${"a".repeat(LIMITS.detailChars - 2)}${emoji}tail`;
    expect(cut(text)).toBe(`${"a".repeat(LIMITS.detailChars - 2)}${emoji}`);
  });
});
