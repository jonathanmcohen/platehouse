#!/usr/bin/env node
// platehouse-import --manyfold <url> --platehouse <url> [--apply] [--model <id>]
// The one-time import of a Manyfold library into Platehouse: one model per
// Manyfold model with its files, name, MakerWorld details, tags and
// collections, read with a read-only token so Manyfold is never changed.
//
// With MANYFOLD_CLIENT_ID, MANYFOLD_CLIENT_SECRET and PLATEHOUSE_TOKEN set in
// the environment (from a secret manager, never typed on the command line):
//
//   node apps/importer/dist/src/cli.js \
//     --manyfold https://manyfold.example.com \
//     --platehouse https://platehouse.example.com [--apply] [--model <id>]
//
// (build first with pnpm --filter @platehouse/importer build.)
//
// The two addresses have no default: each comes from its flag, or when the
// flag is not given from MANYFOLD_BASE or PLATEHOUSE_BASE, and must be an
// https origin (both clients send requests to the origin only).
//
// A file download fails when it receives nothing for 120 s, or for
// --download-idle-timeout <seconds> (else MANYFOLD_DOWNLOAD_IDLE_TIMEOUT),
// from 1 to 86400. It is an idle limit, not a limit on the whole transfer,
// so a large file over a slow link finishes as long as bytes keep arriving.
// A file upload's limit works the same way: it fails when Platehouse takes
// nothing for 120 s, or for --upload-idle-timeout <seconds> (else
// PLATEHOUSE_UPLOAD_IDLE_TIMEOUT), from 1 to 86400.
//
// A download redirect to a private, loopback or link-local address, or to a
// name that only resolves on a local network, is refused. A Manyfold whose
// object store is on the LAN names it with --allow-redirect-host <host>
// (repeatable), else MANYFOLD_ALLOW_REDIRECT_HOSTS (comma-separated); only
// that privacy check is skipped for it, never the https, token or hop rules.
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
//   and makes no duplicate, matching on Manyfold's model id;
// - in Platehouse's trash: skipped, with that reason, so a re-run never
//   brings back a model someone trashed.
// A value over the API's limits is left out and named on the model's line;
// a name too long to send fails the model, in a dry run too (plan.ts).
// Each file's download is checked against Manyfold's contentSize, and what
// Platehouse stored is checked against it and against the downloaded bytes'
// SHA-256, so every imported file's size is shown to match Manyfold's. The report names every model and has one size row per
// file (report.ts).
//
// Exit codes: 0 every model handled, 1 at least one model failed, 2 the run
// could not start (arguments, a missing or bad address, credentials, either
// side refusing the token or unreachable, Manyfold granting more than read,
// Manyfold's lists unreadable), or an error was raised outside run()
// (onFatal). The credentials come only from
// the environment and are never printed: every line goes through one
// redactor that knows them, the Manyfold token and each signed query, so no
// credential reaches the output.
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import {
  createManyfold,
  DEFAULT_DOWNLOAD_IDLE_MS,
  type Manyfold,
  type ManyfoldModel,
  TokenRenewalError,
} from "./manyfold.js";
import { externalRefFor, type ModelPlan, planModel, type SourceModel } from "./plan.js";
import {
  createPlatehouse,
  DEFAULT_UPLOAD_IDLE_MS,
  type Platehouse,
  type PlatehouseModel,
} from "./platehouse.js";
import { normaliseAllowedHost } from "./private-host.js";
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

/**
 * The two addresses: a flag, or the variable when the flag is not given. No
 * default, so the command never points at any one network.
 */
const ADDRESSES = [
  { flag: "manyfold", variable: "MANYFOLD_BASE", what: "Manyfold" },
  { flag: "platehouse", variable: "PLATEHOUSE_BASE", what: "Platehouse" },
] as const;

/** The credentials, read from the environment: the Manyfold client id and secret, the Platehouse token. */
const CREDENTIALS = ["MANYFOLD_CLIENT_ID", "MANYFOLD_CLIENT_SECRET", "PLATEHOUSE_TOKEN"] as const;

export const USAGE = [
  "usage: platehouse-import --manyfold <url> --platehouse <url> [--apply] [--model <id>]",
  "         [--download-idle-timeout <seconds>] [--upload-idle-timeout <seconds>]",
  "         [--allow-redirect-host <host>]...",
  "  --manyfold and --platehouse are the https addresses of Manyfold and Platehouse;",
  "  without a flag, MANYFOLD_BASE or PLATEHOUSE_BASE is read. Neither has a default.",
  "  Set MANYFOLD_CLIENT_ID, MANYFOLD_CLIENT_SECRET and PLATEHOUSE_TOKEN in the environment.",
  "  A dry run is the default; --apply writes to Platehouse. --model <id> runs one model.",
  "  --download-idle-timeout <seconds>, or MANYFOLD_DOWNLOAD_IDLE_TIMEOUT, fails a file download",
  `  that receives nothing for that long (default ${DEFAULT_DOWNLOAD_IDLE_MS / 1000}); a slow download that keeps receiving never times out.`,
  "  A download redirect to a private, loopback or link-local address, or to a name without a dot,",
  "  is refused. --allow-redirect-host <host> (repeatable), or MANYFOLD_ALLOW_REDIRECT_HOSTS",
  "  (comma-separated), allows one such host, e.g. a MinIO on your network.",
  "  --upload-idle-timeout <seconds>, or PLATEHOUSE_UPLOAD_IDLE_TIMEOUT, fails a file upload",
  `  that Platehouse takes nothing of for that long (default ${DEFAULT_UPLOAD_IDLE_MS / 1000}); a slow upload that keeps going never times out.`,
].join("\n");

/** The idle limits' flags and variables, and their defaults; each takes at most a day. */
const IDLE_LIMITS = {
  download: {
    flag: "download-idle-timeout",
    variable: "MANYFOLD_DOWNLOAD_IDLE_TIMEOUT",
    fallback: DEFAULT_DOWNLOAD_IDLE_MS,
  },
  upload: {
    flag: "upload-idle-timeout",
    variable: "PLATEHOUSE_UPLOAD_IDLE_TIMEOUT",
    fallback: DEFAULT_UPLOAD_IDLE_MS,
  },
} as const;
const IDLE_MAX_S = 86_400;

/** A whole number of seconds from 1 to IDLE_MAX_S, as ms, or null. */
export function idleSeconds(value: string): number | null {
  if (!/^[0-9]{1,6}$/.test(value)) return null;
  const seconds = Number(value);
  return seconds >= 1 && seconds <= IDLE_MAX_S ? seconds * 1000 : null;
}

const MODEL_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** An https origin, given with no path, query, fragment or credentials, or null. */
export function httpsOrigin(value: string): string | null {
  const url = URL.parse(value);
  if (
    url === null ||
    url.protocol !== "https:" ||
    url.hostname === "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return null;
  }
  return url.origin;
}

export interface RunOptions {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** The clock the Manyfold token's expiry is read from, in ms; for tests. */
  now?: () => number;
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
    if (error instanceof TokenRenewalError) throw error;
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
      if (error instanceof TokenRenewalError) throw error;
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
    let args: {
      apply: boolean;
      model: string | undefined;
      manyfold: string | undefined;
      platehouse: string | undefined;
      downloadIdle: string | undefined;
      uploadIdle: string | undefined;
      allowRedirect: string[];
    };
    try {
      const { values } = parseArgs({
        args: [...options.argv],
        options: {
          apply: { type: "boolean", default: false },
          model: { type: "string" },
          manyfold: { type: "string" },
          platehouse: { type: "string" },
          [IDLE_LIMITS.download.flag]: { type: "string" },
          [IDLE_LIMITS.upload.flag]: { type: "string" },
          "allow-redirect-host": { type: "string", multiple: true },
        },
        strict: true,
        allowPositionals: false,
      });
      args = {
        apply: values.apply,
        model: values.model,
        manyfold: values.manyfold,
        platehouse: values.platehouse,
        downloadIdle: values[IDLE_LIMITS.download.flag],
        uploadIdle: values[IDLE_LIMITS.upload.flag],
        allowRedirect: values["allow-redirect-host"] ?? [],
      };
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

    // Each idle limit: the flag, else the variable, else the default. An
    // empty variable counts as not set, as for the addresses.
    const idleLimit = (
      which: keyof typeof IDLE_LIMITS,
      fromFlag: string | undefined,
    ): number | null => {
      const { flag, variable, fallback } = IDLE_LIMITS[which];
      const fromEnv = (options.env[variable] ?? "").trim();
      const given = fromFlag ?? (fromEnv === "" ? undefined : fromEnv);
      const ms = given === undefined ? fallback : idleSeconds(given);
      if (ms === null) {
        const source = fromFlag === undefined ? variable : `--${flag}`;
        err(`${source} takes a whole number of seconds from 1 to ${IDLE_MAX_S}`);
      }
      return ms;
    };
    const downloadTimeoutMs = idleLimit("download", args.downloadIdle);
    const uploadTimeoutMs = idleLimit("upload", args.uploadIdle);
    if (downloadTimeoutMs === null || uploadTimeoutMs === null) {
      usage();
      return { code: 2, report: null };
    }

    // Hosts a download redirect may go to though they are private: every
    // flag and every entry of the variable.
    const allowRedirectHosts: string[] = [];
    const fromEnvHosts = (options.env.MANYFOLD_ALLOW_REDIRECT_HOSTS ?? "").trim();
    const redirectEntries = [
      ...args.allowRedirect.map((value) => ({ value, source: "--allow-redirect-host" })),
      ...fromEnvHosts
        .split(",")
        .filter((v) => v.trim() !== "")
        .map((value) => ({
          value,
          source: "MANYFOLD_ALLOW_REDIRECT_HOSTS",
        })),
    ];
    let badHost = false;
    for (const { value, source } of redirectEntries) {
      const host = normaliseAllowedHost(value);
      if (host === null) {
        err(`${source} takes a host name or address, with no scheme, port or path`);
        badHost = true;
      } else {
        allowRedirectHosts.push(host);
      }
    }
    if (badHost) {
      usage();
      return { code: 2, report: null };
    }

    // The addresses: the flag, else the variable. A value is never echoed, in
    // case it carries credentials.
    const bases: string[] = [];
    const problems: string[] = [];
    for (const { flag, variable, what } of ADDRESSES) {
      const fromFlag = args[flag];
      const given = fromFlag ?? (options.env[variable] ?? "").trim();
      if (given === "") {
        problems.push(`no ${what} address: give --${flag} <https address> or set ${variable}`);
        continue;
      }
      const base = httpsOrigin(given);
      if (base === null) {
        const source = fromFlag === undefined ? variable : `--${flag}`;
        problems.push(
          `${source} must be an https address with no path, query, fragment or credentials`,
        );
        continue;
      }
      bases.push(base);
    }
    if (problems.length > 0) {
      for (const line of problems) err(line);
      usage();
      return { code: 2, report: null };
    }
    const [manyfoldBase, platehouseBase] = bases as [string, string];

    // Each credential is normalized once, control characters out and then
    // trimmed, and that one value is what is checked, sent and redacted. A
    // newline or space around it would otherwise go into the Basic header,
    // where Manyfold refuses it, or into the Bearer header, where a leading
    // space makes Platehouse refuse it and a leading newline makes fetch
    // throw. The raw value is registered too, in case it is echoed as given.
    const raw = CREDENTIALS.map((k) => options.env[k] ?? "");
    for (const v of raw) redactor.add(v);
    const values = raw.map((v) => cleanText(v).trim());
    for (const v of values) redactor.add(v);
    const missing = CREDENTIALS.filter((_, i) => (values[i] ?? "") === "");
    if (missing.length > 0) {
      err(
        `${missing.join(", ")} not set; set ${missing.length === 1 ? "it" : "them"} in the environment.`,
      );
      usage();
      return { code: 2, report: null };
    }
    const [clientId, clientKey, bearer] = values as [string, string, string];
    // The Platehouse token's body without its ph_ prefix, in case only that is
    // echoed.
    if (bearer.startsWith("ph_") && bearer.length > 19) redactor.add(bearer.slice(3));

    const mode: Mode = args.apply ? "apply" : "dry run";
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
      ...(options.now === undefined ? {} : { now: options.now }),
      downloadTimeoutMs,
      allowRedirectHosts,
    });
    const platehouse = createPlatehouse({
      ...common,
      base: platehouseBase,
      bearer,
      uploadTimeoutMs,
    });

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
    let stopped: string | null = null;
    for (const [i, entry] of entries.entries()) {
      let result: ModelResult;
      let stop = false;
      try {
        result = await importModel(ctx, entry);
      } catch (error) {
        // A token that cannot be renewed ends the run: every model left
        // would fail the same way. This model is reported, then the summary.
        stop = error instanceof TokenRenewalError;
        result = {
          manyfoldId: entry.id,
          name: entry.name,
          outcome: "failed",
          reason: message(error),
          newModel: false,
          files: [],
        };
        if (stop) stopped = message(error);
      }
      report.models.push(result);
      for (const line of modelLines(result, i, entries.length)) out(line);
      if (stop) break;
    }
    out("");
    for (const line of summaryLines(report)) out(line);
    if (stopped !== null) {
      out(`stopped: ${stopped}; ${report.found - report.models.length} models not attempted`);
    }
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
