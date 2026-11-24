// The name a tagging route answers (issue #431): when a delete removes the
// tag between the tagging commit and the read of its stored name, the answer
// is the name that was asked for, not a 500.
import type { Kysely } from "kysely";
import { describe, expect, test } from "vitest";
import { storedName } from "../../src/app-api/organise.js";
import type { DB } from "../../src/db/types.js";

function dbReading(row: { name: string } | undefined): Kysely<DB> {
  const chain = {
    select: () => chain,
    where: () => chain,
    executeTakeFirst: async () => row,
  };
  return { selectFrom: () => chain } as unknown as Kysely<DB>;
}

describe("storedName", () => {
  test.each(["tags", "collections"] as const)(
    "answers the stored spelling of a %s row",
    async (table) => {
      expect(await storedName(dbReading({ name: "Desk" }), table, "desk")).toBe("Desk");
    },
  );

  test.each(["tags", "collections"] as const)(
    "answers the requested, trimmed name when the %s row is gone",
    async (table) => {
      expect(await storedName(dbReading(undefined), table, "  Desk ")).toBe("Desk");
    },
  );
});
