// Classifies each plate's slice and applies Jon's pass rule (2026-11-07):
// every plate gets a time and a weight above zero, or is refused for a reason
// AC-034 treats as legitimate (process not compatible, machine not supported,
// bed too small, nozzle or extruder mismatch), which is reported. A crash, a
// timeout or an unexplained slicer error on any plate fails the gate.
//
// Return codes are OrcaSlicer v2.5.0's, from src/libslic3r/Utils.hpp, with the
// messages from src/OrcaSlicer.cpp cli_errors.
//
// The plan's reason map (slicer contract v1) sends -61 to -69 to
// nozzle_mismatch, but in Orca only -66 and -68 are about extruders; -61 to
// -65, -67 and -69 are bed type, temperature, collisions, vase mode, TPU count
// and mixed filament. Those codes, and -50 (empty plate), are neither a
// legitimate AC-034 refusal by Orca's own meaning nor an unexplained error, so
// the gate reports them as needs-decision for Jon instead of passing or
// failing them silently.

export const CODES = Object.freeze({
  0: "success",
  [-1]: "environment error",
  [-2]: "invalid parameters",
  [-3]: "input file not found",
  [-4]: "file list in the wrong order",
  [-5]: "preset file invalid",
  [-6]: "model file cannot be parsed",
  [-7]: "printer technology not FDM",
  [-8]: "unsupported CLI instruction",
  [-14]: "out of memory",
  [-15]: "the selected printer is not supported",
  [-16]: "the selected printer is not compatible with the 3mf",
  [-17]: "the selected printer is not compatible with the process preset in the 3mf",
  [-18]: "invalid values in the 3mf",
  [-19]: "post-processing not supported",
  [-20]: "the selected printer's bed is smaller than the print profile's",
  [-23]: "modified printer parameter in the 3mf",
  [-24]: "unsupported 3MF version",
  [-25]: "failed exporting statistics",
  [-50]: "the plate has nothing to slice",
  [-51]: "incorrect slicing parameters in the 3mf",
  [-52]: "objects partly outside the bed",
  [-58]: "slicing time of a plate exceeds the limit",
  [-59]: "triangle count exceeds the limit",
  [-61]: "filaments not compatible with the plate type",
  [-62]: "filament temperatures too far apart",
  [-63]: "object collision in print-by-object mode",
  [-64]: "object collision",
  [-65]: "parameters not valid for spiral vase mode",
  [-66]: "filaments cannot be mapped to extruders",
  [-67]: "two or more TPU filaments",
  [-68]: "filaments not supported by the mapped extruder",
  [-69]: "mixed filament invalid",
  [-100]: "slicing failed",
  [-101]: "G-code path conflicts",
  [-102]: "G-code in an unprintable area of a multi-extruder printer",
});

const LEGITIMATE = new Map([
  [-15, "machine_not_supported"],
  [-16, "machine_not_supported"],
  [-17, "process_not_compatible"],
  [-20, "bed_too_small"],
  [-52, "bed_too_small"],
  [-102, "bed_too_small"],
  [-66, "nozzle_mismatch"],
  [-68, "nozzle_mismatch"],
]);

const NEEDS_DECISION = new Set([-50, -61, -62, -63, -64, -65, -67, -69]);

/** The reason the plan's slicer contract v1 map gives a return code. */
export function planReason(code) {
  if (code === -16) return "machine_not_supported";
  if (code === -17) return "process_not_compatible";
  if (code === -52 || code === -102) return "bed_too_small";
  if (code <= -61 && code >= -69) return "nozzle_mismatch";
  if (code === -58) return "timeout";
  return "slicer_error";
}

function meaningOf(code) {
  return CODES[code] ?? `return code ${code}`;
}

/** Parses GNU time -v output. Missing values are null. */
export function parseTimeV(text) {
  const out = { wallSeconds: null, peakRssBytes: null, exitStatus: null, signal: null };
  const wall = /Elapsed \(wall clock\) time(?: \([^)]*\))?:\s*([\d:.]+)/.exec(text);
  if (wall) {
    out.wallSeconds = wall[1]
      .split(":")
      .map(Number)
      .reduce((acc, v) => acc * 60 + v, 0);
    out.wallSeconds = Math.round(out.wallSeconds * 100) / 100;
  }
  const rss = /Maximum resident set size \(kbytes\):\s*(\d+)/.exec(text);
  if (rss) out.peakRssBytes = Number(rss[1]) * 1024;
  const exit = /Exit status:\s*(\d+)/.exec(text);
  if (exit) out.exitStatus = Number(exit[1]);
  const sig = /Command terminated by signal (\d+)/.exec(text);
  if (sig) out.signal = Number(sig[1]);
  return out;
}

/**
 * r: { returnCode (from result.json, or null), errorString, timeSeconds,
 *      weightGrams, exitStatus, signal, timedOut, hostKilled }
 * Returns { verdict: ok|refused|needs-decision|fail, reason, planReason, meaning }.
 */
export function classifyPlate(r) {
  const code = r.returnCode ?? null;
  const base = { planReason: code === null ? null : planReason(code), meaning: code === null ? "" : meaningOf(code) };
  if (r.timedOut || r.hostKilled) {
    return { ...base, verdict: "fail", reason: "timeout", meaning: r.hostKilled ? "killed by the external backstop" : "killed at the external 900 s cap" };
  }
  if (code === null) {
    return { ...base, verdict: "fail", reason: "crash", meaning: `no result.json; exit ${r.exitStatus ?? "unknown"}${r.signal ? `, signal ${r.signal}` : ""}` };
  }
  if (code === 0) {
    if ((r.signal ?? null) !== null || (r.exitStatus ?? 0) > 128) {
      return { ...base, verdict: "fail", reason: "crash", meaning: `numbers written, then the slicer exited with ${r.exitStatus ?? `signal ${r.signal}`}` };
    }
    if ((r.timeSeconds ?? 0) > 0 && (r.weightGrams ?? 0) > 0) return { ...base, verdict: "ok", reason: "ok" };
    return { ...base, verdict: "fail", reason: "no_numbers", meaning: "slicer reported success without a time and a weight above zero" };
  }
  if (code === -58) return { ...base, verdict: "fail", reason: "timeout" };
  if (LEGITIMATE.has(code)) return { ...base, verdict: "refused", reason: LEGITIMATE.get(code) };
  if (NEEDS_DECISION.has(code)) return { ...base, verdict: "needs-decision", reason: "not_in_ac034_list" };
  return { ...base, verdict: "fail", reason: "slicer_error" };
}

/**
 * PASS, FAIL or NEEDS-DECISION over classified plates. No plates means
 * nothing was sliced, so the gate could not run (COULD-NOT-RUN), not FAIL.
 */
export function gateVerdict(classified) {
  if (classified.length === 0) return "COULD-NOT-RUN";
  if (classified.some((c) => c.verdict === "fail")) return "FAIL";
  if (classified.some((c) => c.verdict === "needs-decision")) return "NEEDS-DECISION";
  return "PASS";
}

export function pctDiff(estimate, reference) {
  if (typeof estimate !== "number" || typeof reference !== "number" || reference === 0) return null;
  return Math.round(((estimate - reference) / reference) * 10000) / 100;
}

/** Count, median and worst (largest magnitude, sign kept) of a list of numbers. */
export function summarise(values) {
  const v = values.filter((x) => typeof x === "number" && Number.isFinite(x));
  if (v.length === 0) return { count: 0, median: null, worst: null };
  const sorted = [...v].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const worst = v.reduce((w, x) => (Math.abs(x) > Math.abs(w) ? x : w), v[0]);
  return { count: v.length, median, worst };
}

const GiB = 2 ** 30;

/**
 * Proposed AC-035 limits from the measured worst case (report item d). The
 * rule is mechanical and stated in the report: memory is 1.5x the worst peak
 * RSS rounded up to a whole GiB (at least 2g); SLICE_PLATE_SECONDS is twice
 * the worst wall time rounded up to 30 s (at least 120); tmpfs is twice the
 * worst job's input plus scratch, rounded up to a whole GiB (at least 1g).
 * CPU stays at the 4 the gate ran with; the gate does not vary it.
 */
export function proposeLimits(jobs) {
  const worst = (key) => jobs.reduce((m, j) => Math.max(m, j[key] ?? 0), 0);
  const worstRss = worst("peakRssBytes");
  const worstWall = worst("wallSeconds");
  const worstDisk = jobs.reduce((m, j) => Math.max(m, (j.workBytes ?? 0) + (j.inputBytes ?? 0)), 0);
  return {
    cpus: 4,
    memory: `${Math.max(2, Math.ceil((worstRss * 1.5) / GiB))}g`,
    slicePlateSeconds: Math.max(120, Math.ceil((worstWall * 2) / 30) * 30),
    tmpfs: `${Math.max(1, Math.ceil((worstDisk * 2) / GiB))}g`,
    measured: { worstPeakRssBytes: worstRss, worstWallSeconds: worstWall, worstInputPlusScratchBytes: worstDisk },
  };
}
