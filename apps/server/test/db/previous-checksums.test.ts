// The applied migrations whose comments were reworded after they shipped
// (PR #320). Each has one earlier checksum that migrate() treats as the same
// file, so a database that applied the earlier bytes still starts. These
// tests need no database; migrate() itself is run against Postgres 17 under
// test/integration/db/migrate.test.ts.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { isSameMigration, MIGRATIONS_DIR, PREVIOUS_CHECKSUMS } from "../../src/db/migrate.js";

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

// The commit the earlier bytes come from: the release branch before the
// comments were reworded.
const BEFORE = "d268f23";

const REWORDED = [
  "0001_init.sql",
  "0004_files_sha256.sql",
  "0007_my_printers.sql",
  "0008_library_sort.sql",
];

/** Whether this checkout has the commit; CI checks out one commit only. */
function hasCommit(rev: string): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", `${rev}^{commit}`], { cwd: ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("PREVIOUS_CHECKSUMS", () => {
  test("lists exactly the four reworded migrations", () => {
    expect([...PREVIOUS_CHECKSUMS.keys()].sort()).toEqual(REWORDED);
  });

  test("each current checksum is the shipped file's SHA-256", () => {
    for (const [name, { current }] of PREVIOUS_CHECKSUMS) {
      expect(current, name).toBe(sha256(readFileSync(join(MIGRATIONS_DIR, name))));
    }
  });

  test("each previous checksum is a SHA-256 that differs from the current one", () => {
    for (const [name, { previous, current }] of PREVIOUS_CHECKSUMS) {
      expect(previous, name).toMatch(/^[0-9a-f]{64}$/);
      expect(previous, name).not.toBe(current);
    }
  });

  // The digests are pinned in migrate.ts and were computed with
  // git show d268f23:apps/server/src/db/migrations/<name> | shasum -a 256.
  // Where the checkout has that commit (a full clone), this recomputes them
  // from git. CI checks out one commit, so there only the pinned values and
  // the tests above are checked.
  test("each previous checksum is the SHA-256 of the file at d268f23, where the checkout has it", () => {
    const full = hasCommit(BEFORE);
    for (const [name, { previous }] of PREVIOUS_CHECKSUMS) {
      if (!full) continue;
      const old = execFileSync("git", ["show", `${BEFORE}:apps/server/src/db/migrations/${name}`], {
        cwd: ROOT,
      });
      expect(previous, name).toBe(sha256(old));
    }
  });
});

describe("isSameMigration", () => {
  const [name, entry] = [...PREVIOUS_CHECKSUMS][0] ?? ["", { previous: "", current: "" }];
  const other = "0".repeat(64);

  test("the recorded checksum equal to the file's is the same file", () => {
    expect(isSameMigration("0002_purge_started.sql", other, other)).toBe(true);
    expect(isSameMigration(name, entry.current, entry.current)).toBe(true);
  });

  test("a listed migration's previous checksum is the same file while the file is unchanged since", () => {
    expect(isSameMigration(name, entry.previous, entry.current)).toBe(true);
  });

  test("any other mismatch is not the same file", () => {
    // Neither the current nor the listed previous checksum.
    expect(isSameMigration(name, other, entry.current)).toBe(false);
    // The previous checksum, but the file has changed again since.
    expect(isSameMigration(name, entry.previous, other)).toBe(false);
    // Another migration's previous checksum.
    const [, second] = [...PREVIOUS_CHECKSUMS][1] ?? ["", { previous: "", current: "" }];
    expect(isSameMigration(name, second.previous, entry.current)).toBe(false);
    // A migration that is not listed has no previous checksum.
    expect(isSameMigration("0002_purge_started.sql", entry.previous, other)).toBe(false);
    // An inherited property name is not an entry.
    expect(isSameMigration("__proto__", other, entry.current)).toBe(false);
  });
});
