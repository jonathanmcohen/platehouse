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
//   The listing's lstat is not the only check, since a writer can rename a
//   symlink over a settled file after it: a settled file is opened once,
//   with O_NOFOLLOW, and fstat on the open file must show the regular file
//   that settled (the same device, inode, size and mtime). Otherwise nothing
//   is read, the file is looked at again from the start, and a symlink there
//   is ignored as any symlink is. Everything after reads that open file,
//   never the inbox path again: its hash, and a copy in TMP_DIR/inbox-copies
//   that ingest reads and that is deleted once ingest is done with it.
// - The copy holds no more than the size that settled (the fstat size), so
//   bytes appended after the check never reach it and what ingest stores is
//   never larger than the size the size limit was checked against. After
//   the copy, the copy's size and a fresh fstat must still match what
//   settled. A file that grew, shrank or was written to after it settled (a
//   stalled copy that resumed, a writer still appending) is not imported on
//   that pass and takes no strike: it is looked at again from the start and
//   imported as it is once it settles again.
// - A file is settled when its size and mtime (and device and inode, so a
//   replaced file counts as new) are unchanged across consecutive polls for
//   INBOX_SETTLE_SECONDS. The window starts when a poll first sees the
//   current size and mtime, never at the mtime itself: a copy that keeps its
//   source's mtime (rsync -t, cp -p) would otherwise look settled at once.
//   The clock is read for each file as it is looked at, not once per pass,
//   so a slow import earlier in a pass does not shorten a later file's window.
// - A settled file goes to ingestFile. Once it returns, the watcher runs
//   onIngested with the stored file, as the ingest queue's worker does
//   (jobs/queues.ts), so an inbox file's plates are queued for estimates
//   (Task 12) as soon as it is stored, not at the next Orca poll. It runs too
//   for an earlier attempt's import found by its id (below), since that
//   attempt's answer was lost before it could. A failure there is logged,
//   never thrown: the file is stored, and the Orca poll queues what was
//   missed. Then the watcher reads
//   the size and SHA-256 that ingest recorded for the stored file and hashes
//   the open inbox file again; the inbox copy is deleted only when both match
//   and its name still holds that same file (AC-021: deleted once the upload
//   is verified). If the copy changed in the meantime, another file was put
//   under its name, or the record cannot be read, what holds the name is
//   moved to failed with a reason that says a model was made, so it is
//   neither lost nor imported a second time. A symlink or anything else that
//   is not a regular file found under the name then is left alone.
// - The delete itself never deletes by name, since that deletes whatever the
//   name holds at that moment, and rsync renames a new file over a name. What
//   holds the name is renamed into a new folder of its own in the inbox
//   (HOLD_PREFIX, a dot-folder, so on the inbox's filesystem and never
//   listed), and deleted there only when it is the open file (the same
//   device and inode). A file put under the name after the check is put back
//   under it, never over a file that took the name since, and looked at from
//   the start as a new file; when another file took the name meanwhile, it
//   moves to failed with SWAPPED_REASON instead. The holding folder is
//   removed after. One a stopped process left behind (a crash in that
//   moment) is emptied into failed with HELD_REASON at the first pass.
// - A file that goes to failed (the rules below) moves to failed/<name> ("<stem> (2)<ext>"
//   and so on when the name is taken) with <name>.reason.txt beside it,
//   holding one plain sentence. failed/ is made when missing, and refused
//   when it is anything but a real folder (a symlink copied in by rsync -a,
//   say): nothing moves through it, and each file that would have is logged
//   and left in the inbox, as a file that cannot be moved is (below).
// - The folder is listed as raw bytes, so a name that is not valid UTF-8 (a
//   Latin-1 name from an old archive, say) still reaches lstat and the move.
//   Ingest takes the file by a string path, which cannot spell such a name,
//   so once settled the file moves to failed under its name with each bad
//   byte shown as U+FFFD, with a reason that says to rename it.
// - A settled file larger than MAX_INBOX_BYTES (the upload limit,
//   MAX_UPLOAD_BYTES from uploads/tus.ts: 512 MiB) moves to failed from its
//   size alone, before anything is read or uploaded.
// - A file goes to failed at once only for a reason that belongs to the
//   file: ingest's IngestError with code unsupported_type (its type or
//   content) or model_not_found (FILE_FAULTS), or the watcher's own
//   refusals, the size limit and a name that is not UTF-8. Since Task 9,
//   ingest wraps every failure that is not its own in IngestError
//   ingest_failed, with the error it met as the cause: a database or
//   filesystem fault, or anything else that failed before COMMIT. That says
//   the save failed, not that the file is bad, so ingest_failed,
//   storage_unavailable, IngestOutcomeUnknown (the commit's outcome is not
//   known) and any other error, from any source (the store, the database,
//   findImported, anything unexpected), are not the file's fault until shown
//   to be. A damaged .3mf is not a failure at all: ingest stores it as a
//   model with parse status no_plate_data (AC-023). For such an error the
//   file stays where it is, the pass stops, and the watcher checks the
//   environment once (probes, inboxProbes): the database check reads, then
//   in a transaction it rolls back writes a model, a pending blob and a file
//   row, the rows every import writes; the store check lists under models/,
//   then puts and deletes the store's write-check object, whose key is
//   outside models/ so the orphan sweep never sees it; the temp folder check
//   writes a 4 KiB file in TMP_DIR/inbox-copies, flushes it and deletes it.
//   Each check has PROBE_TIMEOUT_MS (5 s). Logs and reasons quote the error with its
//   causes, and two errors are compared by the cause inside ingest's
//   wrappers (faultOf), not by the wrapper's code.
//   - A copy that cannot be written in TMP_DIR/inbox-copies (TMP_DIR full,
//     read-only, unwritable, not a folder or gone: ENOSPC, EROFS, EACCES,
//     EPERM, ENOTDIR, ENOENT and the like, from making the folder, creating
//     the file, writing or closing it) is the environment's fault, never the
//     file's, so it never counts against the file. The checks run: when one
//     fails, it is an outage as below. When they all pass (a temp folder with
//     room for the check but not the copy), it is still an outage: the file
//     and those after it wait, the next try comes BACKOFF_FIRST_MS later,
//     doubling with each copy that fails in a row up to BACKOFF_MAX_MS, and
//     the first copy that is written ends it, logged. A failure reading the
//     inbox file itself is not this: it is handled like any other error.
//   - A check fails: it is an outage. It is logged once when it starts, with
//     the error, and once when it ends. No file is tried, and so none is
//     uploaded, until a check passes. The checks back off: the next comes
//     BACKOFF_FIRST_MS (5 s) later, the wait doubles after each failed
//     check up to BACKOFF_MAX_MS (5 minutes), and it starts again at 5 s
//     after a good pass. A fault in the environment never moves the inbox to
//     failed one file at a time, and never uploads a file on every poll.
//     Because the checks write, a fault that breaks the writes an import
//     makes but not reads (the data disk full, 53100; a write I/O error,
//     58030; a bucket that lists but refuses writes) is seen here, as an
//     outage, whenever it also fails the checks' own writes.
//   - All three checks pass: the error counts against that file. After STRIKES
//     (3) such failures in a row while its size, mtime and inode stay the
//     same, it moves to failed with a reason quoting the error; a change to
//     the file starts its count again. The pass goes on to the next file, so
//     one file cannot hold up the inbox. The move of a file on its last
//     strike waits for the end of the pass, for the rule below, and happens
//     only when the name still holds the file that was struck (the same
//     device, inode, size and mtime): a corrected copy or a symlink put there
//     in the meantime is not moved, and is looked at again from the start.
//     An ingest refusal (FILE_FAULTS) is moved under the same check.
//   - All three checks pass, and another file has already failed in this pass
//     with the checks passing and the same fault (the same error code, or,
//     when neither has a code, the same error name): the fault is taken to be
//     one the checks cannot see, not the files'. The checks' writes are
//     small and rolled back or deleted, so a fault can still miss them: a
//     full disk fails an insert only when the table file must grow, and a
//     rolled-back write is not flushed. Neither failure counts against its
//     file (the first file's strike is taken back, and it is not moved to
//     failed even on what would have been its last), the files stay where
//     they are and the pass stops. It is logged once when it starts, with
//     both errors, and once when it ends. The checks cannot say when such a
//     fault ends, so a try of the files does: the next comes
//     BACKOFF_FIRST_MS later and, while each try ends the same way, the wait
//     doubles up to BACKOFF_MAX_MS as above. It ends at the first pass that
//     leaves no hold armed: one that tries a file without two failing the
//     same way, or one with no held file left to try (taken out of the inbox,
//     or moved to failed). The hold's memory (unseenTries) is cleared then,
//     so a later fault starts a hold of its own, from 5 s and logged. Two
//     files that fail with different errors are each taken to be bad on
//     their own: each takes its strike and the pass goes on.
//   - Two files can each be bad on their own and fail the same way (two
//     unreadable files, EACCES; two that break the parser alike), which
//     nothing tells from such a fault. So the hold does not last for ever:
//     once the wait between tries has reached BACKOFF_MAX_MS, each try
//     counts against the files that fail, as when one file fails alone, and
//     the pass goes on to the files after them. The tries stay BACKOFF_MAX_MS
//     apart while two files still fail the same way, and it is logged once
//     when they start to count. So two such files reach failed after
//     STRIKES of those tries, and the files after them import at the first.
//     A fault the checks cannot see that lasts that long (about 10 minutes of
//     held tries, then STRIKES tries 5 minutes apart, about 20 minutes in
//     all) moves the files it meets to failed, as does one with only one
//     file in the inbox, or files settling far enough apart that no two are
//     tried in one pass, which cost each file 3 tries before it moves to
//     failed.
// - A commit can land with its answer lost when the database connection drops
//   (ingest then throws the connection error it met), and the process can
//   restart before the file is tried again (a container recreate, a crash, a
//   host reboot that stops Postgres mid-commit). So the watcher chooses the
//   file row's id itself and passes it to ingest (inboxFileId): UUIDv7-shaped,
//   derived from the file's name, size, SHA-256 and the time it reached the
//   inbox, so the same copy gets the same id in this process and the next.
//   Before every ingest it asks findImported (repos files.findImported), in
//   one query, for the rows under every id this copy can have (attempt 0 up
//   to MAX_INBOX_IDS). Only an inbox attempt for this copy can have
//   written it: an upload of the same name and bytes through the web UI or
//   the API (tus) gets a random id, so it never stands in for the inbox copy,
//   whenever it came. The arrival time is the file's ctime, which a copy, a
//   move or a rename sets, unlike its mtime, and which survives a restart
//   because it is on disk. ctime also moves on any metadata change (chmod,
//   chown, an xattr or ACL write such as Samba storing a Finder xattr, a
//   link-count change), so the watcher takes it when a poll first sees the
//   file's size, mtime and inode and keeps that value while they stay the
//   same: a metadata change during an outage does not move it. That memory
//   is the process's own. After a restart the next process reads the ctime
//   afresh, so a metadata change made after a lost answer and before a
//   restart can still let the file be imported twice. Birth time is not used
//   instead: a move within one filesystem keeps the inode and its birth time
//   from before the file reached the inbox, so the same file moved in again
//   after an earlier import would get that import's id and be deleted
//   without a model of its own. A live row under any of the ids is the
//   import, so it is not made twice; the inbox copy is checked and deleted
//   as after any import. A row whose model is in the trash or being purged
//   (the lost answer's model, trashed before the retry) does not count: a
//   purge deletes its stored bytes, so with no live row this copy is
//   imported as a model of its own under the lowest id with no row (attempt
//   1, 2 and so on, up to MAX_INBOX_IDS). Every id is asked about, not only
//   those up to the first with no row, because a purge can delete an
//   earlier attempt's row after a later attempt committed with its answer
//   lost. The question comes before the upload, so a database that does not
//   answer it stops the file before anything reaches the bucket.
//
// No file is retried in a loop and none is dropped without a word. A file that
// cannot be moved to failed (or whose inbox copy cannot be deleted after a
// verified import) stays in the inbox, is logged, and is not tried again
// while its size, mtime and inode stay the same; a new copy under the same
// name is a new file. That memory is the process's own, so after a restart
// such a file is tried once more.
//
// Nothing here starts on import: the server calls start() once at boot and
// stop() on shutdown (plan Task 30 builds that code). It must pass every one
// of these, and the type requires each:
//   dir:           INBOX_DIR, the inbox folder
//   settleSeconds: INBOX_SETTLE_SECONDS
//   tmpDir:        TMP_DIR, where the copies ingest reads go
//   ingest:        the ingest service (createIngest), for its ingestFile
//   storedFile:    (id) => files.get(id), from the files repository
//   findImported:  (q) => files.findImported(q), from the files repository
//   onIngested:    (r) => estimates.enqueueFile(r.fileId), the estimates
//                  service (createEstimates), so an inbox file's plates are
//                  queued at once; enqueueFile takes the file id, not the
//                  IngestResult, so it cannot be passed bare
//   probes:        inboxProbes({ db, store, tmpDir }), with db the Kysely
//                  database, store the real blob store (it needs checkWrite
//                  as well as listPage) and tmpDir the same TMP_DIR as above
// The rest (probeTimeoutMs, pollMs, now, log) have defaults.
// pollOnce() runs one pass and is what the tests drive, with an injected
// clock instead of real waits; during an outage a pass before the next check
// is due tries no file.
import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import type { BigIntStats, PathLike } from "node:fs";
import { constants } from "node:fs";
import {
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, sep } from "node:path";
import { type Kysely, sql } from "kysely";
import { uuidv7 } from "../db/ids.js";
import type { DB } from "../db/types.js";
import {
  type Ingest,
  IngestError,
  type IngestErrorCode,
  IngestOutcomeUnknown,
  type IngestResult,
} from "../ingest/ingest.js";
import type { ImportedFile, ImportedQuery } from "../repos/files.js";
import { createRepos } from "../repos/index.js";
import type { BlobStore } from "../storage/s3.js";
import { MAX_UPLOAD_BYTES } from "../uploads/tus.js";

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

/**
 * What starts the name of the folder, inside the inbox, that an imported
 * file is moved into to be checked and deleted. It starts with a dot, so the
 * watcher never lists it as an inbox file, and it is in the inbox, so the
 * move is a rename on one filesystem.
 */
export const HOLD_PREFIX = ".platehouse-deleting-";

/** Reason when a file put under an imported file's name cannot be put back there. */
export const SWAPPED_REASON =
  "This file was put in the inbox under the name of a file Platehouse had just imported, and another file took that name before it could be put back, so it was kept here and not imported; add it again.";

/** Reason for a file a stopped process left in a holding folder. */
export const HELD_REASON =
  "Platehouse stopped while it was deleting this file after an import, so it was kept here; check the library before adding it again.";

/** Reason when the file's name is not valid UTF-8. */
export const NON_UTF8_REASON =
  "Platehouse could not import this file because its name is not valid UTF-8; rename it and add it again.";

/**
 * The largest file the inbox takes, in bytes: the upload limit
 * (MAX_UPLOAD_BYTES in uploads/tus.ts, Task 9), 512 MiB.
 */
export const MAX_INBOX_BYTES = MAX_UPLOAD_BYTES;

/**
 * The IngestError codes that are about the file itself, so the file moves to
 * failed at once: its type or content (unsupported_type), or the model it
 * was meant for (model_not_found; the inbox always asks for a new model, so
 * this one is for completeness). Every other failure of ingest, ingest_failed
 * and storage_unavailable and IngestOutcomeUnknown among them, says nothing
 * about the file and goes through the checks.
 */
const FILE_FAULTS: ReadonlySet<IngestErrorCode> = new Set(["unsupported_type", "model_not_found"]);

/**
 * The reason for a file larger than maxBytes, giving the limit in bytes and
 * in MiB (to one decimal place, with no trailing .0), both worked out from
 * maxBytes so that neither goes stale when the upload limit changes.
 */
export function tooLargeReason(maxBytes: number): string {
  const mib = Number((maxBytes / 1_048_576).toFixed(1));
  return (
    `Platehouse could not import this file because it is larger than ${maxBytes} bytes ` +
    `(${mib} MiB), the most it takes; nothing was uploaded.`
  );
}

/** Reason when the file is larger than MAX_INBOX_BYTES. */
export const TOO_LARGE_REASON = tooLargeReason(MAX_INBOX_BYTES);

/** Failures in a row, with the checks passing, before a file moves to failed. */
export const STRIKES = 3;

/** How long each environment check may take before it counts as failed. */
export const PROBE_TIMEOUT_MS = 5_000;

/** The wait before the first retry after an outage starts; it doubles on each failed check. */
export const BACKOFF_FIRST_MS = 5_000;

/** The longest wait between checks during an outage. */
export const BACKOFF_MAX_MS = 300_000;

/**
 * How many file ids one inbox copy can go through (inboxFileId's attempt,
 * 0 up): one more each time the row under the last one belongs to a model
 * in the trash or being purged. All of them are asked about in one query
 * before every ingest.
 */
export const MAX_INBOX_IDS = 100;

/**
 * The file row id an inbox attempt asks ingest to use for this copy of the
 * file: UUIDv7-shaped (version 7, RFC 9562 variant), its time field the
 * copy's arrival (its ctime when first seen) and every other bit from the
 * SHA-256 of the name, size, SHA-256 and arrival time, with attempt (0 up)
 * moving on past a row whose model was trashed. The same copy gives the same
 * id in this process and in the next, so an attempt whose answer was lost is
 * found by its id (files.findImported), and no row another path wrote can
 * stand in for it: an upload through the web UI or the API gets a random id.
 */
export function inboxFileId(file: {
  name: string;
  size: number;
  sha256: Buffer;
  arrived: Date;
  attempt: number;
}): string {
  const ms = file.arrived.getTime();
  const b = createHash("sha256")
    .update(
      `platehouse-inbox-v1\0${file.name}\0${file.size}\0${file.sha256.toString("hex")}\0${ms}\0${file.attempt}`,
      "utf8",
    )
    .digest();
  // The time field when it fits in 48 bits (it always does for a real ctime).
  if (Number.isInteger(ms) && ms >= 0 && ms < 2 ** 48) b.writeUIntBE(ms, 0, 6);
  b[6] = 0x70 | ((b[6] ?? 0) & 0x0f);
  b[8] = 0x80 | ((b[8] ?? 0) & 0x3f);
  const hex = b.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The reason a file takes when it failed STRIKES times while storage and the database answered. */
export function repeatedErrorReason(error: unknown): string {
  return (
    `Platehouse tried to import this file ${STRIKES} times while storage and the database were ` +
    `answering and it failed each time, last with "${errorText(error)}".`
  );
}

/** The folder in TMP_DIR that ingest reads the watcher's copies from. */
export const COPY_DIR = "inbox-copies";

/** What ends the name of each copy in COPY_DIR, so a sweep removes only those. */
const COPY_SUFFIX = ".inbox-copy";

/** What the temp folder check writes: one 4 KiB block, so a full filesystem refuses it. */
const TMP_CHECK_BYTES = Buffer.alloc(4096);

/** How much of the inbox file the copy reads and writes at a time. */
const COPY_CHUNK_BYTES = 1_048_576;

/**
 * A failure writing the copy in TMP_DIR/inbox-copies (making the folder,
 * creating the file, writing or closing it): the environment's fault, never
 * the file's, so it is an outage and never a strike. A failure reading the
 * inbox file is not one of these.
 */
class CopyWriteError extends Error {
  constructor(folder: string, cause: unknown) {
    super(`could not write the copy ingest reads in the temp folder ${folder}`, { cause });
    this.name = "CopyWriteError";
  }
}

/**
 * Cheap checks that the database, the store and the temp folder answer; each
 * rejects when it does not.
 */
export interface InboxProbes {
  database(): Promise<unknown>;
  store(): Promise<unknown>;
  /** That TMP_DIR/inbox-copies takes a write, as the copy ingest reads needs. */
  tmpDir(): Promise<unknown>;
}

/** Thrown inside the database check's transaction so that it rolls back. */
class RollBack extends Error {}

/**
 * The checks the server wires in. Each reads and writes, as an import does.
 *
 * The database check reads from files (so a role with no grant fails it),
 * fails when the session is read-only (a standby after a failover, or
 * default_transaction_read_only) or the role may not insert into files, and
 * then, in one transaction it rolls back, inserts a model, a pending blob and
 * a file row: the rows every import writes, through the same repositories.
 * So a fault that breaks writes and not reads fails it whenever it fails
 * those inserts, and nothing is left behind.
 *
 * The store check lists at most one object under models/, where ingest
 * writes, and puts and deletes the store's own write-check object
 * (BlobStore.checkWrite), whose key is outside models/.
 *
 * The temp folder check makes TMP_DIR/inbox-copies when it is missing, as
 * the copy does, then writes TMP_CHECK_BYTES to a new file there, flushes it
 * to disk and deletes it. So a TMP_DIR that is full, read-only, unwritable,
 * not a folder or gone fails it. tmpDir is the same TMP_DIR the watcher is
 * given as its own tmpDir. Like the other checks it cannot see every fault:
 * a temp folder with a little room left takes the check and can still
 * refuse a large copy, which is why a copy that cannot be written is an
 * outage whatever the checks say.
 */
export function inboxProbes(deps: {
  db: Kysely<DB>;
  store: Pick<BlobStore, "listPage" | "checkWrite">;
  tmpDir: string;
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
      try {
        await deps.db.transaction().execute(async (trx) => {
          const repos = createRepos(trx);
          const model = await repos.models.create({ name: "inbox write check" });
          const blobId = uuidv7();
          await repos.blobs.insertPending({
            id: blobId,
            modelId: model.id,
            kind: "source",
            contentType: "model/stl",
            size: 0,
          });
          await repos.files.create({
            modelId: model.id,
            blobId,
            name: "inbox write check.stl",
            originalName: "inbox write check.stl",
            kind: "stl",
            size: 0,
            sha256: Buffer.alloc(32),
          });
          throw new RollBack();
        });
      } catch (error) {
        if (!(error instanceof RollBack)) throw error;
      }
    },
    async store() {
      await deps.store.listPage("models/", { maxKeys: 1 });
      await deps.store.checkWrite();
    },
    async tmpDir() {
      const folder = join(deps.tmpDir, COPY_DIR);
      await mkdir(folder, { recursive: true });
      // Ends in COPY_SUFFIX, so a check cut short is swept with the copies.
      const path = join(folder, `write-check-${uuidv7()}${COPY_SUFFIX}`);
      const handle = await open(path, "wx", 0o600);
      try {
        try {
          await handle.write(TMP_CHECK_BYTES);
          await handle.sync();
        } finally {
          await handle.close();
        }
      } finally {
        await rm(path, { force: true });
      }
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

export type { ImportedFile, ImportedQuery };

export interface InboxWatcherDeps {
  /** The inbox folder (INBOX_DIR); created when missing. */
  dir: string;
  /** INBOX_SETTLE_SECONDS. */
  settleSeconds: number;
  /**
   * TMP_DIR. Ingest reads a copy the watcher makes in TMP_DIR/inbox-copies
   * from the file it opened, never the inbox path, so nothing swapped in
   * under the name after the check is read.
   */
  tmpDir: string;
  ingest: Pick<Ingest, "ingestFile">;
  /** The recorded size and SHA-256 of a stored file (repos files.get). */
  storedFile: (fileId: string) => Promise<StoredFile | undefined>;
  /**
   * The file rows with these ids, in one query, and whether each one's model
   * is live, being neither in the trash nor purged (repos
   * files.findImported). The ids asked about are inboxFileId's for every
   * attempt; ids with no row are left out.
   */
  findImported: (file: ImportedQuery) => Promise<ImportedFile[]>;
  /**
   * Runs after a file is stored, before its inbox copy is checked, as
   * QueueDeps.onIngested does for the ingest queue: Task 12 queues the file's
   * estimates here, (r) => estimates.enqueueFile(r.fileId). Required, so a
   * server that leaves it out fails to compile instead of leaving inbox
   * plates to wait for the Orca poll. A failure is logged, never thrown,
   * since the file is already stored.
   */
  onIngested: (result: IngestResult) => Promise<unknown>;
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
  /** The signature the strike was counted against: the file that failed. */
  signature: string;
  error: unknown;
  /** The file's count before this strike, put back if the strike is taken back. */
  prior: { signature: string; count: number } | undefined;
  count: number;
}

/** What the pass under way has learnt, beside what it returns. */
interface PassState {
  pass: InboxPass;
  /** The files that failed in this pass with the checks passing, in order. */
  struck: PassStrike[];
  /** Whether a file was tried. */
  tried: boolean;
  /** Whether a second failure with the same fault held the pass: a fault the checks cannot see. */
  unseen: boolean;
  /** The error that held the pass, when one did. */
  heldBy?: unknown;
  /**
   * Whether two files failed the same way after the hold had backed off to
   * BACKOFF_MAX_MS, so their tries counted and the hold goes on.
   */
  counting: boolean;
}

/** What importOne holds for an import, released whatever happens. */
interface Held {
  /** The settled file, opened once. */
  handle?: FileHandle;
  /** The copy in TMP_DIR/inbox-copies that ingest reads, until it is deleted. */
  copy?: string | undefined;
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
  return `${st.dev}:${st.size}:${st.mtimeNs}:${st.ino}`;
}

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

// How many causes deep the watcher looks into an error.
const CAUSE_DEPTH = 4;

/**
 * The error that says what went wrong: the cause inside ingest's wrappers
 * (IngestError ingest_failed and IngestOutcomeUnknown carry the error they
 * met as their cause), or the error itself.
 */
function faultOf(error: unknown): unknown {
  let fault = error;
  for (let depth = 0; depth < CAUSE_DEPTH; depth += 1) {
    const wrapper =
      (fault instanceof IngestError && fault.code === "ingest_failed") ||
      fault instanceof IngestOutcomeUnknown;
    if (!wrapper || (fault as Error).cause === undefined) return fault;
    fault = (fault as Error).cause;
  }
  return fault;
}

/**
 * Whether two errors look like the same fault: compared by what is inside
 * ingest's wrappers (faultOf), the same code when either has one, otherwise
 * the same error name.
 */
function sameFault(first: unknown, second: unknown): boolean {
  const a = faultOf(first);
  const b = faultOf(second);
  const code = codeOf(a);
  if (code !== undefined || codeOf(b) !== undefined) return code === codeOf(b);
  const name = (error: unknown) => (error instanceof Error ? error.name : undefined);
  return name(a) === name(b);
}

/** One line of an error and its causes for the log, capped. */
function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < CAUSE_DEPTH && current !== undefined; depth += 1) {
    parts.push(
      current instanceof Error
        ? `${current.name}: ${current.message}`
        : `non-error thrown: ${String(current)}`,
    );
    current = current instanceof Error ? current.cause : undefined;
  }
  const text = parts.join(", caused by ");
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

/**
 * How a settled file is opened: read-only, never through a symlink
 * (O_NOFOLLOW fails with ELOOP on one), and without waiting on a FIFO put in
 * its place (O_NONBLOCK; it has no effect on a regular file). The fstat after
 * the open is the check that counts: a platform without O_NOFOLLOW would
 * follow a link, and the inode it reached would not be the settled one.
 */
const OPEN_SETTLED = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** The size and SHA-256 of an open file, read from its start. */
async function hashHandle(handle: FileHandle): Promise<StoredFile> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) {
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
  const copyDir = join(deps.tmpDir, COPY_DIR);
  // Whether copies a process before this one left behind (a crash during an
  // import) have been swept; done once, before this watcher's first copy.
  let copiesSwept = false;
  // Whether holding folders a process before this one left in the inbox (a
  // crash while an imported file was being deleted) have been swept; done
  // once, at this watcher's first pass.
  let holdsSwept = false;

  // Files being watched for the settle window, by name.
  const seen = new Map<string, Seen>();
  // Files not to try again while their signature holds: they could not be
  // moved to failed, or their inbox copy could not be deleted after import.
  const handled = new Map<string, string>();
  // Failures of a file while the checks passed, by key,
  // for the signature they were counted against.
  const strikes = new Map<string, { signature: string; count: number }>();
  // The outage in progress: how many checks (or, for a fault the checks
  // cannot see, held tries) have failed in a row, when (on the injected
  // clock) the next is due, whether the checks can see it, and whether it is
  // a copy that could not be written while the checks passed (copy), which
  // only a try of the copy can show is over.
  let outage: { checks: number; retryAt: number; unseen: boolean; copy?: boolean } | undefined;
  // Copies in a row that could not be written in the temp folder, 0 when
  // the last one could: the wait before the next try doubles with each.
  let copyFaults = 0;
  // Held tries in a row under a fault the checks cannot see, 0 when none: it
  // outlives the outage record, which ends at each try.
  let unseenTries = 0;
  // Whether the tries under such a fault have started to count against the
  // files (the hold reached BACKOFF_MAX_MS), so that is logged once.
  let unseenCounting = false;

  /** Forgets a fault the checks could not see. */
  function endUnseen(): void {
    unseenTries = 0;
    unseenCounting = false;
  }

  async function currentSignature(path: PathLike): Promise<string | undefined> {
    try {
      return signature(await lstat(path, { bigint: true }));
    } catch {
      return undefined;
    }
  }

  /** Runs the three checks; returns what failed, or undefined when all pass. */
  async function checkEnvironment(): Promise<string | undefined> {
    const [database, store, tmp] = await Promise.allSettled([
      withTimeout(probes.database, "database", probeTimeoutMs),
      withTimeout(probes.store, "storage", probeTimeoutMs),
      withTimeout(probes.tmpDir, "temp folder", probeTimeoutMs),
    ]);
    const failed: string[] = [];
    if (database.status === "rejected") failed.push(`database: ${errorText(database.reason)}`);
    if (store.status === "rejected") failed.push(`storage: ${errorText(store.reason)}`);
    if (tmp.status === "rejected") failed.push(`temp folder: ${errorText(tmp.reason)}`);
    return failed.length === 0 ? undefined : failed.join("; ");
  }

  /** Starts an outage the checks see, logging it once with what failed. */
  function startOutage(name: string, why: string, error: unknown): "outage" {
    outage = { checks: 1, retryAt: now() + BACKOFF_FIRST_MS, unseen: false };
    log(
      `inbox: storage, the database or the temp folder is not answering (${why}); ${name} and ` +
        `the files after it stay in the inbox, and no file is tried until a check passes, the ` +
        `next in ${BACKOFF_FIRST_MS / 1000} s, then backing off to every ` +
        `${BACKOFF_MAX_MS / 60_000} minutes. The import failed with: ${errorText(error)}`,
    );
    return "outage";
  }

  /**
   * A copy that could not be written in the temp folder. It is never the
   * file's fault, so nothing counts against the file. When a check fails too,
   * it is an outage like any other. When the checks pass (a temp folder with
   * room for the check but not the copy, say), it is still an outage: the
   * file and those after it wait, the next try comes BACKOFF_FIRST_MS later,
   * doubling with each copy that fails in a row up to BACKOFF_MAX_MS, and
   * the first copy that is written ends it. Should a check fail later, the
   * outage the checks watch takes over, as if it had started that way.
   */
  async function copyFault(name: string, error: CopyWriteError): Promise<"outage"> {
    const why = await checkEnvironment();
    if (why !== undefined) {
      // The checks see it, so the outage they watch owns it from here.
      copyFaults = 0;
      return startOutage(name, why, error);
    }
    copyFaults += 1;
    const wait = backoffMs(copyFaults);
    outage = { checks: copyFaults, retryAt: now() + wait, unseen: false, copy: true };
    log(
      `inbox: ${name} could not be copied into the temp folder for ingest (${errorText(error)}), ` +
        "though the checks pass; that is not the file's fault, so nothing counts against it, and " +
        `it and the files after it stay in the inbox. The next try is in ${wait / 1000} s, ` +
        `backing off to every ${BACKOFF_MAX_MS / 60_000} minutes while copies still fail`,
    );
    return "outage";
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
      if (outage.unseen || outage.copy) {
        // The fault the checks could not see is one they see now.
        if (outage.unseen) endUnseen();
        if (outage.copy) copyFaults = 0;
        outage.unseen = false;
        outage.copy = false;
        log(
          `inbox: storage, the database or the temp folder is not answering (${why}); no file ` +
            "is tried until a check passes",
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
    if (outage.copy) {
      // Only a try of the copy tells whether the temp folder takes it now.
      outage = undefined;
      return false;
    }
    const checks = `${outage.checks} failed check${outage.checks === 1 ? "" : "s"}`;
    log(
      `inbox: storage, the database and the temp folder answer again after ${checks}; ` +
        "importing again",
    );
    outage = undefined;
    endUnseen();
    return false;
  }

  /**
   * Makes the failed folder when it is missing, and refuses one that is not
   * a real folder: a symlink (copied in by rsync -a, or made on purpose)
   * would send inbox files, under names their writer chose, into whatever it
   * points at.
   */
  async function failedFolder(): Promise<void> {
    let st: BigIntStats;
    try {
      st = await lstat(failedDir, { bigint: true });
    } catch (error) {
      if (codeOf(error) !== "ENOENT") throw error;
      try {
        await mkdir(failedDir);
      } catch (mkdirError) {
        if (codeOf(mkdirError) !== "EEXIST") throw mkdirError;
      }
      st = await lstat(failedDir, { bigint: true });
    }
    if (!st.isDirectory()) {
      const what = st.isSymbolicLink() ? "a symlink, not a folder" : "not a folder";
      throw new Error(
        `${failedDir} is ${what}, so nothing is moved into it; replace it with a real folder`,
      );
    }
  }

  /** Moves the file to failed with its reason file; returns the name it took. */
  async function moveToFailed(name: string, path: PathLike, reason: string): Promise<string> {
    await failedFolder();
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
   * Puts a file that was moved out from under its name back there, never
   * over a file that took the name since. A regular file is hard-linked
   * back, which fails when the name is taken, and then unlinked from where it
   * was held. On a filesystem without hard links, and for anything that is
   * not a regular file (link could follow a symlink), it is renamed back
   * only once the name is seen to be free. Returns false when the name is
   * taken.
   */
  async function putBack(held: string, path: string, regular: boolean): Promise<boolean> {
    if (regular) {
      let linked = false;
      try {
        await link(held, path);
        linked = true;
      } catch (error) {
        if (codeOf(error) === "EEXIST") return false;
        // No hard links here: renamed back below, once the name is free.
      }
      if (linked) {
        try {
          await unlink(held);
        } catch (error) {
          log(
            `inbox: put ${path} back, but could not remove its second name ${held} ` +
              `(${errorText(error)}); it moves to ${FAILED_DIR} when the watcher next starts`,
          );
        }
        return true;
      }
    }
    if (await exists(path)) return false;
    await rename(held, path);
    return true;
  }

  /**
   * Moves a file that cannot go back under its name from a holding folder to
   * failed with reason, so it is not lost; when it cannot be moved, it stays
   * in the holding folder, logged, until the watcher next starts.
   */
  async function failHeld(
    name: string,
    held: string,
    reason: string,
    pass: InboxPass,
  ): Promise<void> {
    try {
      const moved = await moveToFailed(name, held, reason);
      pass.failed.push({ name, reason });
      log(`inbox: moved ${name} to ${FAILED_DIR}/${moved}: ${reason}`);
    } catch (error) {
      log(
        `inbox: could not move ${name} to ${FAILED_DIR} (${errorText(error)}); it stays at ` +
          `${held} and moves to ${FAILED_DIR} when the watcher next starts. Why: ${reason}`,
      );
    }
  }

  /**
   * Deletes the inbox copy of an import that checked out, and never a file
   * put under its name since the check: unlink by name would delete whatever
   * the name holds at that moment, and rsync renames a new file over the
   * name. So what holds the name is renamed into a new folder of its own in
   * the inbox (HOLD_PREFIX; one rename moves what the name holds at one
   * instant, and stays on the inbox's filesystem), and is deleted there only
   * when it is the open file, the same device and inode. Anything else goes
   * back under the name for the next pass to look at from the start
   * (putBack), or, when another file took the name in the meantime, to
   * failed with SWAPPED_REASON. The holding folder is removed after.
   */
  async function deleteImported(
    name: string,
    path: string,
    handle: FileHandle,
    modelId: string,
    pass: InboxPass,
  ): Promise<void> {
    const couldNotDelete = async (error: unknown) => {
      const sig = await currentSignature(path);
      if (sig !== undefined) handled.set(name, sig);
      log(
        `inbox: imported ${name} as model ${modelId} but could not delete the inbox copy ` +
          `(${errorText(error)}); it is not imported again until it changes`,
      );
    };
    const holdDir = join(dir, `${HOLD_PREFIX}${uuidv7()}`);
    const held = join(holdDir, name);
    try {
      await mkdir(holdDir);
    } catch (error) {
      await couldNotDelete(error);
      return;
    }
    try {
      try {
        await rename(path, held);
      } catch (error) {
        if (codeOf(error) === "ENOENT" && !(await exists(path))) {
          log(`inbox: imported ${name} as model ${modelId}; its inbox copy was already gone`);
        } else {
          await couldNotDelete(error);
        }
        return;
      }
      let named: BigIntStats | undefined;
      try {
        named = await lstat(held, { bigint: true });
        const opened = await handle.stat({ bigint: true });
        if (named.isFile() && named.dev === opened.dev && named.ino === opened.ino) {
          await unlink(held);
          log(`inbox: imported ${name} as model ${modelId} and deleted the inbox copy`);
          return;
        }
      } catch (error) {
        // What is held could not be checked or deleted: it goes back.
        let back = false;
        try {
          back = await putBack(held, path, named?.isFile() ?? false);
        } catch {
          back = false;
        }
        if (!back) await failHeld(name, held, UNCONFIRMED_REASON, pass);
        await couldNotDelete(error);
        return;
      }
      // Another file was put under the name after the check: never deleted.
      let back = false;
      let why = "another file took the name first";
      try {
        back = await putBack(held, path, named.isFile());
      } catch (error) {
        why = errorText(error);
      }
      if (back) {
        log(
          `inbox: imported ${name} as model ${modelId}, but another file was put under its name ` +
            "before the inbox copy was deleted; that file was not imported, so it is left under " +
            "the name and looked at from the start as a new file",
        );
        return;
      }
      log(
        `inbox: imported ${name} as model ${modelId}, but another file was put under its name ` +
          `before the inbox copy was deleted, and it could not be put back (${why})`,
      );
      await failHeld(name, held, SWAPPED_REASON, pass);
    } finally {
      // Empty unless something could not be moved out; then it stays.
      await rmdir(holdDir).catch(() => undefined);
    }
  }

  /**
   * Moves what a process that stopped part way through deleteImported left
   * in a holding folder to failed with HELD_REASON, and removes the folder.
   * It may be an imported file or one put under its name, so it is kept, not
   * deleted or imported. Run once per process, before its first import.
   */
  async function sweepHolds(folders: string[], pass: InboxPass): Promise<void> {
    for (const folder of folders) {
      const holdDir = join(dir, folder);
      try {
        for (const entry of await readdir(holdDir)) {
          await failHeld(entry, join(holdDir, entry), HELD_REASON, pass);
        }
        await rmdir(holdDir);
      } catch (error) {
        if (codeOf(error) === "ENOENT") continue;
        log(`inbox: could not clear the holding folder ${holdDir}: ${errorText(error)}`);
      }
    }
  }

  /**
   * The import this copy of the file already made, if any: an earlier
   * attempt, in this process or one before a restart, whose commit landed but
   * whose answer was lost, found by the id that attempt chose (inboxFileId).
   * All MAX_INBOX_IDS ids are asked about in one query, and a live row under
   * any of them is the import, the lowest attempt first. Otherwise the id the
   * next attempt uses: the lowest attempt with no row, past any whose model
   * is in the trash or being purged. The question fails while the database
   * is down, which keeps the file from being uploaded.
   */
  async function earlierImport(
    name: string,
    hash: StoredFile,
    arrived: Date,
  ): Promise<{ found: { modelId: string; fileId: string } } | { fileId: string }> {
    const ids = Array.from({ length: MAX_INBOX_IDS }, (_, attempt) =>
      inboxFileId({ name, size: hash.size, sha256: hash.sha256, arrived, attempt }),
    );
    // Every id in one question: a purge can delete an earlier attempt's row
    // after a later attempt committed, so a gap does not end the search.
    const rows = new Map((await findImported({ fileIds: ids })).map((row) => [row.fileId, row]));
    const live = ids.map((id) => rows.get(id)).find((row) => row?.live === true);
    if (live !== undefined) {
      log(
        `inbox: ${name} was already imported as model ${live.modelId} by an earlier attempt ` +
          "whose answer was lost; it is not imported again",
      );
      return { found: { modelId: live.modelId, fileId: live.fileId } };
    }
    const free = ids.find((id) => !rows.has(id));
    if (free !== undefined) return { fileId: free };
    throw new Error(
      `every one of the ${MAX_INBOX_IDS} file ids for this copy belongs to a model in the trash`,
    );
  }

  /**
   * Opens the settled file without following a symlink and checks, on the
   * open file, that it is still the regular file the settle window watched
   * (the same device, inode, size and mtime). Returns the open file with the
   * size that settled, or undefined, with nothing left open, when it is not:
   * a symlink, FIFO or other file renamed over the name after the listing's
   * lstat, or the file changed since. Any other error is thrown, as a read of
   * the file would throw it.
   */
  async function openSettled(
    path: string,
    entry: Seen,
  ): Promise<{ handle: FileHandle; size: number } | undefined> {
    let handle: FileHandle;
    try {
      handle = await open(path, OPEN_SETTLED);
    } catch (error) {
      // O_NOFOLLOW on a symlink.
      if (codeOf(error) === "ELOOP") return undefined;
      throw error;
    }
    let st: BigIntStats;
    try {
      st = await handle.stat({ bigint: true });
    } catch (error) {
      await handle.close();
      throw error;
    }
    if (st.isFile() && signature(st) === entry.signature) return { handle, size: Number(st.size) };
    await handle.close();
    return undefined;
  }

  /**
   * Copies at most size bytes (the size that settled) of the open file into
   * TMP_DIR/inbox-copies for ingest to read, hashing them on the way, and
   * returns the copy's path with the size and SHA-256 of what was copied. So
   * nothing appended after the file settled reaches the copy, and the copy is
   * never larger than the size the size limit was checked against. A file
   * that shrank gives a shorter copy, which the caller refuses. Any failure
   * writing the copy is thrown as CopyWriteError; a failure reading the
   * inbox file is thrown as it is. The copy is removed if the copy fails.
   */
  async function copyOut(
    handle: FileHandle,
    size: number,
  ): Promise<{ path: string; hash: StoredFile }> {
    const path = join(copyDir, `${uuidv7()}${COPY_SUFFIX}`);
    let out: FileHandle;
    try {
      await mkdir(copyDir, { recursive: true });
      if (!copiesSwept) {
        for (const entry of await readdir(copyDir, { withFileTypes: true })) {
          if (entry.isFile() && entry.name.endsWith(COPY_SUFFIX)) {
            await rm(join(copyDir, entry.name), { force: true });
          }
        }
        copiesSwept = true;
      }
      out = await open(path, "wx", 0o600);
    } catch (error) {
      throw new CopyWriteError(copyDir, error);
    }
    const hash = createHash("sha256");
    let copied = 0;
    try {
      const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(size, COPY_CHUNK_BYTES)));
      while (copied < size) {
        const want = Math.min(buffer.length, size - copied);
        // A read error is the inbox file's, not the temp folder's.
        const { bytesRead } = await handle.read(buffer, 0, want, copied);
        // The end came early: the file is shorter than when it settled.
        if (bytesRead === 0) break;
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        try {
          let written = 0;
          while (written < chunk.length) {
            written += (await out.write(chunk, written, chunk.length - written)).bytesWritten;
          }
        } catch (error) {
          throw new CopyWriteError(copyDir, error);
        }
        copied += bytesRead;
      }
    } catch (error) {
      await out.close().catch(() => undefined);
      await rm(path, { force: true }).catch(() => undefined);
      throw error;
    }
    try {
      await out.close();
    } catch (error) {
      await rm(path, { force: true }).catch(() => undefined);
      throw new CopyWriteError(copyDir, error);
    }
    return { path, hash: { size: copied, sha256: hash.digest() } };
  }

  /**
   * Forgets a file that turned out not to be the one that settled, so the
   * next poll looks at whatever has the name now from the start: a symlink
   * is ignored there, as any symlink is, and a changed file settles again.
   */
  function notSettled(name: string, why: string): "done" {
    seen.delete(name);
    log(`inbox: ${name} ${why}; it is not imported, and is looked at again from the start`);
    return "done";
  }

  /**
   * Counts a failure against the file, the checks having passed. The strike
   * holds until the pass ends (settleStrikes), since a second file failing
   * the same way in the same pass takes it back.
   */
  function strike(name: string, path: string, entry: Seen, error: unknown, state: PassState): void {
    const prior = strikes.get(name);
    const count = prior?.signature === entry.signature ? prior.count + 1 : 1;
    log(
      `inbox: ${name} could not be imported (try ${count} of ${STRIKES}; storage, the database ` +
        `and the temp folder answer, so it counts against the file): ${errorText(error)}`,
    );
    strikes.set(name, { signature: entry.signature, count });
    state.struck.push({ name, path, signature: entry.signature, error, prior, count });
  }

  /**
   * At the end of a pass, for each strike it took: takes it back when a fault
   * the checks cannot see held the pass and the strike's error is that
   * fault; otherwise moves a file on its STRIKES-th strike in a row for the
   * same signature to failed, with the error as its reason. The rest of the
   * pass can take minutes, so the name must still hold the file that was
   * struck (its signature, so the same regular file, unchanged): a corrected
   * copy or a symlink put there since is not moved, and the next pass looks
   * at it from the start.
   */
  async function settleStrikes(state: PassState): Promise<void> {
    for (const struck of state.struck) {
      if (state.unseen && sameFault(struck.error, state.heldBy)) {
        if (struck.prior === undefined) strikes.delete(struck.name);
        else strikes.set(struck.name, struck.prior);
        continue;
      }
      if (struck.count < STRIKES) continue;
      strikes.delete(struck.name);
      if ((await currentSignature(struck.path)) !== struck.signature) {
        notSettled(
          struck.name,
          `failed ${STRIKES} times, but its name no longer holds that same file (a new copy, a ` +
            `symlink or nothing is there now, or it changed), so it is not moved to ${FAILED_DIR}`,
        );
        continue;
      }
      await fail(
        struck.name,
        struck.name,
        struck.path,
        repeatedErrorReason(struck.error),
        state.pass,
      );
    }
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
    state.tried = true;
    const held: Held = {};
    try {
      return await importOpen(name, path, entry, arrived, state, held);
    } finally {
      if (held.copy !== undefined) await rm(held.copy, { force: true }).catch(() => undefined);
      await held.handle?.close().catch(() => undefined);
    }
  }

  /**
   * importOne's work. The file is opened once (openSettled) and everything
   * after reads that open file: its hash, the copy ingest reads, and the
   * check after the import. The inbox path itself is used again only to see
   * what is under the name now, and to delete or move the file.
   */
  async function importOpen(
    name: string,
    path: string,
    entry: Seen,
    arrived: Date,
    state: PassState,
    held: Held,
  ): Promise<"outage" | "done"> {
    const { pass } = state;
    let result: { modelId: string; fileId: string };
    let handle: FileHandle | undefined;
    try {
      const settled = await openSettled(path, entry);
      if (settled === undefined) {
        return notSettled(
          name,
          "was replaced (by a symlink, say) or changed after it settled and before it was read",
        );
      }
      handle = settled.handle;
      held.handle = handle;
      // One read makes the copy and its hash; the copy is what ingest reads.
      const copy = await copyOut(handle, settled.size);
      held.copy = copy.path;
      if (copyFaults > 0) {
        log(
          `inbox: the temp folder takes the copy again after ${copyFaults} that could not be ` +
            "written; importing again",
        );
        copyFaults = 0;
      }
      // Only the file that settled goes on: not one that grew, shrank or was
      // written to after the check (a stalled copy that resumed, a writer
      // still appending). It settles again from the start, with no strike.
      const current = await handle.stat({ bigint: true });
      if (copy.hash.size !== settled.size || signature(current) !== entry.signature) {
        return notSettled(name, "grew, shrank or was written to after it settled");
      }
      entry.hash ??= copy.hash;
      const hash = entry.hash;
      if (hash.size !== copy.hash.size || !hash.sha256.equals(copy.hash.sha256)) {
        return notSettled(name, "changed while its size, mtime and inode stayed the same");
      }
      const earlier = await earlierImport(name, hash, arrived);
      result =
        "found" in earlier
          ? earlier.found
          : await ingest.ingestFile({
              tmpPath: copy.path,
              originalName: name,
              target: "new",
              fileId: earlier.fileId,
            });
    } catch (error) {
      // The temp folder would not take the copy: never the file's fault.
      if (error instanceof CopyWriteError) return await copyFault(name, error);
      if (codeOf(faultOf(error)) === "ENOENT" && !(await exists(path))) {
        // Taken away while it was being read: nothing left to import or move.
        seen.delete(name);
        strikes.delete(name);
        log(`inbox: ${name} was removed from the inbox while it was being imported`);
        return "done";
      }
      if (error instanceof IngestError && FILE_FAULTS.has(error.code)) {
        // Ingest's own refusal: the file's type or content. Only the file
        // ingest read is moved: not a new copy put under the name since.
        strikes.delete(name);
        if ((await currentSignature(path)) !== entry.signature) {
          return notSettled(
            name,
            `was refused (${errorText(error)}), but its name no longer holds that same file (a new ` +
              `copy, a symlink or nothing is there now, or it changed), so it is not moved to ` +
              `${FAILED_DIR}`,
          );
        }
        await fail(name, name, path, sentence(error.message), pass);
        return "done";
      }
      // Not the file's fault until shown to be: check the environment.
      const why = await checkEnvironment();
      if (why !== undefined) return startOutage(name, why, error);
      const first = state.struck.find((s) => sameFault(s.error, error));
      if (first !== undefined && unseenTries > 0 && backoffMs(unseenTries) >= BACKOFF_MAX_MS) {
        // Still failing the same way after the hold reached its longest
        // wait: two files bad on their own look just like this, so the tries
        // count from now and the pass goes on.
        state.counting = true;
        if (!unseenCounting) {
          unseenCounting = true;
          log(
            `inbox: ${first.name} and ${name} still fail the same way after ${unseenTries} held ` +
              `tries, the last ${BACKOFF_MAX_MS / 60_000} minutes apart, so the tries from now ` +
              `count against the files that fail: each moves to failed after ${STRIKES} in a ` +
              `row, the files after them are tried, and the tries stay ` +
              `${BACKOFF_MAX_MS / 60_000} minutes apart while two still fail the same way. The ` +
              `errors: ${errorText(first.error)}; ${errorText(error)}`,
          );
        }
      } else if (first !== undefined) {
        // A second file failing the same way in one pass, with the checks
        // passing: the fault is one the checks cannot see, such as a write
        // fault.
        const checks = unseenTries + 1;
        const wait = backoffMs(checks);
        outage = { checks, retryAt: now() + wait, unseen: true };
        state.unseen = true;
        state.heldBy = error;
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
    // Ingest is done with the copy; it goes now rather than after the check.
    if (held.copy !== undefined) {
      await rm(held.copy, { force: true }).catch(() => undefined);
      held.copy = undefined;
    }
    strikes.delete(name);
    seen.delete(name);
    pass.imported.push({ name, ...result });

    try {
      await deps.onIngested(result);
    } catch (error) {
      // The file is stored; the Orca poll queues what was missed here.
      log(
        `inbox: imported ${name} as model ${result.modelId}, but the work queued after an ` +
          `import (its estimates) failed: ${errorText(error)}`,
      );
    }

    let verdict: "match" | "changed" | "unconfirmed";
    try {
      // What is under the name now. A symlink or anything else that is not a
      // regular file, swapped in during the import, is never deleted or moved.
      const named = await lstat(path, { bigint: true });
      if (!named.isFile()) {
        log(
          `inbox: imported ${name} as model ${result.modelId}; its name in the inbox now holds ` +
            "a symlink or something else that is not a regular file, which is left alone",
        );
        return "done";
      }
      const opened = await handle.stat({ bigint: true });
      const sameFile = named.dev === opened.dev && named.ino === opened.ino;
      const stored = await storedFile(result.fileId);
      if (stored === undefined) {
        verdict = "unconfirmed";
        log(`inbox: imported ${name}, but no record of the stored file ${result.fileId} was found`);
      } else if (!sameFile) {
        // Another file was put under the name during the import.
        verdict = "changed";
      } else {
        const local = await hashHandle(handle);
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
      await deleteImported(name, path, handle, result.modelId, pass);
      return "done";
    }
    await fail(name, name, path, verdict === "changed" ? CHANGED_REASON : UNCONFIRMED_REASON, pass);
    return "done";
  }

  async function runPass(): Promise<InboxPass> {
    const pass: InboxPass = { imported: [], failed: [], waiting: false };
    const state: PassState = { pass, struck: [], tried: false, unseen: false, counting: false };
    let names: Array<InboxName & { raw: Buffer }>;
    let holds: string[];
    try {
      // Raw bytes: a name that is not UTF-8 would otherwise come back with
      // U+FFFD in it, lstat would not find it, and it would sit unseen.
      const entries = await readdir(dir, { withFileTypes: true, encoding: "buffer" });
      // Holding folders a stopped process left (deleteImported); a symlink
      // with such a name is not a folder here, and is left alone.
      holds = entries
        .filter((e) => e.isDirectory() && e.name.toString("utf8").startsWith(HOLD_PREFIX))
        .map((e) => e.name.toString("utf8"));
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

    if (!holdsSwept) {
      holdsSwept = true;
      await sweepHolds(holds, pass);
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
    await settleStrikes(state);
    if (state.counting && outage === undefined) {
      // Two files still fail the same way: the hold goes on at its longest
      // wait, its tries counting.
      const checks = unseenTries + 1;
      outage = { checks, retryAt: now() + backoffMs(checks), unseen: true };
    }
    if (unseenTries > 0 && outage === undefined) {
      // After every pass that leaves no hold armed, whether or not it tried a
      // file (the held files may have been taken out, or have reached
      // failed), so a later fault starts a hold of its own, logged.
      const tries = `${unseenTries} held tr${unseenTries === 1 ? "y" : "ies"}`;
      const why = state.tried
        ? "no second file failed the same way in this pass"
        : "no held file was left to try";
      log(
        `inbox: ${why} after ${tries}, so the hold on a fault the checks could not see is ` +
          "over; importing again",
      );
      endUnseen();
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
