// The import report (AC-001, AC-004): one line per model with its outcome,
// one size row per file under it (Manyfold's contentSize, the size
// Platehouse stored and the first 12 hex digits of the SHA-256 it recorded),
// and the totals: models found, imported, skipped with a reason, and failed,
// and how many values were left out for being over Platehouse's limits.
//
// Every value that came from Manyfold or a server goes through cleanText, and
// the CLI sends every line through its redactor as well.
import { cleanText } from "./redact.js";

export type Mode = "dry run" | "apply";

export type FileStatus =
  | "imported"
  | "would import"
  | "already in Platehouse"
  | "skipped"
  | "failed";

export interface FileRow {
  name: string;
  /** Manyfold's contentSize. */
  manyfoldSize: number | null;
  /** The size Platehouse stored. */
  storedSize: number | null;
  /** The SHA-256 Platehouse recorded, hex. */
  sha256: string | null;
  status: FileStatus;
  reason: string | null;
}

export type Outcome = "imported" | "skipped" | "failed";

export interface ModelResult {
  manyfoldId: string;
  name: string;
  outcome: Outcome;
  reason: string | null;
  /** The model was made in Platehouse by this run (in a dry run: would be). */
  newModel: boolean;
  files: FileRow[];
  /** Values left out because they are over Platehouse's limits (plan.ts), each with its reason. */
  leftOut?: string[];
}

export interface Report {
  mode: Mode;
  found: number;
  models: ModelResult[];
}

export interface Totals {
  found: number;
  imported: number;
  skipped: number;
  failed: number;
  newModels: number;
  filesImported: number;
  filesSkipped: number;
  sizeMismatches: number;
  /** Values left out over Platehouse's limits, across every model. */
  valuesLeftOut: number;
}

/** How a file row's reason starts when its size is not Manyfold's contentSize. */
export const SIZE_MISMATCH = "size mismatch";

/** How many hex digits of a SHA-256 the report shows. */
const SHA_SHOWN = 12;

export function totals(report: Report): Totals {
  const files = report.models.flatMap((m) => m.files);
  const count = (outcome: Outcome) => report.models.filter((m) => m.outcome === outcome).length;
  return {
    found: report.found,
    imported: count("imported"),
    skipped: count("skipped"),
    failed: count("failed"),
    newModels: report.models.filter((m) => m.newModel).length,
    filesImported: files.filter((f) => f.status === "imported" || f.status === "would import")
      .length,
    filesSkipped: files.filter((f) => f.status === "skipped").length,
    sizeMismatches: files.filter((f) => f.reason?.startsWith(SIZE_MISMATCH) === true).length,
    valuesLeftOut: report.models.reduce((n, m) => n + (m.leftOut?.length ?? 0), 0),
  };
}

const size = (n: number | null) => (n === null ? "-" : String(n));

function fileLine(row: FileRow): string {
  const sha = row.sha256 === null ? "-" : row.sha256.slice(0, SHA_SHOWN);
  const reason = row.reason === null ? "" : ` - ${cleanText(row.reason)}`;
  return (
    `      ${cleanText(row.name)}: manyfold ${size(row.manyfoldSize)}, ` +
    `stored ${size(row.storedSize)}, sha256 ${sha}, ${row.status}${reason}`
  );
}

export function modelLines(result: ModelResult, index: number, total: number): string[] {
  const width = String(total).length;
  const tag = `[${String(index + 1).padStart(width)}/${total}]`;
  let outcome: string = result.outcome;
  if (result.outcome === "imported" && result.newModel) outcome = "imported, new model";
  const reason = result.reason === null ? "" : ` - ${cleanText(result.reason)}`;
  const head = `${tag} ${cleanText(result.name)} (manyfold:${cleanText(result.manyfoldId)}): ${outcome}${reason}`;
  return [head, ...result.files.map(fileLine)];
}

export function summaryLines(report: Report): string[] {
  const t = totals(report);
  const lines = [
    `${report.mode} done: found ${t.found}, imported ${t.imported}, skipped ${t.skipped}, failed ${t.failed}`,
    `  new models ${t.newModels}, files imported ${t.filesImported}, ` +
      `files skipped ${t.filesSkipped}, size mismatches ${t.sizeMismatches}`,
  ];
  if (t.valuesLeftOut > 0) {
    lines.push(
      `  values left out ${t.valuesLeftOut}: over Platehouse's limits, each named on its model's line`,
    );
  }
  if (report.mode === "dry run") {
    lines.push(
      "  A dry run writes nothing: imported means would be imported. A model in " +
        "Platehouse's trash shows as a new model here, since the API never lists the " +
        "trash; --apply skips it.",
    );
  }
  const handled = t.imported + t.skipped + t.failed;
  if (handled !== t.found) lines.push(`  counts add up to ${handled}, not ${t.found}`);
  return lines;
}

/** 0 when every model was handled, 1 when one failed or the counts do not add up. */
export function exitCode(report: Report): 0 | 1 {
  const t = totals(report);
  return t.failed > 0 || t.imported + t.skipped + t.failed !== t.found ? 1 : 0;
}
