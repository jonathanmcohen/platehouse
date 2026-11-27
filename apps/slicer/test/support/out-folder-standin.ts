// A stand-in for src/out-folder.ts on a machine without /proc/self/fd (a
// Mac), so the slice tests still run there. It has the same signature and
// reads by path, as the slicer did before it read through one file
// descriptor: the folder is checked with lstat, then each file is read with
// readOutputFile. The real module, which a renamed or swapped out/ cannot
// redirect, is under test on Linux, where CI runs the unit tests.
import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { OutFolder } from "../../src/out-folder.js";
import { readOutputFile } from "../../src/sandbox.js";

export function openOutFolder(dir: string): OutFolder | { problem: string } {
  let isFolder: boolean;
  try {
    isFolder = lstatSync(dir).isDirectory();
  } catch {
    return { read: () => ({ ok: false, missing: true }), close: () => {} };
  }
  if (!isFolder)
    return { problem: "Orca's output folder was not a folder, so nothing in it was read." };
  return { read: (name, limit) => readOutputFile(join(dir, name), limit), close: () => {} };
}
