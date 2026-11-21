// The library's bulk actions (Jon, 2026-11-19), the parts that need no
// database: how the selected ids are read (deduplicated ignoring case, a
// malformed one reported as not found without a query) and what the routes
// refuse before they touch anything (no ids, more than the cap, too many or
// blank tags). The database side (valid, trashed and missing models, one
// transaction, what changed) is in test/integration/app-api/bulk.test.ts.
import Fastify from "fastify";
import { describe, expect, test } from "vitest";
import { registerOrganiseApi } from "../../src/app-api/organise.js";
import {
  BULK_TRIES,
  byId,
  byLowerName,
  MAX_BULK_IDS,
  MAX_BULK_TAGS,
  readIds,
  retryOnConflict,
} from "../../src/repos/bulk.js";

/** A Postgres error as pg raises it: an Error with the SQLSTATE in code. */
function pgError(code: string): Error {
  return Object.assign(new Error(`postgres ${code}`), { code });
}

describe("retryOnConflict", () => {
  const noWait = { sleep: async () => {}, random: () => 0.5 };

  test("tries again after a deadlock (40P01) and answers what the next try answers", async () => {
    let calls = 0;
    const answer = await retryOnConflict(
      false,
      async () => {
        calls += 1;
        if (calls < 3) throw pgError("40P01");
        return "done";
      },
      noWait,
    );
    expect(answer).toBe("done");
    expect(calls).toBe(3);
  });

  test("a serialization failure (40001) is tried again too", async () => {
    let calls = 0;
    await retryOnConflict(
      false,
      async () => {
        calls += 1;
        if (calls === 1) throw pgError("40001");
      },
      noWait,
    );
    expect(calls).toBe(2);
  });

  test("gives up after BULK_TRIES tries, with the last error", async () => {
    expect(BULK_TRIES).toBe(3);
    let calls = 0;
    await expect(
      retryOnConflict(
        false,
        async () => {
          calls += 1;
          throw pgError("40P01");
        },
        noWait,
      ),
    ).rejects.toMatchObject({ code: "40P01" });
    expect(calls).toBe(BULK_TRIES);
  });

  test("any other error is not tried again", async () => {
    let calls = 0;
    await expect(
      retryOnConflict(
        false,
        async () => {
          calls += 1;
          throw pgError("23505");
        },
        noWait,
      ),
    ).rejects.toMatchObject({ code: "23505" });
    expect(calls).toBe(1);
  });

  test("inside the caller's transaction it runs once: that transaction is already aborted", async () => {
    let calls = 0;
    await expect(
      retryOnConflict(
        true,
        async () => {
          calls += 1;
          throw pgError("40P01");
        },
        noWait,
      ),
    ).rejects.toMatchObject({ code: "40P01" });
    expect(calls).toBe(1);
  });

  test("waits a jittered, growing time between tries", async () => {
    const waits: number[] = [];
    let calls = 0;
    await retryOnConflict(
      false,
      async () => {
        calls += 1;
        if (calls < 3) throw pgError("40P01");
      },
      { sleep: async (ms) => void waits.push(ms), random: () => 0.5 },
    );
    expect(waits).toHaveLength(2);
    expect(waits[0]).toBeGreaterThan(0);
    expect(waits[1]).toBeGreaterThan(waits[0] as number);
  });
});

describe("byId", () => {
  test("sorts ids as Postgres orders uuids, without changing the list given", () => {
    const given = [
      "0198f0c4-0000-7000-8000-00000000000b",
      "0198f0c4-0000-7000-8000-00000000000a",
      "0198f0c3-ffff-7000-8000-00000000000c",
    ];
    expect(byId(given)).toEqual([
      "0198f0c3-ffff-7000-8000-00000000000c",
      "0198f0c4-0000-7000-8000-00000000000a",
      "0198f0c4-0000-7000-8000-00000000000b",
    ]);
    expect(given[0]).toBe("0198f0c4-0000-7000-8000-00000000000b");
  });
});

const A = "0198f0c4-0000-7000-8000-00000000000a";
const B = "0198f0c4-0000-7000-8000-00000000000b";

describe("readIds", () => {
  test("keeps the order, drops repeats ignoring case, and lowercases", () => {
    expect(readIds([A, B, A.toUpperCase(), ` ${B} `])).toEqual({ valid: [A, B], malformed: [] });
  });

  test("a malformed id is reported as given, once, and never queried", () => {
    expect(readIds([A, "nope", "nope", "../etc"])).toEqual({
      valid: [A],
      malformed: ["nope", "../etc"],
    });
  });
});

// Add tags makes new tags in this order so two requests naming the same
// tags in any order take the tag index's locks alike (PR #246 review).
describe("byLowerName", () => {
  test("sorts ignoring case and keeps each name as given", () => {
    expect(byLowerName(["beta", "Gamma", "ALPHA"])).toEqual(["ALPHA", "beta", "Gamma"]);
  });

  test("the same names in any order come out in the same order", () => {
    expect(byLowerName(["PLA", "desk", "Shelf"])).toEqual(byLowerName(["Shelf", "PLA", "desk"]));
  });

  test("leaves its argument as it was", () => {
    const given = ["b", "a"];
    byLowerName(given);
    expect(given).toEqual(["b", "a"]);
  });
});

test("the caps: 1000 models a request, as View all, and 20 tags", () => {
  expect(MAX_BULK_IDS).toBe(1000);
  expect(MAX_BULK_TAGS).toBe(20);
});

describe("the bulk routes refuse a bad request before anything runs", () => {
  async function app() {
    const server = Fastify({ logger: false });
    // No dependencies: a request that passes validation answers 503.
    await registerOrganiseApi(server, undefined);
    await server.ready();
    return server;
  }

  async function post(url: string, body: unknown) {
    const server = await app();
    return server.inject({
      method: "POST",
      url,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify(body),
    });
  }

  const ids = (n: number) =>
    Array.from({ length: n }, (_, i) => `0198f0c4-0000-7000-8000-${String(i).padStart(12, "0")}`);

  /** The library's view the selection was made in: here the whole library. */
  const view = {};

  const ROUTES: Array<[string, Record<string, unknown>]> = [
    ["/app/api/bulk/add-tags", { tags: ["PLA"], view }],
    ["/app/api/bulk/remove-tag", { tag: "PLA", view }],
    ["/app/api/bulk/add-to-collection", { collection: "Desk", view }],
    ["/app/api/bulk/trash", { view }],
    // Not an action: which of the posted models the view holds (PR #313 review).
    ["/app/api/bulk/in-view", { view }],
  ];

  test("each route takes up to the cap and refuses one more, or none", async () => {
    for (const [url, rest] of ROUTES) {
      expect((await post(url, { ids: ids(MAX_BULK_IDS), ...rest })).statusCode, url).toBe(503);
      const over = await post(url, { ids: ids(MAX_BULK_IDS + 1), ...rest });
      expect(over.statusCode, url).toBe(400);
      expect(over.json(), url).toMatchObject({ error: "bad_request" });
      expect((await post(url, { ids: [], ...rest })).statusCode, url).toBe(400);
      expect((await post(url, { ...rest })).statusCode, url).toBe(400);
    }
  });

  // The server, not the browser, keeps Select mode to the models the user
  // can see (Jon, 2026-11-20): every bulk request names the search and
  // filters it was made in, and one that does not is refused.
  test("each route refuses a request without a view, or with a view that is not one", async () => {
    for (const [url, rest] of ROUTES) {
      const { view: _view, ...withoutView } = rest;
      const missing = await post(url, { ids: [A], ...withoutView });
      expect(missing.statusCode, url).toBe(400);
      expect(missing.json(), url).toMatchObject({ error: "bad_request" });
      for (const bad of [
        null,
        "tag=PLA",
        ["PLA"],
        { tag: "x".repeat(101) },
        { q: "x".repeat(201) },
      ]) {
        const res = await post(url, { ids: [A], ...withoutView, view: bad });
        expect(res.statusCode, `${url} ${JSON.stringify(bad)}`).toBe(400);
      }
      const full = { q: "benchy", tag: "PLA", collection: "Desk", creator: "Jon", printer: "P1S" };
      expect((await post(url, { ids: [A], ...withoutView, view: full })).statusCode, url).toBe(503);
    }
  });

  test("tags: at least one, at most 20, none blank or over 100 characters", async () => {
    const url = "/app/api/bulk/add-tags";
    const one = [A];
    expect((await post(url, { ids: one, tags: [], view })).statusCode).toBe(400);
    expect(
      (await post(url, { ids: one, tags: Array.from({ length: 21 }, (_, i) => `t${i}`), view }))
        .statusCode,
    ).toBe(400);
    expect((await post(url, { ids: one, tags: ["  "], view })).statusCode).toBe(400);
    expect((await post(url, { ids: one, tags: ["x".repeat(101)], view })).statusCode).toBe(400);
    expect((await post(url, { ids: one, view })).statusCode).toBe(400);
  });

  test("remove a tag and add to a collection need a name that is not blank", async () => {
    expect((await post("/app/api/bulk/remove-tag", { ids: [A], tag: " ", view })).statusCode).toBe(
      400,
    );
    expect(
      (await post("/app/api/bulk/add-to-collection", { ids: [A], collection: "", view }))
        .statusCode,
    ).toBe(400);
  });
});
