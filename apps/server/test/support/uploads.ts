// An upload store for unit tests that build the whole app in a temp folder
// and remove that folder afterwards.
//
// createUploads's tus FileStore starts making TMP_DIR/uploads in its
// constructor with a callback mkdir that nothing waits for. readyUploads makes
// the folder first with prepareUploads, so that mkdir finds it and has nothing
// left to race a test's removal of its temp folder.
import { createUploads, prepareUploads, type Uploads } from "../../src/uploads/tus.js";

/**
 * createUploads under tmpDir, with a queue that does nothing and no log,
 * once the uploads folder exists. It reports plenty of free space, so no
 * test depends on the room left in os.tmpdir().
 */
export async function readyUploads(tmpDir: string): Promise<Uploads> {
  await prepareUploads(tmpDir);
  return createUploads({
    tmpDir,
    queue: { enqueue: async () => {}, result: async () => undefined },
    log: () => {},
    freeBytes: async () => Number.MAX_SAFE_INTEGER,
  });
}
