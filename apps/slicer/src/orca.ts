// One plate through the OrcaSlicer 2.5.0 CLI, one plate per request, the way
// the slicing gate's gate.mjs slice step ran 332 plates:
//
//   orca --datadir <job>/data --slice <plate> --export-statistics
//        --mstpp <SLICE_PLATE_SECONDS> --allow-newer-file --outputdir <job>/out
//        --load-settings <flattened machine preset>
//        [--load-filaments <the printer's default per slot, "" keeps the file's own>]
//        <job>/input.3mf
//
// A plate whose objects sit off the printer's bed (a project saved for a
// bigger one) makes Orca answer -50. By code -50 is still slicer_error here
// (sliceOutcome), but slice() answers bed_too_small when the run was a clean
// refusal and the plate has objects (isCleanOffBed, bedTooSmall).
//
// Only the machine preset goes in --load-settings, so the file's own process
// is kept unless Orca refuses the switch (gate item c). The numbers come from
// Orca's per-plate statistics JSON (src/libslic3r/GCode/GCodeStatistics.cpp
// at 40ecc66: summary.time, summary.weight, summary.filaments[].id, 1-based,
// and .weight); the return code from result.json. Orca checks --mstpp only
// after a plate finishes (OrcaSlicer.cpp), so the server also kills the
// plate's process group at SLICE_TIMEOUT_SECONDS.
import {
  CONTRACT_VERSION,
  LIMITS,
  type Reason,
  type SliceResult,
} from "@platehouse/slicer-contract";
import { type OutFolder, openOutFolder } from "./out-folder.js";
import { orcaMessage, reasonFor } from "./reasons.js";
import { type GroupResult, readOutputFile } from "./sandbox.js";

// Both live in orca-env.ts, which sandbox.ts imports, so this file and sandbox.ts
// do not import each other; they stay importable from here.
export { launcherEnv, scratchEnv } from "./orca-env.js";

export interface OrcaJob {
  plate: number;
  mstpp: number;
  dataDir: string;
  outDir: string;
  machineFile: string;
  /** One entry per project filament slot; "" keeps the file's own filament. */
  filamentFiles: string[];
  input: string;
}

export function orcaArgs(job: OrcaJob): string[] {
  const args = [
    "--datadir",
    job.dataDir,
    "--slice",
    String(job.plate),
    "--export-statistics",
    "--mstpp",
    String(job.mstpp),
    "--allow-newer-file",
    "--outputdir",
    job.outDir,
    "--load-settings",
    job.machineFile,
  ];
  if (job.filamentFiles.some((f) => f !== "")) {
    args.push("--load-filaments", job.filamentFiles.join(";"));
  }
  args.push(job.input);
  return args;
}

/**
 * Orca's refusal for a plate with nothing on its bed, which is what a plate
 * whose objects sit off a smaller printer's bed gets.
 */
export const OFF_BED_CODE = -50;

export const TOO_BIG_DETAIL = "No object on this plate fits the printer's bed.";

type Failed = Extract<SliceResult, { status: "failed" }>;

/**
 * True when `result` is Orca's clean -50 refusal: the code is -50 and the
 * run ended the way a refusal does, not in a crash (sliceOutcome answers a
 * crash as slicer_error with the same code). A timeout or an unreadable
 * result has no code, so it is never one.
 */
export function isCleanOffBed(result: SliceResult, run: GroupResult): result is Failed {
  return (
    result.status === "failed" && result.code === OFF_BED_CODE && isCleanExit(OFF_BED_CODE, run)
  );
}

/** A clean -50 for a plate with objects: none of them fits the bed. */
export function bedTooSmall(refusal: Failed): SliceResult {
  return {
    ...refusal,
    reason: "bed_too_small",
    detail: cut(`${TOO_BIG_DETAIL} ${refusal.detail}`),
  };
}

/**
 * Whether a run that wrote refusal `code` ended the way a refusal does: no
 * signal, and an exit status of (256 + code) & 0xff (or none known). Any other
 * known status, or a signal, means Orca died after it wrote the code.
 */
function isCleanExit(code: number, run: GroupResult): boolean {
  return !run.signal && (run.code === null || run.code === ((code % 256) + 256) % 256);
}

/**
 * Orca's own folder inside the job folder, the only one its sandbox may
 * write: the input, out/, data/, home/ and tmp/ are all in it. Files the
 * server owns, GNU time's report among them, stay in the job folder above
 * it, out of Orca's reach. The server deletes the whole job folder.
 */
export const ORCA_FOLDER = "orca";

/** Folders scratchEnv points at, inside ORCA_FOLDER; the server creates them before Orca runs. */
export const SCRATCH_DIRS = [
  "home/.config",
  "home/.cache",
  "home/.local/share",
  "tmp",
  "out",
  "data",
];

function numberOrNull(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number.parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : null;
}

const KIB = 1024;
const MIB = 1024 * KIB;
/** The most the server reads of result.json and of GNU time's report. */
const RESULT_MAX_BYTES = 64 * KIB;
const TIME_MAX_BYTES = 64 * KIB;
/** The most it reads of a plate's statistics file. */
const STATISTICS_MAX_BYTES = MIB;

/**
 * GNU time's report, read by path: it sits in the job folder above Orca's,
 * which only the server can change.
 */
const JOB_FOLDER: Pick<OutFolder, "read"> = { read: readOutputFile };

/**
 * The small file `file` a slice left in `folder`, read with readOutputFile:
 * its text, null when there is none, or the problem that stops the slice
 * when it is not a regular file (a link, a FIFO) or is over `limit`. Orca
 * can change every file in its own folder, so nothing there is opened any
 * other way.
 */
function readSmall(
  folder: Pick<OutFolder, "read">,
  file: string,
  limit: number,
  name: string,
): { text: string } | { problem: string } | null {
  const read = folder.read(file, limit);
  if (read.ok) return { text: read.bytes.toString("utf8") };
  if ("missing" in read) return null;
  if ("notRegular" in read) {
    return { problem: `${name} was not a regular file, so it was not read.` };
  }
  const cap = limit >= MIB ? `${limit / MIB} MiB` : `${limit / KIB} KiB`;
  return { problem: `${name} is over the ${cap} limit, so it was not read.` };
}

function jsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Peak RSS from GNU time -v output, in bytes, or null. */
export function peakRssFromTimeV(text: string): number | null {
  const m = /Maximum resident set size \(kbytes\):\s*(\d+)/.exec(text);
  return m ? Number(m[1]) * 1024 : null;
}

export interface Statistics {
  timeSeconds: number | null;
  weightGrams: number | null;
  filaments: Array<{ slot: number; grams: number }>;
}

export function parseStatistics(value: unknown): Statistics | null {
  if (value === null || typeof value !== "object") return null;
  const summary = (value as { summary?: unknown }).summary;
  if (summary === null || typeof summary !== "object") return null;
  const s = summary as { time?: unknown; weight?: unknown; filaments?: unknown };
  const filaments: Statistics["filaments"] = [];
  for (const f of Array.isArray(s.filaments) ? s.filaments : []) {
    const slot = numberOrNull((f as { id?: unknown })?.id);
    const grams = numberOrNull((f as { weight?: unknown })?.weight);
    if (slot !== null && Number.isInteger(slot) && slot >= 1 && grams !== null && grams >= 0) {
      filaments.push({ slot, grams });
    }
  }
  return { timeSeconds: numberOrNull(s.time), weightGrams: numberOrNull(s.weight), filaments };
}

export interface SliceContext {
  orcaVersion: string;
  plate: number;
  printer: string;
  process: string | null;
  filamentProfiles: Array<string | null>;
  /** The project's filaments, by slot, for the type and colour of each. */
  projectFilaments: Array<{ slot: number; type: string; colour: string | null }>;
  timeoutSeconds: number;
}

/** The first LIMITS.detailChars UTF-16 units of s, never ending on half a surrogate pair. */
export const cut = (s: string): string => {
  const out = s.slice(0, LIMITS.detailChars);
  const last = out.charCodeAt(out.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? out.slice(0, -1) : out;
};

/**
 * Turns one Orca run and the files it left in outDir into the contract's
 * answer. outDir must be a real folder, not a link, and is opened once
 * (openOutFolder): its files are read through that one descriptor, so a
 * process Orca left behind cannot swap the folder between reads. Every file
 * is read with readSmall, so a file Orca made into a link, a FIFO or a huge
 * file fails the slice instead of being read.
 */
export function sliceOutcome(
  ctx: SliceContext,
  run: GroupResult,
  files: { outDir: string; timeFile: string },
): SliceResult {
  const head = { contract: CONTRACT_VERSION, orca: ctx.orcaVersion, plate: ctx.plate } as const;
  const failed = (code: number | null, reason: Reason, detail: string): SliceResult => ({
    ...head,
    status: "failed",
    code,
    reason,
    detail: cut(detail),
  });
  if (run.timedOut) {
    return failed(
      null,
      "timeout",
      `Slicing took longer than ${ctx.timeoutSeconds} s and was stopped.`,
    );
  }
  const outDir = openOutFolder(files.outDir);
  if ("problem" in outDir) return failed(null, "slicer_error", outDir.problem);
  try {
    const resultFile = readSmall(outDir, "result.json", RESULT_MAX_BYTES, "Orca's result.json");
    if (resultFile && "problem" in resultFile) {
      return failed(null, "slicer_error", resultFile.problem);
    }
    const result = (resultFile ? jsonOrNull(resultFile.text) : null) as {
      return_code?: unknown;
      error_string?: unknown;
    } | null;
    const code = result ? numberOrNull(result.return_code) : null;
    if (code === null || !Number.isInteger(code)) {
      const how = run.signal ? `signal ${run.signal}` : `exit ${run.code ?? "unknown"}`;
      const tail = run.stderrTail.trim().split("\n").slice(-3).join(" | ");
      return failed(
        null,
        "slicer_error",
        `Orca wrote no result.json (${how})${tail ? `: ${tail}` : ""}`,
      );
    }
    if (code !== 0) {
      // Orca 2.5.0 ends every refusal by writing its code to result.json and
      // returning that code from main (record_exit_reson, then
      // flush_and_exit, in src/OrcaSlicer.cpp), so a clean refusal exits
      // (256 + code) & 0xff: 239 for -17. GNU time exits with Orca's status,
      // or 128 + the signal when Orca was killed, so a segfault shows as 139.
      // A known status other than the clean one, or a signal, means Orca died
      // after it wrote the code: a crash, whatever the code says, as the
      // slicing gate rules (tools/slicing-gate/lib/classify.mjs). An unknown
      // status is no evidence.
      if (!isCleanExit(code, run)) {
        const end = run.signal ? `was killed by ${run.signal}` : `exited with ${run.code}`;
        return failed(
          code,
          "slicer_error",
          `Orca wrote return code ${code} (${orcaMessage(code)}), then ${end}`,
        );
      }
      const text = typeof result?.error_string === "string" ? result.error_string.trim() : "";
      return failed(code, reasonFor(code), text || orcaMessage(code));
    }
    if (run.signal || (run.code ?? 0) > 128) {
      return failed(
        0,
        "slicer_error",
        `Orca wrote its numbers, then exited with ${run.signal ?? run.code}`,
      );
    }
    const statsName = `plate_${ctx.plate}.statistics.json`;
    const statsFile = readSmall(outDir, statsName, STATISTICS_MAX_BYTES, `Orca's ${statsName}`);
    if (statsFile && "problem" in statsFile) return failed(0, "slicer_error", statsFile.problem);
    const stats = parseStatistics(statsFile ? jsonOrNull(statsFile.text) : null);
    const time = stats?.timeSeconds ?? 0;
    const weight = stats?.weightGrams ?? 0;
    if (!stats || !(time > 0) || !(weight > 0)) {
      return failed(
        0,
        "slicer_error",
        "Orca reported success without a time and a weight above zero",
      );
    }
    const timeFile = readSmall(JOB_FOLDER, files.timeFile, TIME_MAX_BYTES, "GNU time's report");
    if (timeFile && "problem" in timeFile) return failed(0, "slicer_error", timeFile.problem);
    const timeText = timeFile?.text ?? "";
    return {
      ...head,
      status: "ok",
      printer: ctx.printer,
      process: ctx.process,
      filamentProfiles: ctx.filamentProfiles,
      timeSeconds: time,
      weightGrams: weight,
      filaments: stats.filaments.map(({ slot, grams }) => {
        const f = ctx.projectFilaments.find((p) => p.slot === slot);
        return { slot, type: f?.type ?? "", color: f?.colour ?? null, grams };
      }),
      wallMs: run.wallMs,
      peakRssBytes: peakRssFromTimeV(timeText) ?? 0,
    };
  } finally {
    outDir.close();
  }
}
