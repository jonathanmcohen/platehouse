// The pg-boss instance (build plan Task 8). Stub: the interface only, so the
// failing tests compile; the implementation follows in the next commit.
import type { PgBoss } from "pg-boss";

export const BOSS_SCHEMA = "pgboss";

export function createBoss(_opts: {
  databaseUrl: string;
  onError?: (error: Error) => void;
}): PgBoss {
  throw new Error("createBoss is not implemented yet");
}
