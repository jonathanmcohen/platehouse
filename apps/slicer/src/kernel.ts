// The kernel cause behind an old_kernel sandbox. landrun reports a Landlock
// ABI below MIN_LANDLOCK_ABI for four different reasons, and the fix differs:
// a kernel older than Linux 6.12, a newer one with Landlock off (not enabled at
// boot, or blocked by the container runtime), a newer one without the 2025
// Landlock fix, or something this table does not know. This only adds words to
// the detail: the reason stays old_kernel and the sandbox stays off. A leaf
// module: the contract's type, node:fs and node:os only.
import { readFileSync } from "node:fs";
import { release } from "node:os";
import type { KernelCause } from "@platehouse/slicer-contract";

export interface KernelInfo {
  release: string;
  /** /sys/kernel/security/lsm, trimmed, or null when it cannot be read. */
  lsm: string | null;
}

const LSM_FILE = "/sys/kernel/security/lsm";

/** The kernel's release and security modules; a read error on the latter is null. */
export function readKernelInfo(): KernelInfo {
  let lsm: string | null;
  try {
    lsm = readFileSync(LSM_FILE, "utf8").trim();
  } catch {
    lsm = null;
  }
  return { release: release(), lsm };
}

/**
 * The cause of a Landlock ABI below what the sandbox needs, from the ABI and
 * the kernel release (os.release()). Called only after the ABI check failed.
 */
export function kernelCause(abi: number, kernelRelease: string): KernelCause {
  const m = /^(\d+)\.(\d+)/.exec(kernelRelease);
  if (!m) return "unknown";
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const atLeast612 = major > 6 || (major === 6 && minor >= 12);
  if (!atLeast612) return abi < 6 ? "too_old" : "unknown";
  if (abi === 0) return "landlock_off";
  if (abi === 5) return "landlock_fix_missing";
  return "unknown";
}

/** The words appended to the old-kernel detail; null info means the reader threw. */
export function kernelDetail(cause: KernelCause, info: KernelInfo | null): string {
  if (info === null) return "; the kernel's release could not be read";
  const r = info.release;
  switch (cause) {
    case "too_old":
      return `; the kernel is Linux ${r}, older than 6.12`;
    case "landlock_off": {
      const head = `; the kernel is Linux ${r}, 6.12 or newer, so Landlock is turned off in it or the container runtime blocks it`;
      if (info.lsm === null) {
        return `${head}; the kernel's security modules could not be read, so it is either`;
      }
      const listed = info.lsm.split(",").some((m) => m.trim() === "landlock");
      return listed
        ? `${head}: landlock is among the kernel's security modules, so it is blocked, most likely by a Docker Engine older than 20.10.18 or a custom seccomp profile`
        : `${head}: landlock is not among the kernel's security modules, so it was not enabled at boot (lsm= or CONFIG_LSM)`;
    }
    case "landlock_fix_missing":
      return `; the kernel is Linux ${r}, 6.12 or newer, without the 2025 Landlock fix (in 6.12.24, 6.13.12, 6.14.3 and 6.15 or newer): update it`;
    case "unknown":
      return `; the kernel is Linux ${r}, which does not offer the sandbox this server needs`;
  }
}
