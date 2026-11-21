// Build plan Task 30: GET /healthz on the running server is 200 while the
// database answers and 503 once it is stopped, with no detail in the body;
// and the server still stops within the 30 s shutdown with its database gone.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type Server, SHUTDOWN_DEADLINE_MS, start } from "../../../src/main.js";
import { healthStatus, type ServerEnv, startServerEnv, until } from "../support/server.js";

let env: ServerEnv;
let server: Server | undefined;

beforeAll(async () => {
  env = await startServerEnv();
  server = await start(env.config);
});

afterAll(async () => {
  await server?.stop();
  await env?.stop();
});

describe("/healthz with the database stopped", () => {
  test("is 200 while the database is up, then 503 with no detail once it stops", async () => {
    expect(await healthStatus(env)).toBe(200);
    await env.pgc.container.stop();
    await until(
      () => healthStatus(env),
      (status) => status === 503,
      30_000,
    );
    const res = await fetch(`${env.baseUrl}/healthz`);
    const body = await res.text();
    expect(res.status).toBe(503);
    expect(body).not.toMatch(/ECONNREFUSED|postgres|5432|password|Error/i);
  });

  test("the server still stops within the shutdown deadline", async () => {
    const started = Date.now();
    await server?.stop();
    server = undefined;
    expect(Date.now() - started).toBeLessThan(SHUTDOWN_DEADLINE_MS);
    expect(await healthStatus(env)).toBeNull();
  });
});
