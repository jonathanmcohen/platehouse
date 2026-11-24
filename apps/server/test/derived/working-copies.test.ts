// The start-up sweep of working copies a crash left in TMP_DIR: the render-*
// folders of derived.ts and the plate-mesh-* folders of the plate mesh code.
// Nothing else is touched, and a link is never followed.
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { sweepWorkingCopies } from "../../src/derived/working-copies.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sweep-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function folder(...parts: string[]): string {
  const dir = join(tmp, ...parts);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "answer.bin"), "x");
  return dir;
}

describe("sweepWorkingCopies", () => {
  test("removes render-* and plate-mesh-* folders and counts them", async () => {
    const a = folder("render-abc123");
    const b = folder("plate-mesh-xyz789");
    const c = folder("render-def456");
    expect(await sweepWorkingCopies(tmp)).toBe(3);
    for (const dir of [a, b, c]) expect(existsSync(dir)).toBe(false);
  });

  test("leaves uploads, inbox-copies and other names alone", async () => {
    const uploads = folder("uploads");
    const inbox = folder("inbox-copies");
    const other = folder("rendered");
    const nested = folder("uploads", "render-inside");
    expect(await sweepWorkingCopies(tmp)).toBe(0);
    for (const dir of [uploads, inbox, other, nested]) expect(existsSync(dir)).toBe(true);
  });

  test("leaves a plain file whose name matches", async () => {
    const file = join(tmp, "render-file");
    writeFileSync(file, "x");
    expect(await sweepWorkingCopies(tmp)).toBe(0);
    expect(existsSync(file)).toBe(true);
  });

  test("never follows a link, and leaves a matching link in place", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "sweep-elsewhere-"));
    try {
      writeFileSync(join(elsewhere, "keep.txt"), "x");
      symlinkSync(elsewhere, join(tmp, "render-link"));
      expect(await sweepWorkingCopies(tmp)).toBe(0);
      expect(existsSync(join(elsewhere, "keep.txt"))).toBe(true);
      expect(existsSync(join(tmp, "render-link"))).toBe(true);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test("a missing TMP_DIR sweeps nothing", async () => {
    expect(await sweepWorkingCopies(join(tmp, "absent"))).toBe(0);
  });
});
