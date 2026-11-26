// A host whose seccomp profile blocks the Landlock system calls, as Docker
// Engine before 20.10.18 does: landrun sees no Landlock at all (ABI 0), the
// start-up self-test turns the sandbox off as old_kernel, and ?kernel=1 gives
// the cause landlock_off. The profile allows everything else, so the only
// difference from the other container tests is the three blocked calls.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slicerContract } from "@platehouse/slicer-contract";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { landrunArgs, sandboxRules } from "../../src/sandbox.js";
import { IMAGE_PATHS, type RunningSlicer, startSlicer } from "./support/slicer.js";

const PROFILE = {
  defaultAction: "SCMP_ACT_ALLOW",
  syscalls: [
    {
      names: ["landlock_create_ruleset", "landlock_add_rule", "landlock_restrict_self"],
      action: "SCMP_ACT_ERRNO",
      errnoRet: 1,
    },
  ],
};

let slicer: RunningSlicer;
let profileDir: string | undefined;
beforeAll(async () => {
  profileDir = mkdtempSync(join(tmpdir(), "platehouse-seccomp-"));
  const file = join(profileDir, "no-landlock.json");
  writeFileSync(file, JSON.stringify(PROFILE));
  slicer = await startSlicer(["--security-opt", `seccomp=${file}`]);
});
afterAll(() => {
  slicer?.stop();
  if (profileDir) rmSync(profileDir, { recursive: true, force: true });
});

async function health(query = ""): Promise<unknown> {
  const res = await fetch(`${slicer.base}/v1/health${query}`);
  const text = await res.text();
  expect(res.status, text).toBe(200);
  return JSON.parse(text);
}

describe("the slicer on a host whose seccomp blocks Landlock", () => {
  test("health reports the sandbox off for an old kernel, with no cause unless asked", async () => {
    const body = await health();
    const parsed = slicerContract.health.parse(body);
    expect(parsed.sandbox.state, JSON.stringify(body)).toBe("off");
    expect(parsed.sandbox).toMatchObject({ state: "off", reason: "old_kernel" });
    expect(Object.keys((body as { sandbox: object }).sandbox), JSON.stringify(body)).not.toContain(
      "kernel",
    );
  });

  test("health?kernel=1 names the cause landlock_off", async () => {
    const body = await health("?kernel=1");
    const parsed = slicerContract.health.parse(body);
    expect(parsed.sandbox, JSON.stringify(body)).toMatchObject({
      state: "off",
      reason: "old_kernel",
      kernel: "landlock_off",
    });
  });

  test("the log says the Landlock ABI is 0 and that Landlock is off or blocked", () => {
    const logs = slicer.logs();
    const line = logs.split("\n").find((l) => l.includes("sandbox self-test:"));
    expect(line, logs).toBeDefined();
    expect(line).toMatch(/sandbox self-test: FAILED: .*Landlock ABI is 0\b/);
    expect(line).toMatch(
      /6\.12 or newer, so Landlock is turned off in it or the container runtime blocks it/,
    );
  });

  // The ABI check is landrun's own refusal: with the Landlock calls failing,
  // go-landlock reports ABI v0.
  test("a strict landrun here is refused with Got Landlock ABI v0", () => {
    const args = landrunArgs({
      rules: sandboxRules("openscad", { ...IMAGE_PATHS, dir: "/work" }),
      command: ["/opt/openscad/AppRun", "--version"],
      strict: true,
    });
    const r = slicer.exec(["/usr/local/bin/landrun", ...args]);
    expect(r.code, `${r.stdout}${r.stderr}`).not.toBe(0);
    expect(r.stderr, `${r.stdout}${r.stderr} (exit ${r.code})`).toMatch(/Got Landlock ABI v0\b/);
  });
});
