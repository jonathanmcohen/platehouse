// Whether a module is the script node was started with. Compares real paths:
// Node resolves import.meta.url through symlinks, while process.argv[1] keeps
// the path as it was typed, so a plain comparison is false when a script is
// started through a symlinked path such as macOS /tmp (issue #4).
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function isMain(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}
