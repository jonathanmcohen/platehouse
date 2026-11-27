// The kernel cause behind an old_kernel sandbox: which cause a Landlock ABI and
// a kernel release point to, and the words each adds to the detail.
import type { KernelCause } from "@platehouse/slicer-contract";
import { describe, expect, test } from "vitest";
import { type KernelInfo, kernelCause, kernelDetail, readKernelInfo } from "../src/kernel.js";

describe("kernelCause", () => {
  test.each<[number, string, KernelCause]>([
    [5, "6.11.0", "too_old"],
    [0, "6.6.0-21-generic", "too_old"],
    [0, "6.12.3", "landlock_off"],
    [0, "7.0.0", "landlock_off"],
    [5, "6.12.3", "landlock_fix_missing"],
    [5, "6.14.0-37-generic", "landlock_fix_missing"],
    [3, "6.12.0", "unknown"],
    [5, "garbage", "unknown"],
    [0, "", "unknown"],
  ])("ABI %i on release %j is %s", (abi, release, cause) => {
    expect(kernelCause(abi, release)).toBe(cause);
  });
});

describe("kernelDetail", () => {
  const info = (lsm: string | null): KernelInfo => ({ release: "6.12.3", lsm });

  test("too_old names the release and 6.12", () => {
    expect(kernelDetail("too_old", { release: "6.11.0", lsm: null })).toBe(
      "; the kernel is Linux 6.11.0, older than 6.12",
    );
  });

  test("landlock_off with no landlock among the security modules says it was not enabled at boot", () => {
    expect(kernelDetail("landlock_off", info("lockdown,capability,yama"))).toBe(
      "; the kernel is Linux 6.12.3, 6.12 or newer, so Landlock is turned off in it or the container runtime blocks it: landlock is not among the kernel's security modules, so it was not enabled at boot (lsm= or CONFIG_LSM)",
    );
  });

  test("landlock_off with landlock among the security modules says it is blocked", () => {
    expect(kernelDetail("landlock_off", info("capability, landlock ,yama"))).toBe(
      "; the kernel is Linux 6.12.3, 6.12 or newer, so Landlock is turned off in it or the container runtime blocks it: landlock is among the kernel's security modules, so it is blocked, most likely by a Docker Engine older than 20.10.18 or a custom seccomp profile",
    );
  });

  test("landlock_off whose security modules cannot be read says it is either", () => {
    expect(kernelDetail("landlock_off", info(null))).toBe(
      "; the kernel is Linux 6.12.3, 6.12 or newer, so Landlock is turned off in it or the container runtime blocks it; the kernel's security modules could not be read, so it is either",
    );
  });

  test("a module only named like landlock does not count", () => {
    expect(kernelDetail("landlock_off", info("landlockish,capability"))).toContain(
      "landlock is not among",
    );
  });

  test("landlock_fix_missing names the fixed versions", () => {
    expect(kernelDetail("landlock_fix_missing", info(null))).toBe(
      "; the kernel is Linux 6.12.3, 6.12 or newer, without the 2025 Landlock fix (in 6.12.24, 6.13.12, 6.14.3 and 6.15 or newer): update it",
    );
  });

  test("unknown says the kernel does not offer the sandbox", () => {
    expect(kernelDetail("unknown", info(null))).toBe(
      "; the kernel is Linux 6.12.3, which does not offer the sandbox this server needs",
    );
  });

  test("no info (the reader threw) says the release could not be read", () => {
    expect(kernelDetail("unknown", null)).toBe("; the kernel's release could not be read");
  });
});

describe("readKernelInfo", () => {
  test("gives a non-empty release and a string or null for the security modules", () => {
    const info = readKernelInfo();
    expect(info.release.length).toBeGreaterThan(0);
    expect(info.lsm === null || typeof info.lsm === "string").toBe(true);
  });
});
