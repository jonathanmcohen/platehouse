// Build plan Task 16 with Task 30's start(config): the server process wires
// the API. A token made with createToken against the server's own database
// (as Task 21's settings page will) is accepted by the running server, a
// revoked one is not, and the API description names PUBLIC_ORIGIN. The
// server is the real one, against Postgres 17, the S3 test server and the
// slicer stub.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTokens, dbTokenStore, type Tokens } from "../../../src/api/tokens.js";
import { type Server, start } from "../../../src/main.js";
import { type ServerEnv, startServerEnv } from "../support/server.js";

let env: ServerEnv;
let server: Server | undefined;
let tokens: Tokens;

beforeAll(async () => {
  env = await startServerEnv();
  server = await start(env.config);
  tokens = createTokens({ store: dbTokenStore(env.db) });
});

afterAll(async () => {
  await server?.stop();
  await env?.stop();
});

async function get(path: string, bearer?: string) {
  const res = await fetch(`${env.baseUrl}${path}`, {
    headers: bearer === undefined ? {} : { authorization: `Bearer ${bearer}` },
  });
  return { status: res.status, body: await res.text() };
}

describe("the running server", () => {
  test("accepts a token createToken made, and refuses it once revoked", async () => {
    const created = await tokens.createToken("server test");
    expect((await get("/api/v1/models")).status).toBe(401);
    const ok = await get("/api/v1/models", created.token);
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ models: [], nextCursor: null });
    expect(await tokens.revokeToken(created.id)).toBe(true);
    expect((await get("/api/v1/models", created.token)).status).toBe(401);
  });

  test("describes the API at PUBLIC_ORIGIN", async () => {
    const created = await tokens.createToken("openapi");
    const res = await get("/api/v1/openapi.json", created.token);
    expect(res.status).toBe(200);
    const doc = JSON.parse(res.body) as { servers: Array<{ url: string }> };
    expect(doc.servers[0]?.url).toBe(`${env.env.PUBLIC_ORIGIN}/api/v1`);
  });
});
