#!/usr/bin/env node
// platehouse-import [--apply] [--model <id>] (build plan Task 23; AC-001 to
// AC-004): the one-time import of Jon's Manyfold library into Platehouse.
//
//   claude-env Manyfold username MANYFOLD_CLIENT_ID -- \
//   claude-env Manyfold password MANYFOLD_CLIENT_SECRET -- \
//   claude-env <Platehouse token item> <field> PLATEHOUSE_TOKEN -- \
//   node apps/importer/dist/src/cli.js [--apply] [--model <id>]
//
// (build first with pnpm --filter @platehouse/importer build.)
//
// It reads Manyfold with one read-scoped token and writes to Platehouse only
// through the Public API v1, with a Platehouse API token. A dry run is the
// default: it reads both sides, plans each model, downloads nothing and
// writes nothing. --apply makes the models, adds their tags and
// collections, and uploads their files. --model limits the run to one
// Manyfold model (the public id in its URL, /models/<id>).
//
// For each Manyfold model, matched by externalRef manyfold:<id> (plan.ts):
// - not in Platehouse: it is made with Manyfold's details, tags and
//   collections, then every file Platehouse takes is uploaded. If the create
//   answers 409 and a live model is read back (an earlier attempt or a run
//   beside this one made it), that model is treated as already in
//   Platehouse, as below, so only what it lacks is added;
// - in Platehouse: only the missing files, tags and collections are added,
//   so a re-run after a full or an interrupted run finishes what is missing
//   and makes no duplicate (AC-002);
// - in Platehouse's trash: skipped, with that reason (Review Focus 4).
// A value over the API's limits is left out and named on the model's line;
// a name too long to send fails the model, in a dry run too (plan.ts).
// Each file's download is checked against Manyfold's contentSize, and what
// Platehouse stored is checked against it and against the downloaded bytes'
// SHA-256 (AC-004). The report names every model and has one size row per
// file (report.ts).
//
// Exit codes: 0 every model handled, 1 at least one model failed, 2 the run
// could not start (arguments, credentials, either side refusing the token or
// unreachable, Manyfold granting more than read, Manyfold's lists
// unreadable), or an error was raised outside run() (onFatal). The credentials come only from
// the environment and are never printed: every line goes through one
// redactor that knows them, the Manyfold token and each signed query (AC-003).
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { createManyfold, type Manyfold, type ManyfoldModel } from "./manyfold.js";
import { externalRefFor, type ModelPlan, planModel, type SourceModel } from "./plan.js";
import { createPlatehouse, type Platehouse, type PlatehouseModel } from "./platehouse.js";
import { cleanText, createRedactor, type Redactor } from "./redact.js";
import {
  exitCode,
  type FileRow,
  type Mode,
  type ModelResult,
  modelLines,
  PRESENT_UNCHECKED,
  type Report,
  SIZE_MISMATCH,
  summaryLines,
} from "./report.js";

export const MANYFOLD_BASE = "https://manyfold.local.jonco.dev";
export const PLATEHOUSE_BASE = "https://platehouse.local.jonco.dev";

/** The variables claude-env sets: the Manyfold client id and secret, the Platehouse token. */
const CREDENTIALS = ["MANYFOLD_CLIENT_ID", "MANYFOLD_CLIENT_SECRET", "PLATEHOUSE_TOKEN"] as const;

export const USAGE = [
  "usage: platehouse-import [--apply] [--model <id>]",
  "  Run it under claude-env, which sets MANYFOLD_CLIENT_ID and MANYFOLD_CLIENT_SECRET",
  "  from the 1Password item Manyfold, and PLATEHOUSE_TOKEN.",
  "  A dry run is the default; --apply writes to Platehouse. --model <id> runs one model.",
].join("\n");

const MODEL_ID = /^[A-Za-z0-9_-]{1,100}$/;

export interface RunOptions {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  manyfoldBase?: string;
  platehouseBase?: string;
  /**
   * The redactor every line goes through; the command passes the one its
   * process-level handlers use (onFatal), so they know the credentials too.
   */
  redactor?: Redactor;
}

export interface RunResult {
  /** 0 ok, 1 a model failed, 2 the run could not start. */
  code: 0 | 1 | 2;
  report: Report | null;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Creator and collection names by URL: listed once in a full run, read one by one with --model. */
function nameBook(manyfold: Manyfold, known: Map<string, string>) {
  return async (url: string): Promise<string | null> => {
    const have = known.get(url);
    if (have !== undefined) return have;
    const name = await manyfold.getName(url);
    if (name !== null) known.set(url, name);
    return name;
  };
}

async function sourceOf(
  manyfold: Manyfold,
  model: ManyfoldModel,
  nameOf: (url: string) => Promise<string | null>,
): Promise<SourceModel> {
  const collections: string[] = [];
  for (const url of model.collectionUrls) {
    const name = await nameOf(url);
    if (name !== null && name.trim() !== "") collections.push(name);
  }
  const files = [];
  for (const part of model.parts) files.push(await manyfold.getFile(part.url));
  return {
    id: model.id,
    name: model.name,
    caption: model.caption,
    description: model.description,
    creator: model.creatorUrl === null ? null : await nameOf(model.creatorUrl),
    license: model.license,
    tags: model.keywords,
    collections,
    files,
  };
}

function row(
  name: string,
  manyfoldSize: number | null,
  status: FileRow["status"],
  extra: Partial<FileRow> = {},
): FileRow {
  return { name, manyfoldSize, storedSize: null, sha256: null, status, reason: null, ...extra };
}

/**
 * Rows for files nothing is done to: a dry run's plan, a model left alone,
 * or the files that are present, skipped or failed by plan in an --apply run.
 */
function plannedRows(plan: ModelPlan, notImported?: string): FileRow[] {
  return plan.files.map((f) => {
    const size = f.file.contentSize;
    switch (f.action) {
      case "present":
        // Matched by name and size only; its SHA-256 is Platehouse's, not compared.
        return row(f.file.filename, size, "already in Platehouse", {
          storedSize: f.stored.size,
          sha256: f.stored.sha256,
          reason: PRESENT_UNCHECKED,
        });
      case "skip":
        return row(f.file.filename, size, "skipped", { reason: f.reason });
      case "fail":
        return row(f.file.filename, size, "failed", { reason: f.reason });
      case "import":
        return notImported === undefined
          ? row(f.file.filename, size, "would import")
          : row(f.file.filename, size, "skipped", { reason: notImported });
    }
    throw new Error("unreachable");
  });
}

function outcomeOf(
  result: Omit<ModelResult, "outcome" | "reason">,
  changed: boolean,
  problems: string[],
  nothing: string,
): ModelResult {
  const failedFiles = result.files.filter((f) => f.status === "failed").length;
  if (failedFiles > 0) problems.push(`${failedFiles} of ${result.files.length} files failed`);
  if (problems.length > 0) return { ...result, outcome: "failed", reason: problems.join("; ") };
  if (result.newModel || changed) return { ...result, outcome: "imported", reason: null };
  return { ...result, outcome: "skipped", reason: `already in Platehouse, ${nothing}` };
}

interface Context {
  mode: Mode;
  manyfold: Manyfold;
  platehouse: Platehouse;
  nameOf: (url: string) => Promise<string | null>;
}

/** The result with the plan's left-out values added to its reason and counted. */
function noting(result: ModelResult, plan: ModelPlan): ModelResult {
  if (plan.leftOut.length === 0) return result;
  const note = plan.leftOut.join("; ");
  return {
    ...result,
    reason: result.reason === null ? note : `${result.reason}; ${note}`,
    leftOut: plan.leftOut,
  };
}

function dryRun(plan: ModelPlan, base: { manyfoldId: string; name: string }): ModelResult {
  const files = plannedRows(plan);
  const extra: string[] = [];
  if (plan.tags.length > 0) extra.push(`would add tags ${plan.tags.join(", ")}`);
  if (plan.collections.length > 0) {
    extra.push(`would add to collections ${plan.collections.join(", ")}`);
  }
  const result = outcomeOf(
    { ...base, newModel: plan.create !== null, files },
    files.some((f) => f.status === "would import") || extra.length > 0,
    [],
    "nothing to do",
  );
  if (result.outcome === "imported" && extra.length > 0) result.reason = extra.join("; ");
  return noting(result, plan);
}

async function importModel(
  ctx: Context,
  entry: { id: string; url: string; name: string },
): Promise<ModelResult> {
  const fallback = { manyfoldId: entry.id, name: entry.name, newModel: false, files: [] };
  let source: SourceModel;
  let existing: PlatehouseModel | undefined;
  try {
    const model = await ctx.manyfold.getModel(entry.url);
    source = await sourceOf(ctx.manyfold, model, ctx.nameOf);
    existing = await ctx.platehouse.findByExternalRef(externalRefFor(source.id));
  } catch (error) {
    return { ...fallback, outcome: "failed", reason: message(error) };
  }
  if (source.name.trim() === "") {
    return { ...fallback, outcome: "failed", reason: "the Manyfold model has no name" };
  }
  let plan = planModel(source, existing);
  const base = { manyfoldId: source.id, name: source.name };
  if (plan.refused !== null) {
    // Platehouse would refuse the create with 400 (plan.ts), in either mode.
    return {
      ...base,
      newModel: false,
      outcome: "failed",
      reason: `cannot be made in Platehouse: ${plan.refused}`,
      files: plannedRows(plan, "the model cannot be made"),
    };
  }
  if (ctx.mode === "dry run") return dryRun(plan, base);

  let modelId: string;
  let newModel = false;
  if (plan.create !== null) {
    try {
      const made = await ctx.platehouse.createModel(plan.create);
      if ("exists" in made) {
        return {
          ...base,
          newModel: false,
          outcome: "skipped",
          reason: "in Platehouse's trash; not imported again (restore it there to finish it)",
          files: plannedRows(plan, "its model is in Platehouse's trash"),
        };
      }
      if ("found" in made) {
        // Not made by this POST, and it may already hold files: plan against
        // it as found, keeping the reasons the create body left values out.
        const found = planModel(source, made.found);
        plan = { ...found, leftOut: [...new Set([...plan.leftOut, ...found.leftOut])] };
        modelId = made.found.id;
      } else {
        modelId = made.created.id;
        newModel = true;
      }
    } catch (error) {
      return {
        ...base,
        newModel: false,
        outcome: "failed",
        reason: `could not make the model: ${message(error)}`,
        files: plannedRows(plan, "the model could not be made"),
      };
    }
  } else if (existing !== undefined) {
    modelId = existing.id;
  } else {
    throw new Error("unreachable: a plan with nothing to create has an existing model");
  }

  const problems: string[] = [];
  let changed = false;
  for (const tag of plan.tags) {
    try {
      await ctx.platehouse.addTag(modelId, tag);
      changed = true;
    } catch (error) {
      problems.push(`tag ${tag}: ${message(error)}`);
    }
  }
  for (const collection of plan.collections) {
    try {
      await ctx.platehouse.addToCollection(modelId, collection);
      changed = true;
    } catch (error) {
      problems.push(`collection ${collection}: ${message(error)}`);
    }
  }

  const files: FileRow[] = [];
  for (const f of plan.files) {
    const { filename, contentSize } = f.file;
    if (f.action !== "import" || contentSize === null) {
      files.push(...plannedRows({ ...plan, files: [f] }));
      continue;
    }
    let bytes: Buffer;
    try {
      // A SizeMismatch's message starts with SIZE_MISMATCH.
      bytes = await ctx.manyfold.download(f.file.contentUrl, contentSize);
    } catch (error) {
      files.push(row(filename, contentSize, "failed", { reason: message(error) }));
      continue;
    }
    const local = sha256(bytes);
    try {
      const stored = await ctx.platehouse.upload(modelId, filename, bytes);
      const seen = { storedSize: stored.size, sha256: stored.sha256 };
      if (stored.size !== contentSize) {
        const reason = `${SIZE_MISMATCH}: Platehouse stored ${stored.size} bytes, Manyfold says ${contentSize}`;
        files.push(row(filename, contentSize, "failed", { ...seen, reason }));
      } else if (stored.sha256 !== local) {
        const reason = "Platehouse's SHA-256 is not the downloaded bytes' SHA-256";
        files.push(row(filename, contentSize, "failed", { ...seen, reason }));
      } else {
        files.push(row(filename, contentSize, "imported", seen));
        changed = true;
      }
    } catch (error) {
      files.push(row(filename, contentSize, "failed", { reason: `upload: ${message(error)}` }));
    }
  }
  return noting(
    outcomeOf({ ...base, newModel, files }, changed, problems, "nothing missing"),
    plan,
  );
}

export async function run(options: RunOptions): Promise<RunResult> {
  const redactor = options.redactor ?? createRedactor();
  // Control characters come out before redaction: taken out after it, they
  // could join up a credential that was echoed with one inside it.
  const out = (line: string) => options.stdout(redactor.redact(cleanText(line)));
  const err = (line: string) => options.stderr(redactor.redact(cleanText(line)));
  const usage = () => {
    for (const line of USAGE.split("\n")) err(line);
  };

  let report: Report | null = null;
  try {
    let args: { apply: boolean; model: string | undefined };
    try {
      const { values } = parseArgs({
        args: [...options.argv],
        options: { apply: { type: "boolean", default: false }, model: { type: "string" } },
        strict: true,
        allowPositionals: false,
      });
      args = { apply: values.apply, model: values.model };
    } catch (error) {
      err(message(error));
      usage();
      return { code: 2, report: null };
    }
    if (args.model !== undefined && !MODEL_ID.test(args.model)) {
      err("--model takes a Manyfold model's public id, such as abc123 (letters, digits, - and _)");
      usage();
      return { code: 2, report: null };
    }

    const values = CREDENTIALS.map((k) => options.env[k] ?? "");
    for (const v of values) redactor.add(v);
    const missing = CREDENTIALS.filter((_, i) => (values[i] ?? "").trim() === "");
    if (missing.length > 0) {
      err(`${missing.join(", ")} not set; run it under claude-env.`);
      usage();
      return { code: 2, report: null };
    }
    const [clientId, clientKey, bearer] = values as [string, string, string];
    // The Platehouse token's body without its ph_ prefix, in case only that is
    // echoed; looked for on the trimmed token, as fetch sends it.
    const sent = cleanText(bearer).trim();
    if (sent.startsWith("ph_") && sent.length > 19) redactor.add(sent.slice(3));

    const mode: Mode = args.apply ? "apply" : "dry run";
    const manyfoldBase = options.manyfoldBase ?? MANYFOLD_BASE;
    const platehouseBase = options.platehouseBase ?? PLATEHOUSE_BASE;
    const common = {
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      log: out,
      // Error bodies are redacted inside the clients, before they are cut
      // to 200 characters, as well as here when each line is printed.
      redact: (text: string) => redactor.redact(text),
    };
    const manyfold = createManyfold({
      ...common,
      base: manyfoldBase,
      clientId,
      clientKey,
      sensitive: (value) => redactor.add(value),
    });
    const platehouse = createPlatehouse({ ...common, base: platehouseBase, bearer });

    out(
      `${new Date().toISOString()} platehouse-import ${mode}: ${manyfoldBase} -> ${platehouseBase}`,
    );

    // Everything up to the model list must work, or nothing is attempted.
    // Platehouse is checked first so a bad Platehouse token spends none of
    // Manyfold's 10 token requests per 3 minutes.
    let entries: Array<{ id: string; url: string; name: string }>;
    const known = new Map<string, string>();
    try {
      await platehouse.check();
      await manyfold.authenticate();
      if (args.model !== undefined) {
        entries = [{ id: args.model, url: manyfold.modelUrl(args.model), name: args.model }];
      } else {
        entries = await manyfold.listModels();
        for (const [url, name] of await manyfold.listCreators()) known.set(url, name);
        for (const [url, name] of await manyfold.listCollections()) known.set(url, name);
      }
    } catch (error) {
      err(`could not start: ${message(error)}`);
      return { code: 2, report: null };
    }

    report = { mode, found: entries.length, models: [] };
    const ctx: Context = { mode, manyfold, platehouse, nameOf: nameBook(manyfold, known) };
    for (const [i, entry] of entries.entries()) {
      let result: ModelResult;
      try {
        result = await importModel(ctx, entry);
      } catch (error) {
        result = {
          manyfoldId: entry.id,
          name: entry.name,
          outcome: "failed",
          reason: message(error),
          newModel: false,
          files: [],
        };
      }
      report.models.push(result);
      for (const line of modelLines(result, i, entries.length)) out(line);
    }
    out("");
    for (const line of summaryLines(report)) out(line);
    return { code: exitCode(report), report };
  } catch (error) {
    err(`platehouse-import: unexpected error: ${message(error)}`);
    return { code: report === null ? 2 : 1, report };
  }
}

/** Where uncaught exceptions and unhandled rejections arrive: the process. */
export interface FatalSource {
  on(
    event: "uncaughtException" | "unhandledRejection",
    listener: (error: unknown) => void,
  ): unknown;
}

/**
 * Handles an error raised outside run(): an uncaught exception, an unhandled
 * rejection, or run() itself rejecting. Node's own printer would write the
 * raw message and stack; this writes one line, the message only, without
 * control characters and through the redactor run() fills, then exits 2.
 * Returns the handler, for run()'s rejection.
 */
export function onFatal(
  source: FatalSource,
  redactor: Redactor,
  write: (line: string) => void,
  exit: (code: 2) => void,
): (error: unknown) => void {
  const fail = (error: unknown) => {
    write(`platehouse-import: unexpected error: ${redactor.redact(cleanText(message(error)))}`);
    exit(2);
  };
  source.on("uncaughtException", fail);
  source.on("unhandledRejection", fail);
  return fail;
}

if (import.meta.main) {
  const redactor = createRedactor();
  const fail = onFatal(
    process,
    redactor,
    (line) => process.stderr.write(`${line}\n`),
    (code) => process.exit(code),
  );
  run({
    argv: process.argv.slice(2),
    env: process.env,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    redactor,
  }).then((result) => {
    process.exitCode = result.code;
  }, fail);
}
