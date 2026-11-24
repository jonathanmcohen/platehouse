// Working copies a crash can leave in TMP_DIR: each render's own folder
// (render-*, made in derived.ts) and each plate mesh's (plate-mesh-*). A job
// removes its own folder when it ends; a process killed in the middle cannot.
// The server sweeps them once at start-up, before any queue starts, so no job
// of this process owns one. Uploads and inbox copies live in folders of their
// own and are never touched here.
import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

const PREFIXES = ["render-", "plate-mesh-"];

/**
 * Removes the render-* and plate-mesh-* directories directly under tmpDir and
 * returns how many it removed. It looks at each entry with lstat and never
 * follows a link, so a link with a matching name is left alone, as is a plain
 * file. A folder that cannot be removed is logged and skipped; a missing
 * tmpDir has nothing to sweep.
 */
export async function sweepWorkingCopies(tmpDir: string): Promise<number> {
  let names: string[];
  try {
    names = await readdir(tmpDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    console.error(`start-up sweep: could not read ${tmpDir}: ${String(error)}`);
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    const path = join(tmpDir, name);
    try {
      if (!(await lstat(path)).isDirectory()) continue;
      await rm(path, { recursive: true, force: true });
      removed += 1;
    } catch (error) {
      console.error(`start-up sweep: could not remove ${path}: ${String(error)}`);
    }
  }
  return removed;
}
