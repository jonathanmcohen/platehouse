// The model page's routes (app-api/model.ts registerModelApi), the parts that
// need no database: a request the route's schema refuses is the client's
// mistake, so it answers 400 bad_request and is not logged as a server
// failure, as the library, settings and organising routes already do; a
// failure inside the model page is still 500 internal, logged, with no
// detail in the answer. The database side is in
// test/integration/app-api/model.test.ts.
import Fastify from "fastify";
import { describe, expect, test } from "vitest";
import { type AppModel, emptyAppModel, registerModelApi } from "../../src/app-api/model.js";

const MODEL_ID = "01900000-0000-7000-8000-0000000000b1";

async function app(model: AppModel = emptyAppModel) {
  const lines: string[] = [];
  const server = Fastify({
    logger: {
      level: "info",
      stream: {
        write(line: string) {
          lines.push(line);
        },
      },
    },
  });
  await registerModelApi(server, model);
  await server.ready();
  return { server, lines };
}

/** Lines logged at error level (pino level 50) or above. */
function errorLines(lines: readonly string[]): string[] {
  return lines.filter((line) => (JSON.parse(line) as { level: number }).level >= 50);
}

describe("the model page's route", () => {
  test("an over-long printer is a bad request, not a server failure", async () => {
    const { server, lines } = await app();
    const res = await server.inject({
      url: `/app/api/models/${MODEL_ID}?printer=${"p".repeat(201)}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "bad_request" });
    expect(errorLines(lines)).toEqual([]);
  });

  test("a printer given twice is a bad request, not a server failure", async () => {
    const { server, lines } = await app();
    const res = await server.inject({ url: `/app/api/models/${MODEL_ID}?printer=a&printer=b` });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "bad_request" });
    expect(errorLines(lines)).toEqual([]);
  });

  test("a printer within the limit reaches the model page", async () => {
    const seen: (string | undefined)[] = [];
    const { server } = await app({
      ...emptyAppModel,
      get: async (_id, printer) => {
        seen.push(printer);
        return undefined;
      },
    });
    const res = await server.inject({
      url: `/app/api/models/${MODEL_ID}?printer=${"p".repeat(200)}`,
    });
    expect(res.statusCode).toBe(404);
    expect(seen).toEqual(["p".repeat(200)]);
  });

  test("a failure inside the model page is still 500, logged, with no detail", async () => {
    const { server, lines } = await app({
      ...emptyAppModel,
      get: async () => {
        throw new Error("connect ECONNREFUSED db.internal:5432");
      },
    });
    const res = await server.inject({ url: `/app/api/models/${MODEL_ID}` });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal" });
    expect(errorLines(lines)).toHaveLength(1);
  });
});
