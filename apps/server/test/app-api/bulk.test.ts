// The library's bulk actions (Jon, 2026-11-19), the parts that need no
// database: how the selected ids are read (deduplicated ignoring case, a
// malformed one reported as not found without a query) and what the routes
// refuse before they touch anything (no ids, more than the cap, too many or
// blank tags). The database side (valid, trashed and missing models, one
// transaction, what changed) is in test/integration/app-api/bulk.test.ts.
import Fastify from "fastify";
import { describe, expect, test } from "vitest";
import { registerOrganiseApi } from "../../src/app-api/organise.js";
import { MAX_BULK_IDS, MAX_BULK_TAGS, readIds } from "../../src/repos/bulk.js";

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

  const ROUTES: Array<[string, Record<string, unknown>]> = [
    ["/app/api/bulk/add-tags", { tags: ["PLA"] }],
    ["/app/api/bulk/remove-tag", { tag: "PLA" }],
    ["/app/api/bulk/add-to-collection", { collection: "Desk" }],
    ["/app/api/bulk/trash", {}],
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

  test("tags: at least one, at most 20, none blank or over 100 characters", async () => {
    const url = "/app/api/bulk/add-tags";
    const one = [A];
    expect((await post(url, { ids: one, tags: [] })).statusCode).toBe(400);
    expect(
      (await post(url, { ids: one, tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }))
        .statusCode,
    ).toBe(400);
    expect((await post(url, { ids: one, tags: ["  "] })).statusCode).toBe(400);
    expect((await post(url, { ids: one, tags: ["x".repeat(101)] })).statusCode).toBe(400);
    expect((await post(url, { ids: one })).statusCode).toBe(400);
  });

  test("remove a tag and add to a collection need a name that is not blank", async () => {
    expect((await post("/app/api/bulk/remove-tag", { ids: [A], tag: " " })).statusCode).toBe(400);
    expect(
      (await post("/app/api/bulk/add-to-collection", { ids: [A], collection: "" })).statusCode,
    ).toBe(400);
  });
});
