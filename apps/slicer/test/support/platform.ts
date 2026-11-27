// What the machine running the unit tests offers. The slicer reads Orca's
// out/ folder through /proc/self/fd (src/out-folder.ts), which only Linux
// has: there the real read is under test, and elsewhere (a Mac) the tests
// swap in the path-based stand-in (out-folder-standin.ts).
import { existsSync } from "node:fs";

export const HAS_PROC_FD = existsSync("/proc/self/fd");
