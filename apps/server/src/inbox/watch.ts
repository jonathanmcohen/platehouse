// The inbox watcher (build plan Task 10; AC-021). A supported file placed in
// the inbox folder (INBOX_DIR, ${APPDATA}/platehouse/inbox on Hades) becomes a
// model with no manual step, through ingestFile (ingest/ingest.ts), each file
// a model of its own.
//
// The plan's decisions, in the order a file meets them:
// - The folder is polled every 5 seconds (POLL_MS), not watched with inotify:
//   bind mounts and network copies drop events.
// - Dotfiles and names ending in .part, .crdownload or .tmp (any case) are
//   ignored, as are folders (failed/ among them), symlinks and anything else
//   that is not a regular file. They are never imported and never moved.
// - A file is settled when its size and mtime (and inode, so a replaced file
//   counts as new) are unchanged across consecutive polls for
//   INBOX_SETTLE_SECONDS. The window starts when a poll first sees the
//   current size and mtime, never at the mtime itself: a copy that keeps its
//   source's mtime (rsync -t, cp -p) would otherwise look settled at once.
//   The clock is read for each file as it is looked at, not once per pass,
//   so a slow import earlier in a pass does not shorten a later file's window.
// - A settled file goes to ingestFile. Once it returns, the watcher reads
//   the size and SHA-256 that ingest recorded for the stored file and hashes
//   the inbox copy again; the copy is deleted only when both match (AC-021:
//   deleted once the upload is verified). If the copy changed in the
//   meantime, or the record cannot be read, the copy is moved to failed with
//   a reason that says a model was made, so it is neither lost nor imported a
//   second time.
// - A file ingest refuses or fails on moves to failed/<name> ("<stem> (2)<ext>"
//   and so on when the name is taken) with <name>.reason.txt beside it,
//   holding one plain sentence.
// - The folder is listed as raw bytes, so a name that is not valid UTF-8 (a
//   Latin-1 name from an old archive, say) still reaches lstat and the move.
//   Ingest takes the file by a string path, which cannot spell such a name,
//   so once settled the file moves to failed under its name with each bad
//   byte shown as U+FFFD, with a reason that says to rename it.
// - A settled file larger than MAX_INBOX_BYTES (512 MiB, the limit uploads
//   have) moves to failed from its size alone, before anything is read or
//   uploaded.
// - A file goes to failed only for a reason that belongs to the file: one of
//   ingest's own refusals (an IngestError other than storage_unavailable:
//   the wrong type or content), the size limit, or a name that is not UTF-8.
//   There is no list of outage errors. Any other error, from any source (the
//   store, the database, findImported, the upload library, anything
//   unexpected), is not the file's fault until shown to be: the file stays
//   where it is, the pass stops, and the watcher checks the environment once
//   (probes: a small database query and a small store listing, each with a
//   PROBE_TIMEOUT_MS limit).
//   - A check fails: it is an outage. It is logged once when it starts, with
//     the error, and once when it ends. No file is tried, and so none is
//     uploaded, until a check passes. The checks back off: the next comes
//     BACKOFF_FIRST_MS (5 s) later, the wait doubles after each failed
//     check up to BACKOFF_MAX_MS (5 minutes), and it starts again at 5 s
//     after a good pass. A fault in the environment never moves the inbox to
//     failed one file at a time, and never uploads a file on every poll.
//   - Both checks pass: the error counts against that file. After STRIKES
//     (3) such failures in a row while its size, mtime and inode stay the
//     same, it moves to failed with a reason quoting the error; a change to
//     the file starts its count again. The pass goes on to the next file, so
//     one file cannot hold up the inbox. The move of a file on its last
//     strike waits for the end of the pass, for the rule below.
//   - Both checks pass, and a second file has already failed in this pass
//     with both checks passing: the fault is taken to be one the checks
//     cannot see, not the files'. The database check only reads, so a fault
//     that breaks writes and not reads passes it (the data disk full, 53100,
//     or a write-side I/O error, 58030), as does a full bucket that still
//     lists. Neither failure counts against its file (the first file's
//     strike is taken back, and it is not moved to failed even on what would
//     have been its last), the files stay where they are and the pass stops.
//     It is logged once when it starts, with both errors, and once when it
//     ends. The checks cannot say when such a fault ends, so a try of the
//     files does: the next comes BACKOFF_FIRST_MS later and, while each try
//     ends the same way, the wait doubles up to BACKOFF_MAX_MS as above. It
//     ends at the first pass that tries a file without two failing. Only one
//     file in the inbox, or files settling far enough apart that no two are
//     tried in one pass, still cost each file 3 tries under such a fault
//     before it moves to failed.
// - A commit can land with its answer lost when the database connection drops
//   (ingest then throws the connection error it met), and the process can
//   restart before the file is tried again (a container recreate, a crash, a
//   host reboot that stops Postgres mid-commit). So before every ingest the
//   watcher asks findImported (repos files.findImported) for a file row with
//   the same original name, size and SHA-256 created since the file reached
//   the inbox: its ctime, which a copy, a move or a rename sets, unlike its
//   mtime, and which survives a restart because it is on disk. ctime also
//   moves on any metadata change (chmod, chown, an xattr or ACL write such as
//   Samba storing a Finder xattr, a link-count change), so the watcher takes
//   it when a poll first sees the file's size, mtime and inode and keeps that
//   value while they stay the same: a metadata change during an outage does
//   not move it. That memory is the process's own. After a restart the next
//   process reads the ctime afresh, so a metadata change made after a lost
//   answer and before a restart can still let the file be imported twice.
//   Birth time is not used instead: a move within one filesystem keeps the
//   inode and its birth time from before the file reached the inbox, so an
//   earlier import of the same file would count and the new copy would be
//   deleted without a model of its own. A row found is
//   the import, so it is not made twice; the inbox copy is checked and
//   deleted as after any import. An earlier import of the same file, before
//   this copy arrived, does not count. The created_at of the row is the
//   database's clock and the ctime is the inbox host's, so the two must agree
//   to within the settle window, which is the least time between a file's
//   last change and its import's commit. The question comes before the
//   upload, so a database that does not answer it stops the file before
//   anything reaches the bucket.
//
// No file is retried in a loop and none is dropped without a word. A file that
// cannot be moved to failed (or whose inbox copy cannot be deleted after a
// verified import) stays in the inbox, is logged, and is not tried again
// while its size, mtime and inode stay the same; a new copy under the same
// name is a new file. That memory is the process's own, so after a restart
// such a file is tried once more.
//
// Nothing here starts on import: the server calls start() once at boot and
// stop() on shutdown, passing the files repository's get as storedFile, its
// findImported as findImported, and inboxProbes({ db, store }) as probes.
// pollOnce() runs one pass and is what the tests drive, with an injected
// clock instead of real waits; during an outage a pass before the next check
// is due tries no file.
import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import type { BigIntStats, PathLike } from "node:fs";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { type Kysely, sql } from "kysely";
import type { DB } from "../db/types.js";
import { type Ingest, IngestError } from "../ingest/ingest.js";
import type { ImportedQuery } from "../repos/files.js";
import type { BlobStore } from "../storage/s3.js";

/** How often the inbox is polled. */
export const POLL_MS = 5_000;

/** The folder inside the inbox that failed files move to. */
export const FAILED_DIR = "failed";

/** What follows a failed file's name to name its reason file. */
export const REASON_SUFFIX = ".reason.txt";

/** Reason when the inbox copy no longer matches what was stored. */
export const CHANGED_REASON =
  "This file changed while Platehouse was importing it, so it was kept here; check the new model in the library before adding it again.";

/** Reason when the stored copy's record could not be read back. */
export const UNCONFIRMED_REASON =
  "Platehouse imported this file but could not confirm the stored copy, so it was kept here; check the library before adding it again.";

/** Reason when the file's name is not valid UTF-8. */
export const NON_UTF8_REASON =
  "Platehouse could not import this file because its name is not valid UTF-8; rename it and add it again.";

/**
 * The largest file the inbox takes, in bytes: 512 MiB, the same limit as an
 * upload (MAX_UPLOAD_BYTES in uploads/tus.ts, Task 9).
 */
export const MAX_INBOX_BYTES = 536_870_912;

/** Reason when the file is larger than MAX_INBOX_BYTES. */
export const TOO_LARGE_REASON =
  `Platehouse could not import this file because it is larger than ${MAX_INBOX_BYTES} bytes ` +
  "(512 MiB), the most it takes; nothing was uploaded.";

/** Failures in a row, with storage and the database answering, before a file moves to failed. */
export const STRIKES = 3;

/** How long each environment check may take before it counts as failed. */
export const PROBE_TIMEOUT_MS = 5_000;

/** The wait before the first retry after an outage starts; it doubles on each failed check. */
export const BACKOFF_FIRST_MS = 5_000;

/** The longest wait between checks during an outage. */
export const BACKOFF_MAX_MS = 300_000;

/** The reason a file takes when it failed STRIKES times while storage and the database answered. */
export function repeatedErrorReason(error: unknown): string {
  return (
    `Platehouse tried to import this file ${STRIKES} times while storage and the database were ` +
    `answering and it failed each time, last with "${errorText(error)}".`
  );
}

/** Cheap checks that the database and the store answer; each rejects when it does not. */
export interface InboxProbes {
  database(): Promise<unknown>;
  store(): Promise<unknown>;
}

/**
 * The checks the server wires in. The database check is one small query: it
 * reads from files (so a role with no grant fails it), and fails when the
 * session is read-only (a standby after a failover, or
 * default_transaction_read_only) or the role may not insert into files. It
 * writes nothing, so a fault that breaks writes and not reads (the data disk
 * full) passes it; the watcher catches that by two files failing in one pass
 * (createInboxWatcher). The store check lists at most one object under
 * models/, where ingest writes.
 */
export function inboxProbes(deps: {
  db: Kysely<DB>;
  store: Pick<BlobStore, "listPage">;
}): InboxProbes {
  return {
    async database() {
      const { rows } = await sql<{ ro: string; ins: boolean; found: boolean }>`
        select current_setting('transaction_read_only') as ro,
               has_table_privilege('files', 'INSERT') as ins,
               exists (select 1 from files) as found
      `.execute(deps.db);
      const row = rows[0];
      if (row === undefined) throw new Error("the database check returned no row");
      if (row.ro !== "off") throw new Error("the database is read-only");
      if (!row.ins) throw new Error("the database role may not insert into files");
    },
    async store() {
      await deps.store.listPage("models/", { maxKeys: 1 });
    },
  };
}

/** Runs one check, failing it when it takes longer than ms. */
async function withTimeout(check: () => Promise<unknown>, what: string, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`the ${what} check took longer than ${ms} ms`)), ms);
  });
  try {
    await Promise.race([Promise.resolve().then(check), late]);
  } finally {
    clearTimeout(timer);
  }
}

const IGNORED_SUFFIXES = [".part", ".crdownload", ".tmp"];

// The longest file name, in bytes, on ext4 and APFS.
const NAME_MAX_BYTES = 255;

// The longest error text the log takes from one error.
const ERROR_TEXT_MAX = 500;

/** Whether the watcher leaves a file with this name alone. */
export function isIgnoredName(name: string): boolean {
  if (name.startsWith(".")) return true;
  const lower = name.toLowerCase();
  return IGNORED_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/** A listed name: the key the watcher remembers it by and the name it shows. */
export interface InboxName {
  /** The name itself, or "/" and its bytes in hex when it is not UTF-8. */
  key: string;
  /** The name decoded as UTF-8, each bad byte shown as U+FFFD. */
  name: string;
  /** Whether the bytes are valid UTF-8, so the name can be passed as a string. */
  utf8: boolean;
}

/** How the watcher names a file it listed as raw bytes. */
export function inboxName(raw: Buffer): InboxName {
  const name = raw.toString("utf8");
  if (isUtf8(raw)) return { key: name, name, utf8: true };
  // Two such names can decode alike, so the key is the bytes. "/" cannot occur
  // in a file name, so this key never equals a UTF-8 name.
  return { key: `/${raw.toString("hex")}`, name, utf8: false };
}

/** What ingest recorded for a stored file. */
export interface StoredFile {
  size: number;
  sha256: Buffer;
}

export type { ImportedQuery };

export interface InboxWatcherDeps {
  /** The inbox folder (INBOX_DIR); created when missing. */
  dir: string;
  /** INBOX_SETTLE_SECONDS. */
  settleSeconds: number;
  ingest: Pick<Ingest, "ingestFile">;
  /** The recorded size and SHA-256 of a stored file (repos files.get). */
  storedFile: (fileId: string) => Promise<StoredFile | undefined>;
  /**
   * The file row with this original name, size and SHA-256 created at or
   * after since (files.created_at), if any (repos files.findImported). since
   * is on the wall clock, never the injected settle clock.
   */
  findImported: (file: ImportedQuery) => Promise<{ modelId: string; fileId: string } | undefined>;
  /** The environment checks run after an error that is not the file's own (inboxProbes). */
  probes: InboxProbes;
  /** How long each check may take; PROBE_TIMEOUT_MS when left out. */
  probeTimeoutMs?: number;
  /** Milliseconds between polls; POLL_MS when left out. */
  pollMs?: number;
  /** The clock the settle window is measured on, in ms; Date.now when left out. */
  now?: () => number;
  /** Where the watcher's lines go; console.info when left out. */
  log?: (line: string) => void;
}

/** What one pass did. */
export interface InboxPass {
  /** Files ingest stored, each as a new model. */
  imported: Array<{ name: string; modelId: string; fileId: string }>;
  /** Files moved to failed, with the sentence written beside each. */
  failed: Array<{ name: string; reason: string }>;
  /** True when an outage held back the imports of this pass; the files wait in the inbox. */
  waiting: boolean;
}

/** A strike taken in the pass under way, settled when the pass ends. */
interface PassStrike {
  name: string;
  path: string;
  error: unknown;
  /** The file's count before this strike, put back if the strike is taken back. */
  prior: { signature: string; count: number } | undefined;
  count: number;
}

/** What the pass under way has learnt, beside what it returns. */
interface PassState {
  pass: InboxPass;
  /** The one file that failed in this pass with the checks passing, if any. */
  struck?: PassStrike;
  /** Whether a file was tried. */
  tried: boolean;
  /** Whether a second such failure held the pass: a fault the checks cannot see. */
  unseen: boolean;
}

interface Seen {
  signature: string;
  /** When a poll first saw this signature, on the injected clock. */
  since: number;
  /**
   * The file's ctime when a poll first saw this signature: when it reached
   * the inbox. Held so that a later metadata change (chmod, chown, an xattr
   * or ACL write) does not move it while the signature stays the same.
   */
  arrived: Date;
  /** The file's size and SHA-256 while it keeps this signature. */
  hash?: StoredFile;
}

function signature(st: BigIntStats): string {
  return `${st.size}:${st.mtimeNs}:${st.ino}`;
}

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/** One line of an error for the log, capped. */
function errorText(error: unknown): string {
  const text =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : `non-error thrown: ${String(error)}`;
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > ERROR_TEXT_MAX ? `${line.slice(0, ERROR_TEXT_MAX)}...` : line;
}

/** A message as one sentence ending in a full stop. */
function sentence(message: string): string {
  const text = message.replace(/\s+/g, " ").trim();
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** The longest prefix of text that fits in maxBytes of UTF-8, cut between code points. */
function truncateUtf8(text: string, maxBytes: number): string {
  let out = "";
  let bytes = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch, "utf8");
    if (bytes + size > maxBytes) break;
    out += ch;
    bytes += size;
  }
  return out;
}

/**
 * The name a failed file takes on its nth try for a free slot: the name
 * itself, then "<stem> (2)<ext>" and so on, shortened so that the name with
 * its reason suffix still fits in a file name.
 */
export function failedName(name: string, n: number): string {
  const dot = name.lastIndexOf(".");
  let ext = dot > 0 ? name.slice(dot) : "";
  let stem = dot > 0 ? name.slice(0, dot) : name;
  const suffix = n === 1 ? "" : ` (${n})`;
  const fixed = Buffer.byteLength(REASON_SUFFIX) + Buffer.byteLength(suffix);
  if (Buffer.byteLength(ext) > NAME_MAX_BYTES / 4) {
    // An "extension" this long is part of the name.
    stem = name;
    ext = "";
  }
  const budget = NAME_MAX_BYTES - fixed - Buffer.byteLength(ext);
  return `${truncateUtf8(stem, budget)}${suffix}${ext}`;
}

async function exists(path: PathLike): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (codeOf(error) === "ENOENT") return false;
    throw error;
  }
}

async function hashFile(path: string): Promise<StoredFile> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { size, sha256: hash.digest() };
}

export function createInboxWatcher(deps: InboxWatcherDeps) {
  const { dir, ingest, storedFile, findImported, probes } = deps;
  const pollMs = deps.pollMs ?? POLL_MS;
  const probeTimeoutMs = deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.info(line));
  if (!Number.isSafeInteger(deps.settleSeconds) || deps.settleSeconds < 1) {
    throw new RangeError("settleSeconds must be a whole number of 1 or more");
  }
  if (!Number.isSafeInteger(pollMs) || pollMs < 1) {
    throw new RangeError("pollMs must be a whole number of 1 or more");
  }
  if (!Number.isSafeInteger(probeTimeoutMs) || probeTimeoutMs < 1) {
    throw new RangeError("probeTimeoutMs must be a whole number of 1 or more");
  }
  const settleMs = deps.settleSeconds * 1000;
  const failedDir = join(dir, FAILED_DIR);

  // Files being watched for the settle window, by name.
  const seen = new Map<string, Seen>();
  // Files not to try again while their signature holds: they could not be
  // moved to failed, or their inbox copy could not be deleted after import.
  const handled = new Map<string, string>();
  // Failures of a file while storage and the database answered, by key,
  // for the signature they were counted against.
  const strikes = new Map<string, { signature: string; count: number }>();
  // The outage in progress: how many checks (or, for a fault the checks
  // cannot see, held tries) have failed in a row, when (on the injected
  // clock) the next is due, and whether the checks can see it.
  let outage: { checks: number; retryAt: number; unseen: boolean } | undefined;
  // Held tries in a row under a fault the checks cannot see, 0 when none: it
  // outlives the outage record, which ends at each try.
  let unseenTries = 0;

  async function currentSignature(path: PathLike): Promise<string | undefined> {
    try {
      return signature(await lstat(path, { bigint: true }));
    } catch {
      return undefined;
    }
  }

  /** Runs both checks; returns what failed, or undefined when both pass. */
  async function checkEnvironment(): Promise<string | undefined> {
    const [database, store] = await Promise.allSettled([
      withTimeout(probes.database, "database", probeTimeoutMs),
      withTimeout(probes.store, "storage", probeTimeoutMs),
    ]);
    const failed: string[] = [];
    if (database.status === "rejected") failed.push(`database: ${errorText(database.reason)}`);
    if (store.status === "rejected") failed.push(`storage: ${errorText(store.reason)}`);
    return failed.length === 0 ? undefined : failed.join("; ");
  }

  function backoffMs(checks: number): number {
    return Math.min(BACKOFF_FIRST_MS * 2 ** (checks - 1), BACKOFF_MAX_MS);
  }

  /**
   * Whether an outage still holds the imports back. When the next check is
   * due it runs: a failure doubles the wait, a pass ends the outage.
   */
  async function outageHolds(): Promise<boolean> {
    if (outage === undefined) return false;
    if (now() < outage.retryAt) return true;
    const why = await checkEnvironment();
    if (why !== undefined) {
      if (outage.unseen) {
        // The fault the checks could not see is one they see now.
        outage.unseen = false;
        unseenTries = 0;
        log(
          `inbox: storage or the database is not answering (${why}); no file is tried until a ` +
            "check passes",
        );
      }
      outage.checks += 1;
      outage.retryAt = now() + backoffMs(outage.checks);
      return true;
    }
    if (outage.unseen) {
      // The checks passed before and pass now; only a try of the files tells.
      unseenTries = outage.checks;
      outage = undefined;
      return false;
    }
    const checks = `${outage.checks} failed check${outage.checks === 1 ? "" : "s"}`;
    log(`inbox: storage and the database answer again after ${checks}; importing again`);
    outage = undefined;
    unseenTries = 0;
    return false;
  }

  /** Moves the file to failed with its reason file; returns the name it took. */
  async function moveToFailed(name: string, path: PathLike, reason: string): Promise<string> {
    await mkdir(failedDir, { recursive: true });
    for (let n = 1; n <= 1000; n += 1) {
      const candidate = failedName(name, n);
      const target = join(failedDir, candidate);
      const reasonPath = `${target}${REASON_SUFFIX}`;
      if (await exists(target)) continue;
      // Creating the reason file exclusively claims the name.
      try {
        await writeFile(reasonPath, `${reason}\n`, { flag: "wx" });
      } catch (error) {
        if (codeOf(error) === "EEXIST") continue;
        throw error;
      }
      try {
        await rename(path, target);
      } catch (error) {
        await unlink(reasonPath).catch(() => undefined);
        throw error;
      }
      return candidate;
    }
    throw new Error("no free name in the failed folder after 1000 tries");
  }

  /** Moves the file to failed; key is what seen and handled know it by. */
  async function fail(
    key: string,
    name: string,
    path: PathLike,
    reason: string,
    pass: InboxPass,
  ): Promise<void> {
    seen.delete(key);
    try {
      const moved = await moveToFailed(name, path, reason);
      pass.failed.push({ name, reason });
      log(`inbox: moved ${name} to ${FAILED_DIR}/${moved}: ${reason}`);
    } catch (error) {
      const sig = await currentSignature(path);
      if (sig !== undefined) handled.set(key, sig);
      log(
        `inbox: could not move ${name} to ${FAILED_DIR} (${errorText(error)}); it stays in the ` +
          `inbox and is not tried again until it changes. Why it failed: ${reason}`,
      );
    }
  }

  /**
   * The import this copy of the file already made, if any: an earlier
   * attempt, in this process or one before a restart, whose commit landed but
   * whose answer was lost. The question fails while the database is down,
   * which keeps the file from being uploaded.
   */
  async function earlierImport(
    name: string,
    path: string,
    entry: Seen,
    arrived: Date,
  ): Promise<{ modelId: string; fileId: string } | undefined> {
    entry.hash ??= await hashFile(path);
    const found = await findImported({
      originalName: name,
      size: entry.hash.size,
      sha256: entry.hash.sha256,
      since: arrived,
    });
    if (found !== undefined) {
      log(
        `inbox: ${name} was already imported as model ${found.modelId} by an earlier attempt ` +
          "whose answer was lost; it is not imported again",
      );
    }
    return found;
  }

  /**
   * Counts a failure against the file, storage and the database having
   * answered. The strike holds until the pass ends (settleStrike), since a
   * second file failing in the same pass takes it back.
   */
  function strike(name: string, path: string, entry: Seen, error: unknown, state: PassState): void {
    const prior = strikes.get(name);
    const count = prior?.signature === entry.signature ? prior.count + 1 : 1;
    log(
      `inbox: ${name} could not be imported (try ${count} of ${STRIKES}; storage and the ` +
        `database answer, so it counts against the file): ${errorText(error)}`,
    );
    strikes.set(name, { signature: entry.signature, count });
    state.struck = { name, path, error, prior, count };
  }

  /**
   * At the end of a pass: takes back its strike when a fault the checks
   * cannot see held the pass; otherwise moves a file on its STRIKES-th
   * strike in a row for the same signature to failed, with the error as its
   * reason.
   */
  async function settleStrike(state: PassState): Promise<void> {
    const struck = state.struck;
    if (struck === undefined) return;
    if (state.unseen) {
      if (struck.prior === undefined) strikes.delete(struck.name);
      else strikes.set(struck.name, struck.prior);
      return;
    }
    if (struck.count < STRIKES) return;
    strikes.delete(struck.name);
    await fail(
      struck.name,
      struck.name,
      struck.path,
      repeatedErrorReason(struck.error),
      state.pass,
    );
  }

  /**
   * Imports one settled file; arrived is when it reached the inbox (its
   * ctime when first seen). Returns "outage" when the pass must stop.
   */
  async function importOne(
    name: string,
    path: string,
    entry: Seen,
    arrived: Date,
    state: PassState,
  ): Promise<"outage" | "done"> {
    const { pass } = state;
    state.tried = true;
    let result: { modelId: string; fileId: string };
    try {
      result =
        (await earlierImport(name, path, entry, arrived)) ??
        (await ingest.ingestFile({ tmpPath: path, originalName: name, target: "new" }));
    } catch (error) {
      if (codeOf(error) === "ENOENT" && !(await exists(path))) {
        // Taken away while it was being read: nothing left to import or move.
        seen.delete(name);
        strikes.delete(name);
        log(`inbox: ${name} was removed from the inbox while it was being imported`);
        return "done";
      }
      if (error instanceof IngestError && error.code !== "storage_unavailable") {
        // Ingest's own refusal: the file's type or content.
        strikes.delete(name);
        await fail(name, name, path, sentence(error.message), pass);
        return "done";
      }
      // Not the file's fault until shown to be: check the environment.
      const why = await checkEnvironment();
      if (why !== undefined) {
        outage = { checks: 1, retryAt: now() + BACKOFF_FIRST_MS, unseen: false };
        log(
          `inbox: storage or the database is not answering (${why}); ${name} and the files ` +
            `after it stay in the inbox, and no file is tried until a check passes, the next in ` +
            `${BACKOFF_FIRST_MS / 1000} s, then backing off to every ${BACKOFF_MAX_MS / 60_000} ` +
            `minutes. The import failed with: ${errorText(error)}`,
        );
        return "outage";
      }
      const first = state.struck;
      if (first !== undefined) {
        // A second file failing in one pass, with the checks passing: the
        // fault is one the checks cannot see, such as a write fault.
        const checks = unseenTries + 1;
        const wait = backoffMs(checks);
        outage = { checks, retryAt: now() + wait, unseen: true };
        state.unseen = true;
        if (unseenTries === 0) {
          log(
            `inbox: ${first.name} and ${name} both failed in this pass while storage and the ` +
              "database answered their checks, so the fault is taken to be one the checks cannot " +
              "see (a full database disk, say), not the files': neither counts against its file, " +
              `and they and the files after them stay in the inbox. The next try is in ` +
              `${wait / 1000} s, backing off to every ${BACKOFF_MAX_MS / 60_000} minutes. The ` +
              `errors: ${errorText(first.error)}; ${errorText(error)}`,
          );
        }
        return "outage";
      }
      strike(name, path, entry, error, state);
      return "done";
    }
    strikes.delete(name);
    seen.delete(name);
    pass.imported.push({ name, ...result });

    let verdict: "match" | "changed" | "unconfirmed";
    try {
      const stored = await storedFile(result.fileId);
      if (stored === undefined) {
        verdict = "unconfirmed";
        log(`inbox: imported ${name}, but no record of the stored file ${result.fileId} was found`);
      } else {
        const local = await hashFile(path);
        verdict =
          local.size === stored.size && local.sha256.equals(stored.sha256) ? "match" : "changed";
      }
    } catch (error) {
      if (codeOf(error) === "ENOENT" && !(await exists(path))) {
        log(`inbox: imported ${name} as model ${result.modelId}; its inbox copy was already gone`);
        return "done";
      }
      verdict = "unconfirmed";
      log(`inbox: imported ${name}, but could not confirm the stored copy: ${errorText(error)}`);
    }

    if (verdict === "match") {
      try {
        await unlink(path);
        log(`inbox: imported ${name} as model ${result.modelId} and deleted the inbox copy`);
      } catch (error) {
        const sig = await currentSignature(path);
        if (sig !== undefined) handled.set(name, sig);
        log(
          `inbox: imported ${name} as model ${result.modelId} but could not delete the inbox ` +
            `copy (${errorText(error)}); it is not imported again until it changes`,
        );
      }
      return "done";
    }
    await fail(name, name, path, verdict === "changed" ? CHANGED_REASON : UNCONFIRMED_REASON, pass);
    return "done";
  }

  async function runPass(): Promise<InboxPass> {
    const pass: InboxPass = { imported: [], failed: [], waiting: false };
    const state: PassState = { pass, tried: false, unseen: false };
    let names: Array<InboxName & { raw: Buffer }>;
    try {
      // Raw bytes: a name that is not UTF-8 would otherwise come back with
      // U+FFFD in it, lstat would not find it, and it would sit unseen.
      const entries = await readdir(dir, { withFileTypes: true, encoding: "buffer" });
      names = entries
        .filter((e) => e.isFile())
        .map((e) => ({ ...inboxName(e.name), raw: e.name }))
        .filter((n) => n.name !== FAILED_DIR && !isIgnoredName(n.name))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    } catch (error) {
      if (codeOf(error) === "ENOENT") {
        try {
          await mkdir(dir, { recursive: true });
        } catch (mkdirError) {
          log(`inbox: could not create ${dir}: ${errorText(mkdirError)}`);
        }
      } else {
        log(`inbox: could not read ${dir}: ${errorText(error)}`);
      }
      return pass;
    }

    // Forget files no longer in the inbox.
    const present = new Set(names.map((n) => n.key));
    for (const key of seen.keys()) if (!present.has(key)) seen.delete(key);
    for (const key of handled.keys()) if (!present.has(key)) handled.delete(key);
    for (const key of strikes.keys()) if (!present.has(key)) strikes.delete(key);

    // During an outage no file is tried until a check passes.
    if (await outageHolds()) pass.waiting = true;

    for (const { key, name, utf8, raw } of names) {
      // Only a UTF-8 name has a string path; ingest takes nothing else.
      const path = utf8 ? join(dir, name) : Buffer.concat([Buffer.from(dir + sep), raw]);
      let st: BigIntStats;
      try {
        st = await lstat(path, { bigint: true });
      } catch {
        // Gone since the listing.
        seen.delete(key);
        continue;
      }
      if (!st.isFile()) continue;
      // Read per file: an import earlier in this pass may have taken a while.
      const at = now();
      const sig = signature(st);
      if (handled.get(key) === sig) continue;
      handled.delete(key);

      const before = seen.get(key);
      if (before === undefined || before.signature !== sig) {
        seen.set(key, { signature: sig, since: at, arrived: st.ctime });
        continue;
      }
      if (at - before.since < settleMs) continue;

      if (typeof path !== "string") {
        log(`inbox: ${name} has a name that is not valid UTF-8 (bytes ${raw.toString("hex")})`);
        await fail(key, name, path, NON_UTF8_REASON, pass);
        continue;
      }
      if (st.size > BigInt(MAX_INBOX_BYTES)) {
        log(`inbox: ${name} is ${st.size} bytes, over the ${MAX_INBOX_BYTES}-byte limit`);
        strikes.delete(key);
        await fail(key, name, path, TOO_LARGE_REASON, pass);
        continue;
      }
      if (pass.waiting) continue;
      if ((await importOne(name, path, before, before.arrived, state)) === "outage") {
        pass.waiting = true;
        break;
      }
    }
    await settleStrike(state);
    if (unseenTries > 0 && state.tried && outage === undefined) {
      const tries = `${unseenTries} held tr${unseenTries === 1 ? "y" : "ies"}`;
      log(
        `inbox: no second file failed in this pass after ${tries}, so the fault the checks ` +
          "could not see is over; importing again",
      );
      unseenTries = 0;
    }
    return pass;
  }

  let running: Promise<InboxPass> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let stopped = true;

  /** Runs one pass; a call while a pass runs gets that pass. */
  function pollOnce(): Promise<InboxPass> {
    if (running === undefined) {
      running = runPass().finally(() => {
        running = undefined;
      });
    }
    return running;
  }

  async function loop(): Promise<void> {
    if (stopped) return;
    try {
      await pollOnce();
    } catch (error) {
      log(`inbox: a poll failed: ${errorText(error)}`);
    }
    // During an outage the next pass comes when the next check is due.
    const wait = outage === undefined ? pollMs : Math.max(pollMs, outage.retryAt - now());
    if (!stopped) timer = setTimeout(loop, wait);
  }

  return {
    pollOnce,
    /** Polls now and then every pollMs, each pass after the last one ends. */
    start(): void {
      if (!stopped) return;
      stopped = false;
      timer = setTimeout(loop, 0);
    },
    /** Stops polling and waits for a pass in flight. */
    async stop(): Promise<void> {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (running !== undefined) await running.catch(() => undefined);
    },
  };
}

export type InboxWatcher = ReturnType<typeof createInboxWatcher>;
