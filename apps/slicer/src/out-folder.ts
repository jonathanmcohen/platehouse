// Orca's out/ folder, read through one file descriptor (issue #480).
//
// Orca's sandbox lets it change everything in its own folder, out/ included,
// and a process it left behind can still be running when the server reads
// the slice's results. Read by path, out/ could be renamed away and another
// folder, or a link, put in its place between the check and the read. So
// out/ is opened once, as a folder and never through a link (O_DIRECTORY |
// O_NOFOLLOW, then fstat), and each file is opened through that descriptor
// as /proc/self/fd/<fd>/<name>: the kernel walks from the folder that was
// opened, whatever now has its name. Each file is read with readOutputFile,
// so it is opened with O_NOFOLLOW | O_NONBLOCK and must be a small regular
// file.
//
// There is no path read to fall back on. Without /proc every file reads as
// missing, which fails the slice.
import { closeSync, constants, fstatSync, openSync } from "node:fs";
import { type OutputRead, readOutputFile } from "./sandbox.js";

export interface OutFolder {
  /**
   * Reads the file `name` in the folder, as readOutputFile does. `name` is
   * one file name: a name with a slash, ".", ".." or "" throws.
   */
  read(name: string, limit: number): OutputRead;
  /** Closes the folder's descriptor; a second call does nothing. */
  close(): void;
}

const NOT_A_FOLDER = "Orca's output folder was not a folder, so nothing in it was read.";

/** out/ when nothing has its name: every file in it is missing. */
const NO_FOLDER: OutFolder = {
  read: () => ({ ok: false, missing: true }),
  close: () => {},
};

/**
 * Opens `dir` for reading the files in it. Nothing with that name is a
 * folder with nothing in it; a link, a file or anything else that is not a
 * folder, or a folder that cannot be opened, is the problem that stops the
 * slice. The caller closes what it gets.
 */
export function openOutFolder(dir: string): OutFolder | { problem: string } {
  let fd: number;
  try {
    fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return NO_FOLDER;
    return { problem: NOT_A_FOLDER };
  }
  let isFolder = false;
  try {
    isFolder = fstatSync(fd).isDirectory();
  } finally {
    if (!isFolder) closeSync(fd);
  }
  if (!isFolder) return { problem: NOT_A_FOLDER };
  let open = true;
  return {
    read(name, limit) {
      if (name === "" || name === "." || name === ".." || name.includes("/")) {
        throw new Error(`Not one file name: ${JSON.stringify(name)}`);
      }
      // A closed descriptor's number can be reused for another file.
      if (!open) throw new Error("Orca's output folder is closed");
      return readOutputFile(`/proc/self/fd/${fd}/${name}`, limit);
    },
    close() {
      if (!open) return;
      open = false;
      closeSync(fd);
    },
  };
}
