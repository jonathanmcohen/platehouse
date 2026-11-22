// Deleting a tag or a collection (issue #312), the parts that need no
// database: the two routes exist on the app API, take the name in the query
// string as the other organising routes do, and refuse a missing, blank or
// over-long name before they touch anything. What a delete does to the rows
// is in test/integration/app-api/settings.test.ts.
import Fastify from "fastify";
import { describe, expect, test } from "vitest";
import { registerOrganiseApi } from "../../src/app-api/organise.js";

async function app() {
  const server = Fastify({ logger: false });
  // No dependencies: a request that passes validation answers 503.
  await registerOrganiseApi(server, undefined);
  await server.ready();
  return server;
}

describe.each(["tags", "collections"])("DELETE /app/api/%s", (list) => {
  test("is a route that takes the name in the query", async () => {
    const server = await app();
    const res = await server.inject({ method: "DELETE", url: `/app/api/${list}?name=Desk` });
    expect(res.statusCode).toBe(503);
  });

  test.each([
    ["no name", ""],
    ["a blank name", "?name=%20%20"],
    ["a name over 100 characters", `?name=${"x".repeat(101)}`],
  ])("refuses %s with 400", async (_why, query) => {
    const server = await app();
    const res = await server.inject({ method: "DELETE", url: `/app/api/${list}${query}` });
    expect(res.statusCode).toBe(400);
  });
});
