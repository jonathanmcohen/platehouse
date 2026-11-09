// One plate through the OrcaSlicer 2.5.0 CLI (build plan Task 11, decision
// 3), the way the slicing gate's gate.mjs slice step ran 332 plates on Hades:
//
//   orca --datadir <job>/data --slice <plate> --export-statistics
//        --mstpp <SLICE_PLATE_SECONDS> --allow-newer-file --outputdir <job>/out
//        --load-settings <flattened machine preset>
//        [--load-filaments <generic per slot, "" keeps the file's own>]
//        <job>/input.3mf
//
// Only the machine preset goes in --load-settings, so the file's own process
// is kept unless Orca refuses the switch (gate item c). The numbers come from
// Orca's per-plate statistics JSON (src/libslic3r/GCode/GCodeStatistics.cpp
// at 40ecc66: summary.time, summary.weight, summary.filaments[].id, 1-based,
// and .weight); the return code from result.json. Orca checks --mstpp only
// after a plate finishes (OrcaSlicer.cpp), so the server also kills the
// plate's process group at SLICE_TIMEOUT_SECONDS.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONTRACT_VERSION,
  LIMITS,
  type Reason,
  type SliceResult,
} from "@platehouse/slicer-contract";
import { orcaMessage, reasonFor } from "./reasons.js";
import type { GroupResult } from "./sandbox.js";

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

/** The environment Orca runs with: everything it writes stays in the job folder. */
export function scratchEnv(dir: string): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: join(dir, "home"),
    TMPDIR: join(dir, "tmp"),
    XDG_CONFIG_HOME: join(dir, "home", ".config"),
    XDG_CACHE_HOME: join(dir, "home", ".cache"),
    XDG_DATA_HOME: join(dir, "home", ".local", "share"),
    XDG_RUNTIME_DIR: join(dir, "tmp"),
    MESA_SHADER_CACHE_DISABLE: "true",
    LANG: "C.UTF-8",
  };
}

/** Folders scratchEnv points at; the server creates them before Orca runs. */
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

function readJsonOrNull(file: string): unknown {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
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

const cut = (s: string) => s.slice(0, LIMITS.detailChars);

/** Turns one Orca run and the files it left in outDir into the contract's answer. */
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
  const result = readJsonOrNull(join(files.outDir, "result.json")) as {
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
  const stats = parseStatistics(
    readJsonOrNull(join(files.outDir, `plate_${ctx.plate}.statistics.json`)),
  );
  const time = stats?.timeSeconds ?? 0;
  const weight = stats?.weightGrams ?? 0;
  if (!stats || !(time > 0) || !(weight > 0)) {
    return failed(
      0,
      "slicer_error",
      "Orca reported success without a time and a weight above zero",
    );
  }
  const timeText = existsSync(files.timeFile) ? readFileSync(files.timeFile, "utf8") : "";
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
}
