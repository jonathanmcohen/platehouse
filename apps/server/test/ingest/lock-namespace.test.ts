// Ingest's advisory locks use the two-argument form with a fixed namespace
// (issue #473), so their keys cannot meet the one-argument locks (migrations,
// the preview backfill) in Postgres's 32-bit one-argument keyspace (#423).
// That both locks pass the namespace as their first argument is checked in
// duplicates.test.ts, from the SQL the database is sent.
import { describe, expect, test } from "vitest";
import { INGEST_LOCK_NAMESPACE } from "../../src/ingest/ingest.js";

describe("INGEST_LOCK_NAMESPACE", () => {
  test("is a positive 32-bit integer", () => {
    expect(Number.isInteger(INGEST_LOCK_NAMESPACE)).toBe(true);
    expect(INGEST_LOCK_NAMESPACE).toBeGreaterThan(0);
    expect(INGEST_LOCK_NAMESPACE).toBeLessThan(2 ** 31);
  });
});
