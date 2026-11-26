// The app sends its own security headers on every answer (issue #449): a
// Content-Security-Policy that allows only the app's own scripts, styles,
// fetches and frames (frame-ancestors 'none'), Referrer-Policy: no-referrer
// and X-Content-Type-Options: nosniff. A proxy in front no longer has to add
// them. Every answer carries them, errors and refusals included: the shell,
// the JSON API, a 404, the login redirect, a 401 without a session, a 429
// from the per-session limiter and a 400 Fastify gives before any hook runs.
// A header a route set itself is left as it is.
//
// The whole app (buildApp) with fakes: stub health, an upload store in a
// temp folder, an issuer that never answers a callback and sessions in
// memory. That the built index.html fits the policy (its script and
// stylesheet are same-origin files, nothing inline) is checked on the real
// vite build in shell.test.ts.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildApp } from "../../src/app.js";
import { SESSION_COOKIE, type Sessions } from "../../src/auth/sessions.js";
import type { Session } from "../../src/db/types.js";
import { addSecurityHeaders, SECURITY_HEADERS } from "../../src/web/security-headers.js";
import { readyUploads } from "../support/uploads.js";

const ORIGIN = "https://platehouse.test";
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const EXPECTED = {
  "content-security-policy": CSP,
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};
const COOKIE = "c".repeat(43);
const TOKEN = `ph_${"t".repeat(43)}`;
const TOKEN_ID = "0198f0c4-6a1b-7c2d-8e3f-4a5b6c7d8e9f";
const TEMPLATE = [
  "<!doctype html>",
  '<html lang="en" data-theme="dark">',
  "  <head>",
  '    <meta charset="utf-8" />',
  '    <meta name="color-scheme" content="dark" />',
  '    <script type="module" crossorigin src="/assets/index-AbC123.js"></script>',
  '    <link rel="stylesheet" crossorigin href="/assets/index-DeF456.css">',
  "  </head>",
  '  <body><div id="root"></div></body>',
  "</html>",
  "",
].join("\n");

function securityHeadersOf(headers: Record<string, unknown>) {
  return {
    "content-security-policy": headers["content-security-policy"],
    "referrer-policy": headers["referrer-policy"],
    "x-content-type-options": headers["x-content-type-options"],
  };
}

let dir: string;
let app: FastifyInstance | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "platehouse-headers-"));
  await mkdir(join(dir, "web", "assets"), { recursive: true });
  await writeFile(join(dir, "web", "index.html"), TEMPLATE);
  await writeFile(join(dir, "web", "assets", "index-AbC123.js"), "export {};\n");
});

afterEach(async () => {
  // Every app this file builds is closed before its temp folder goes.
  await app?.close();
  app = undefined;
  await rm(dir, { recursive: true, force: true });
});

async function newApp(): Promise<FastifyInstance> {
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
    find: async (cookie) => (cookie === COOKIE ? signedIn() : undefined),
    end: async () => {},
    signOutEverywhere: async () => ({
      sessionsEnded: 1,
      tokensRevoked: 0,
      unknownTokensRevoked: 0,
    }),
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
    appApi: {
      tokens: {
        tokens: {
          createTokenForSession: async () => ({ id: TOKEN_ID, token: TOKEN }),
          revokeToken: async () => true,
        },
        list: async () => [
          {
            id: TOKEN_ID,
            name: "Laptop",
            prefix: TOKEN.slice(0, 8),
            createdAt: new Date(),
            lastUsedAt: null,
            createdBySubject: "subject-a",
            createdByName: null,
          },
        ],
      },
    },
  });
  return app;
}

describe("every answer from the app carries the three security headers (issue #449)", () => {
  test("SECURITY_HEADERS holds exactly the three headers and their values", () => {
    expect({ ...SECURITY_HEADERS }).toEqual(EXPECTED);
  });

  test("GET / (the shell page, signed in)", async () => {
    const res = await (await newApp()).inject({
      method: "GET",
      url: "/",
      cookies: { [SESSION_COOKIE]: COOKIE },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/html/);
    expect(securityHeadersOf(res.headers)).toEqual(EXPECTED);
  });

  test("a built asset under /assets/", async () => {
    const res = await (await newApp()).inject({ method: "GET", url: "/assets/index-AbC123.js" });
    expect(res.statusCode).toBe(200);
    expect(securityHeadersOf(res.headers)).toEqual(EXPECTED);
  });

  test("GET /app/api/library (signed in, 200)", async () => {
    const res = await (await newApp()).inject({
      method: "GET",
      url: "/app/api/library",
      cookies: { [SESSION_COOKIE]: COOKIE },
    });
    expect(res.statusCode).toBe(200);
    expect(securityHeadersOf(res.headers)).toEqual(EXPECTED);
  });

  test("GET /app/api/settings (signed in; 503 here, as no settings are set up)", async () => {
    const res = await (await newApp()).inject({
      method: "GET",
      url: "/app/api/settings",
      cookies: { [SESSION_COOKIE]: COOKIE },
    });
    expect(res.statusCode).toBe(503);
    expect(securityHeadersOf(res.headers)).toEqual(EXPECTED);
  });

  test("GET /app/api/settings without a session (the gate's 401)", async () => {
    const res = await (await newApp()).inject({ method: "GET", url: "/app/api/settings" });
    expect(res.statusCode).toBe(401);
    expect(securityHeadersOf(res.headers)).toEqual(EXPECTED);
  });

  test("GET /does-not-exist (404)", async () => {
    const res = await (await newApp()).inject({
      method: "GET",
      url: "/does-not-exist",
      cookies: { [SESSION_COOKIE]: COOKIE },
    });
    expect(res.statusCode).toBe(404);
    expect(securityHeadersOf(res.headers)).toEqual(EXPECTED);
  });

  test("GET /auth/login (the redirect to the issuer)", async () => {
    const res = await (await newApp()).inject({ method: "GET", url: "/auth/login" });
    expect(res.statusCode).toBe(302);
    expect(securityHeadersOf(res.headers)).toEqual(EXPECTED);
  });

  test("GET /healthz", async () => {
    const res = await (await newApp()).inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(securityHeadersOf(res.headers)).toEqual(EXPECTED);
  });

  test("a refused slicer link (403, empty body)", async () => {
    const res = await (await newApp()).inject({ method: "GET", url: "/s/" });
    expect(res.statusCode).toBe(403);
    expect(securityHeadersOf(res.headers)).toEqual(EXPECTED);
  });

  test("a path Fastify cannot decode (its 400, given before any hook runs)", async () => {
    const res = await (await newApp()).inject({ method: "GET", url: "/%zz" });
    expect(res.statusCode).toBe(400);
    expect(securityHeadersOf(res.headers)).toEqual(EXPECTED);
  });

  test("POST /app/api/tokens over the per-session limit (429 rate_limited, issue #424)", async () => {
    const server = await newApp();
    const post = () =>
      server.inject({
        method: "POST",
        url: "/app/api/tokens",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        cookies: { [SESSION_COOKIE]: COOKIE },
        payload: JSON.stringify({ name: "Laptop" }),
      });
    for (let i = 0; i < 10; i++) {
      const res = await post();
      expect(res.statusCode, `create ${i + 1}: ${res.body}`).toBe(201);
      expect(securityHeadersOf(res.headers)).toEqual(EXPECTED);
    }
    const res = await post();
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({ error: "rate_limited" });
    expect(res.headers["retry-after"]).toBeDefined();
    expect(securityHeadersOf(res.headers)).toEqual(EXPECTED);
  });
});

describe("addSecurityHeaders leaves a header the route set itself", () => {
  async function bare(): Promise<FastifyInstance> {
    const server = Fastify({ logger: false });
    addSecurityHeaders(server);
    server.get("/own", async (_request, reply) =>
      reply.header("x-content-type-options", "route-value").send({ ok: true }),
    );
    server.get("/own-csp", async (_request, reply) =>
      reply.header("content-security-policy", "sandbox").send({ ok: true }),
    );
    server.get("/empty", async (_request, reply) =>
      reply.header("referrer-policy", "").send({ ok: true }),
    );
    server.get("/fails", async () => {
      throw new Error("boom");
    });
    server.register(
      async (scope) => {
        scope.get("/inner", async () => ({ ok: true }));
      },
      { prefix: "/scope" },
    );
    await server.ready();
    app = server;
    return server;
  }

  test("a route's own X-Content-Type-Options survives; the other two are the app's", async () => {
    const res = await (await bare()).inject({ method: "GET", url: "/own" });
    expect(securityHeadersOf(res.headers)).toEqual({
      ...EXPECTED,
      "x-content-type-options": "route-value",
    });
  });

  test("a route's own Content-Security-Policy survives", async () => {
    const res = await (await bare()).inject({ method: "GET", url: "/own-csp" });
    expect(res.headers["content-security-policy"]).toBe("sandbox");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
  });

  test("a header the route left empty gets the app's value", async () => {
    const res = await (await bare()).inject({ method: "GET", url: "/empty" });
    expect(securityHeadersOf(res.headers)).toEqual(EXPECTED);
  });

  test("an error answer (500) carries them", async () => {
    const res = await (await bare()).inject({ method: "GET", url: "/fails" });
    expect(res.statusCode).toBe(500);
    expect(securityHeadersOf(res.headers)).toEqual(EXPECTED);
  });

  test("a route in a plugin scope registered afterwards carries them", async () => {
    const res = await (await bare()).inject({ method: "GET", url: "/scope/inner" });
    expect(res.statusCode).toBe(200);
    expect(securityHeadersOf(res.headers)).toEqual(EXPECTED);
  });
});
