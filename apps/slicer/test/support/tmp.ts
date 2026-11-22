// Temporary folders for the slicer's unit tests. Every folder made here is
// recorded, so a test file can remove them all once it is done with them
// (removeTempDirs in an afterEach or afterAll) instead of leaving them in
// the OS temp folder after every run.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const made: string[] = [];

/** A new folder under the OS temp folder, named from prefix, recorded for removeTempDirs. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/** Removes every folder tempDir made since the last call, whatever is in it. */
export function removeTempDirs(): void {
  for (let dir = made.pop(); dir !== undefined; dir = made.pop()) {
    rmSync(dir, { recursive: true, force: true });
  }
}
