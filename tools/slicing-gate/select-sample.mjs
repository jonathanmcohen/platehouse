#!/usr/bin/env node
// Picks the Task 1 slicing-gate sample from a folder of .3mf files.
//
// Read-only: each file is opened for reading, only its Metadata entries are
// parsed (slice_info.config printer keys, the plate list, project_settings
// printer keys), and nothing is written next to the files or copied anywhere.
// It prints file names and the reason each was picked, never file contents.
//
// Usage: node select-sample.mjs <folder> [--json <out.json>] [--names <out.txt>]
//   --json   writes the selection (names, roles, reasons, counts) for run.sh
//   --names  writes one relative file name per line, the union of the sample
//            and the comparison set, for rsync --files-from
import { readdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { printerOf, SHORT } from "./lib/printers.mjs";
import { readProjectMeta } from "./lib/threemf.mjs";

export const AIR_DRY = "Air Dry - AMS.3mf";
const FOREIGN = ["X1C", "A1", "A1 mini", "P1P", "P2S", "X2D"];
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** Lists every .3mf under folder (recursive) with its metadata, or meta null when unreadable. */
export function scanFolder(folder) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".3mf")) {
        const name = relative(folder, full).split(sep).join("/");
        let meta = null;
        let error = null;
        try {
          meta = readProjectMeta(full);
        } catch (err) {
          error = err.code ?? "read error";
        }
        out.push({ name, meta, error });
      }
    }
  };
  walk(folder);
  return out.sort(byName);
}

/** The Task 1 selection rule over [{name, meta}]. Pure; reads nothing. */
export function selectSample(files) {
  const sorted = [...files].sort(byName);
  const readable = sorted.filter((f) => f.meta);
  const sliced = [];
  const unsliced = [];
  const unknownPrinter = [];
  for (const f of readable) {
    const printer = printerOf(f.meta);
    if (printer) sliced.push({ ...f, printer });
    else if (f.meta.plates.some((p) => p.sliced)) unknownPrinter.push(f.name);
    else unsliced.push(f);
  }

  const picks = new Map();
  const pick = (f, role, reason) => {
    const entry = picks.get(f.name) ?? { name: f.name, roles: [], reasons: [] };
    entry.roles.push(role);
    entry.reasons.push(reason);
    picks.set(f.name, entry);
  };
  const missing = [];

  const p1s = sliced.filter((f) => f.printer.model === SHORT.P1S).slice(0, 5);
  for (const f of p1s) pick(f, "p1s-sliced", `already sliced for ${f.printer.orcaName} (${f.printer.source})`);
  if (p1s.length < 5) missing.push(`p1s-sliced (found ${p1s.length} of 5)`);

  const un = unsliced.slice(0, 5);
  for (const f of un) pick(f, "unsliced", "no plate carries Bambu slice numbers in slice_info.config");
  if (un.length < 5) missing.push(`unsliced (found ${un.length} of 5)`);

  // One file per foreign printer, read from slice_info.config. When no file
  // is sliced for that printer, fall back to an unsliced file whose
  // project_settings.config names it, labelled as such, so the printer
  // switch from that source is still exercised.
  for (const short of FOREIGN) {
    const f = sliced.find((s) => s.printer.model === SHORT[short]);
    if (f) {
      pick(f, `foreign-${short}`, `already sliced for ${f.printer.orcaName} (${f.printer.source})`);
      continue;
    }
    const saved = unsliced.find((u) => u.meta.project?.printerModel === SHORT[short]);
    if (saved) {
      pick(saved, `foreign-${short}`, `saved for ${SHORT[short]} in project_settings printer_model, not sliced (no file is sliced for it)`);
      missing.push(`foreign-${short} sliced (used a saved, unsliced file instead)`);
    } else missing.push(`foreign-${short}`);
  }

  const air = readable.find((f) => f.name.split("/").pop() === AIR_DRY);
  if (air) pick(air, "air-dry", `named ${AIR_DRY}, the large file AC-020 names`);
  else missing.push("air-dry");

  const comparison = sliced.map((f) => ({
    name: f.name,
    printer: f.printer.orcaName,
    printerSource: f.printer.source,
    slicedPlates: f.meta.plates.filter((p) => p.sliced).map((p) => p.index),
  }));

  const byPrinter = {};
  for (const f of sliced) byPrinter[f.printer.orcaName] = (byPrinter[f.printer.orcaName] ?? 0) + 1;
  const savedFor = {};
  for (const f of readable) {
    const model = f.meta.project?.printerModel ?? "(not named)";
    savedFor[model] = (savedFor[model] ?? 0) + 1;
  }

  return {
    sample: [...picks.values()].sort(byName),
    comparison,
    missing,
    unknownPrinter,
    counts: {
      files: sorted.length,
      readable: readable.length,
      unreadable: sorted.length - readable.length,
      slicedFiles: sliced.length,
      unslicedFiles: unsliced.length,
      plates: readable.reduce((n, f) => n + f.meta.plates.length, 0),
      slicedPlates: comparison.reduce((n, c) => n + c.slicedPlates.length, 0),
      slicedByPrinter: byPrinter,
      savedForByPrinter: savedFor,
    },
  };
}

function parseArgs(argv) {
  const args = { folder: null, json: null, names: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.json = argv[++i];
    else if (a === "--names") args.names = argv[++i];
    else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else if (args.folder === null) args.folder = a;
    else throw new Error("only one folder may be given");
  }
  if (!args.folder) throw new Error("usage: select-sample.mjs <folder> [--json out.json] [--names out.txt]");
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  const files = scanFolder(args.folder);
  const unsafe = files.filter((f) => /[\r\n]/.test(f.name));
  const sel = selectSample(files.filter((f) => !unsafe.includes(f)));
  const lines = [];
  lines.push(`Scanned ${sel.counts.files} .3mf files: ${sel.counts.readable} readable, ${sel.counts.unreadable} without Bambu plate data or damaged.`);
  lines.push(`Already sliced: ${sel.counts.slicedFiles} files, ${sel.counts.slicedPlates} sliced plates of ${sel.counts.plates} plates. Unsliced: ${sel.counts.unslicedFiles} files.`);
  for (const [printer, n] of Object.entries(sel.counts.slicedByPrinter).sort()) lines.push(`  sliced for ${printer}: ${n}`);
  lines.push("Saved for (project_settings printer_model, sliced or not):");
  for (const [printer, n] of Object.entries(sel.counts.savedForByPrinter).sort()) lines.push(`  ${printer}: ${n}`);
  lines.push("");
  lines.push(`Sample (${sel.sample.length} files):`);
  for (const s of sel.sample) lines.push(`  ${s.name}\n    picked as ${s.roles.join(", ")}: ${s.reasons.join("; ")}`);
  lines.push("");
  lines.push(`Comparison set (every already-sliced file, against its own printer): ${sel.comparison.length} files`);
  for (const c of sel.comparison) lines.push(`  ${c.name} -> ${c.printer}, plates ${c.slicedPlates.join(",")}`);
  if (sel.unknownPrinter.length) lines.push("", `Sliced, but the printer could not be named (left out): ${sel.unknownPrinter.join("; ")}`);
  if (sel.missing.length) lines.push("", `Not found in this folder: ${sel.missing.join("; ")}`);
  if (unsafe.length) lines.push("", `Skipped ${unsafe.length} file(s) whose names contain a line break.`);
  process.stdout.write(`${lines.join("\n")}\n`);

  if (args.json) writeFileSync(args.json, `${JSON.stringify(sel, null, 2)}\n`);
  if (args.names) {
    const names = [...new Set([...sel.sample.map((s) => s.name), ...sel.comparison.map((c) => c.name)])].sort();
    writeFileSync(args.names, `${names.join("\n")}\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`select-sample: ${err.message}\n`);
    process.exit(2);
  }
}
