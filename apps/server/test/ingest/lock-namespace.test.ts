// Ingest's advisory locks use the two-argument form with a fixed namespace
// (issue #473), so their keys cannot meet the one-argument locks (migrations,
// the preview backfill) in Postgres's 32-bit one-argument keyspace (#423).
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { INGEST_LOCK_NAMESPACE } from "../../src/ingest/ingest.js";

const SOURCE = readFileSync(new URL("../../src/ingest/ingest.ts", import.meta.url), "utf8");

describe("ingest advisory locks", () => {
  test("the namespace is a positive 32-bit integer", () => {
    expect(Number.isInteger(INGEST_LOCK_NAMESPACE)).toBe(true);
    expect(INGEST_LOCK_NAMESPACE).toBeGreaterThan(0);
    expect(INGEST_LOCK_NAMESPACE).toBeLessThan(2 ** 31);
  });

  test("every pg_advisory_xact_lock call takes the namespace first", () => {
    const calls = SOURCE.match(/pg_advisory_xact_lock\(\$\{[^}]*\}::int, hashtext\(/g) ?? [];
    const all = SOURCE.match(/select pg_advisory_xact_lock\(/g) ?? [];
    expect(all.length).toBe(2);
    expect(calls.length).toBe(2);
    expect(calls.every((c) => c.includes("INGEST_LOCK_NAMESPACE"))).toBe(true);
  });
});
