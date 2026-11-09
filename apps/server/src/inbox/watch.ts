// The inbox watcher (build plan Task 10; AC-021). STUB: the interface only,
// committed with the failing tests so they compile and fail on behaviour. The
// implementation follows in the next commit.
import type { Ingest } from "../ingest/ingest.js";

/** How often the inbox is polled. */
export const POLL_MS = 5_000;

/** The folder inside the inbox that failed files move to. */
export const FAILED_DIR = "failed";

/** What follows a failed file's name to name its reason file. */
export const REASON_SUFFIX = ".reason.txt";

export const CHANGED_REASON =
  "This file changed while Platehouse was importing it, so it was kept here; check the new model in the library before adding it again.";

export const UNCONFIRMED_REASON =
  "Platehouse imported this file but could not confirm the stored copy, so it was kept here; check the library before adding it again.";

export const UNEXPECTED_REASON =
  "Platehouse could not import this file because of an unexpected error; the server log has the details.";

export function isIgnoredName(_name: string): boolean {
  return false;
}

export interface StoredFile {
  size: number;
  sha256: Buffer;
}

export interface InboxWatcherDeps {
  dir: string;
  settleSeconds: number;
  ingest: Pick<Ingest, "ingestFile">;
  storedFile: (fileId: string) => Promise<StoredFile | undefined>;
  pollMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export interface InboxPass {
  imported: Array<{ name: string; modelId: string; fileId: string }>;
  failed: Array<{ name: string; reason: string }>;
  waiting: boolean;
}

export function createInboxWatcher(_deps: InboxWatcherDeps) {
  return {
    async pollOnce(): Promise<InboxPass> {
      return { imported: [], failed: [], waiting: false };
    },
    start(): void {},
    async stop(): Promise<void> {},
  };
}

export type InboxWatcher = ReturnType<typeof createInboxWatcher>;
