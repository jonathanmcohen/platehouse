// An upload store for unit tests that build the whole app in a temp folder
// and remove that folder afterwards.
//
// createUploads's tus FileStore starts making TMP_DIR/uploads in its
// constructor with a callback mkdir that nothing waits for, and app.close()
// does not wait for it either. Left running, it can still be making the
// folder when the test removes its temp folder, and its callback then throws
// ENOENT as an uncaught exception, which fails the run although every test
// passed. readyUploads waits until the folder exists: making it is the
// mkdir's last step, so the mkdir has finished.
import { stat } from "node:fs/promises";
import { createUploads, type Uploads, uploadsDir } from "../../src/uploads/tus.js";

/** Resolves once path is a directory; throws on any error but ENOENT, or after 10 s. */
async function madeDirectory(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      if ((await stat(path)).isDirectory()) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (Date.now() > deadline) throw new Error(`${path} was never made`);
  }
}

/**
 * createUploads under tmpDir, with a queue that does nothing and no log,
 * once the store has made its folder.
 */
export async function readyUploads(tmpDir: string): Promise<Uploads> {
  const uploads = createUploads({
    tmpDir,
    queue: { enqueue: async () => {}, result: async () => undefined },
    log: () => {},
  });
  await madeDirectory(uploadsDir(tmpDir));
  return uploads;
}
