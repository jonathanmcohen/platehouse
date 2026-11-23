// The root app's error handler: an error on a root route (a static file the
// server cannot read, a store outage in a hook) answers without its details.
// 4xx errors keep their status and message, a store outage is 503
// {error: "unavailable"} as the scoped handlers answer it, anything else is
// 500 {error: "internal"} with the cause in the log only. Every answer still
// carries the security headers. Scopes with their own handler are unchanged.
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildApp } from "../../src/app.js";
import { SESSION_COOKIE, type Sessions } from "../../src/auth/sessions.js";
import type { Session } from "../../src/db/types.js";
import { StoreUnavailable } from "../../src/storage/s3.js";
import { readyUploads } from "../support/uploads.js";

const ORIGIN = "https://platehouse.test";
const COOKIE = "c".repeat(43);
const TEMPLATE = [
  "<!doctype html>",
  '<html lang="en" data-theme="dark">',
  "  <head>",
  '    <meta charset="utf-8" />',
  '    <meta name="color-scheme" content="dark" />',
  "  </head>",
  '  <body><div id="root"></div></body>',
  "</html>",
  "",
].join("\n");

let dir: string;
let app: FastifyInstance | undefined;
let logLines: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "platehouse-errors-"));
  await mkdir(join(dir, "web", "assets"), { recursive: true });
  await writeFile(join(dir, "web", "index.html"), TEMPLATE);
  // A directory where the favicon should be: reading it fails with EISDIR.
  await mkdir(join(dir, "web", "favicon.ico"));
  logLines = [];
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  await rm(dir, { recursive: true, force: true });
});

async function newApp(find?: Sessions["find"]): Promise<FastifyInstance> {
  const signedIn = (): Session => {
    const now = Date.now();
    return {
      id: "S".repeat(43),
      subject: "subject-a",
      displayName: null,
      createdAt: new Date(now),
      expiresAt: new Date(now + 24 * 60 * 60_000),
      idleExpiresAt: new Date(now + 24 * 60 * 60_000),
    };
  };
  const sessions: Sessions = {
    start: async () => {
      throw new Error("not used");
    },
    find: find ?? (async (cookie) => (cookie === COOKIE ? signedIn() : undefined)),
    end: async () => {},
    signOutEverywhere: async () => ({ sessionsEnded: 1, tokensRevoked: 0 }),
  };
  // The store has made its folder before the app is built (support/uploads.ts).
  const uploads = await readyUploads(join(dir, "tmp"));
  app = await buildApp({
    health: { database: async () => 1, queuesRunning: () => true },
    uploads,
    auth: {
      oidc: {
        begin: async () => ({
          url: new URL("https://issuer.test/authorize?state=s"),
          checks: { codeVerifier: "v".repeat(43), state: "s".repeat(22), nonce: "n".repeat(22) },
        }),
        finish: async () => {
          throw new Error("not used");
        },
      },
      sessions,
      publicOrigin: ORIGIN,
      absoluteUrl: (path) => `${ORIGIN}${path}`,
      cookieSecret: Buffer.alloc(32, 7),
    },
    web: { dir: join(dir, "web") },
    logger: { write: (line) => logLines.push(String(line)) },
  });
  return app;
}

function expectSecurityHeaders(headers: Record<string, unknown>) {
  expect(headers["content-security-policy"]).toContain("default-src 'self'");
  expect(headers["referrer-policy"]).toBe("no-referrer");
  expect(headers["x-content-type-options"]).toBe("nosniff");
}

describe("the root error handler (issue #455)", () => {
  test("a root file that cannot be read answers 500 {error: internal} with no path, and logs the error", async () => {
    const res = await (await newApp()).inject({ method: "GET", url: "/favicon.ico" });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal" });
    expect(res.body).not.toContain(dir);
    expect(res.body).not.toContain("EISDIR");
    expectSecurityHeaders(res.headers);
    const logged = logLines.join("");
    expect(logged).toContain("EISDIR");
    expect(logged).toContain('"level":50');
  });

  test("a store outage on a root route is 503 {error: unavailable}", async () => {
    const root = await newApp();
    root.get("/test/outage", async () => {
      throw new StoreUnavailable("read a file", "ECONNREFUSED");
    });
    const res = await root.inject({
      method: "GET",
      url: "/test/outage",
      cookies: { [SESSION_COOKIE]: COOKIE },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "unavailable" });
    expectSecurityHeaders(res.headers);
  });

  test("a 4xx on a root route (a bad request schema) keeps its status and message", async () => {
    const root = await newApp();
    root.get(
      "/test/schema",
      {
        schema: {
          querystring: { type: "object", required: ["n"], properties: { n: { type: "integer" } } },
        },
      },
      async () => ({ ok: true }),
    );
    const res = await root.inject({
      method: "GET",
      url: "/test/schema",
      cookies: { [SESSION_COOKIE]: COOKIE },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      statusCode: 400,
      message: "querystring must have required property 'n'",
    });
    expectSecurityHeaders(res.headers);
  });

  test("a 404 keeps its status and message", async () => {
    const res = await (await newApp()).inject({
      method: "GET",
      url: "/nothing-here",
      cookies: { [SESSION_COOKIE]: COOKIE },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Not Found", statusCode: 404 });
  });

  test("a 416 from /assets/ keeps its Content-Range header", async () => {
    await writeFile(join(dir, "web", "assets", "a.js"), "export {};\n");
    const res = await (await newApp()).inject({
      method: "GET",
      url: "/assets/a.js",
      headers: { range: "bytes=9999-" },
    });
    expect(res.statusCode).toBe(416);
    expect(res.headers["content-range"]).toBe("bytes */11");
    expectSecurityHeaders(res.headers);
  });

  test("a route that set a 4xx with reply.code() and then threw keeps that status", async () => {
    const root = await newApp();
    root.get("/test/conflict", async (_request, reply) => {
      reply.code(409);
      throw new Error("/srv/private/detail");
    });
    const res = await root.inject({
      method: "GET",
      url: "/test/conflict",
      cookies: { [SESSION_COOKIE]: COOKIE },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "Conflict", statusCode: 409 });
    expect(res.body).not.toContain("private");
    expect(res.body).not.toContain("/srv");
  });

  test("a route that threw after setting a status and a header keeps neither of the failed answer", async () => {
    const root = await newApp();
    root.get("/test/stale", async (_request, reply) => {
      reply.raw.setHeader("content-type", "text/javascript");
      reply.raw.setHeader("cache-control", "public, max-age=31536000, immutable");
      reply.raw.setHeader("etag", '"abc"');
      throw new Error("/srv/private/detail");
    });
    const res = await root.inject({
      method: "GET",
      url: "/test/stale",
      cookies: { [SESSION_COOKIE]: COOKIE },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal" });
    expect(res.headers["cache-control"]).not.toContain("immutable");
    expect(res.headers.etag).toBeUndefined();
    expectSecurityHeaders(res.headers);
  });

  test.skipIf(process.getuid?.() === 0)(
    "an /assets/ file that can be found but not opened answers 500 {error: internal} and no caching headers",
    async () => {
      const file = join(dir, "web", "assets", "locked.js");
      await writeFile(file, "export {};\n");
      await chmod(file, 0o000);
      const res = await (await newApp()).inject({ method: "GET", url: "/assets/locked.js" });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: "internal" });
      expect(res.headers["cache-control"] ?? "").not.toContain("immutable");
      expect(res.headers.etag).toBeUndefined();
      expect(res.headers["last-modified"]).toBeUndefined();
      expectSecurityHeaders(res.headers);
    },
  );
});
