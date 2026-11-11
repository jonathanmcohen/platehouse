// Build plan Task 15 on the real server: start(config) wires sessions to the
// sessions table and the gate to every route. Pocket ID is a port nothing
// listens on, so this is also AC-081 end to end: /auth/login is 503 and a
// bearer-class route still gives its own 401, while a session in the
// database lets a request through. Every route the running app registers
// answers a request with no credentials the way its class says; the walk
// sends Origin: PUBLIC_ORIGIN, as a browser on the app's own pages would, so
// a state-changing request meets the credential check and not the Origin one.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { UPLOAD_PREFIXES } from "../../../src/app.js";
import { patternClass } from "../../../src/auth/gate.js";
import { LOGIN_UNAVAILABLE } from "../../../src/auth/routes.js";
import { SESSION_COOKIE, sessionRowId } from "../../../src/auth/sessions.js";
import { loadConfig } from "../../../src/config.js";
import { type Server, start } from "../../../src/main.js";
import { concretePath, registeredRoutes } from "../support/oidc-issuer.js";
import { freePort, type ServerEnv, startServerEnv } from "../support/server.js";

const RESULT = `${UPLOAD_PREFIXES.app}/0198f0c4-6a1b-7c2d-8e3f-4a5b6c7d8e9f/result`;

let env: ServerEnv;
let server: Server | undefined;
let session: string;

beforeAll(async () => {
  env = await startServerEnv();
  const deadIssuer = `https://127.0.0.1:${await freePort()}`;
  server = await start(loadConfig({ ...env.env, OIDC_ISSUER: deadIssuer }));
  session = randomBytes(32).toString("base64url");
  const now = Date.now();
  // The row is stored under the cookie value's hash, as sessions.start does.
  await env.repos.sessions.create({
    id: sessionRowId(session),
    subject: "someone",
    expiresAt: new Date(now + 24 * 60 * 60 * 1000),
    idleExpiresAt: new Date(now + 60 * 60 * 1000),
  });
});

afterAll(async () => {
  await server?.stop();
  await env?.stop();
});

async function get(path: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${env.baseUrl}${path}`, { headers, redirect: "manual" });
  return { status: res.status, headers: res.headers, body: await res.text() };
}

describe("the running server", () => {
  test("a session in the sessions table lets a request through; none is refused", async () => {
    expect((await get(RESULT, { cookie: `${SESSION_COOKIE}=${session}` })).status).toBe(404);
    expect((await get(RESULT)).status).toBe(401);
    const page = await get("/models/abc", { accept: "text/html" });
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe(`${env.config.publicOrigin}/auth/login`);
  });

  test("with Pocket ID unreachable, /auth/login is 503 and the API keeps its own 401", async () => {
    const login = await get("/auth/login");
    expect(login.status).toBe(503);
    expect(login.body).toContain(LOGIN_UNAVAILABLE);
    const res = await fetch(`${env.baseUrl}${UPLOAD_PREFIXES.api}`, {
      method: "POST",
      headers: { "tus-resumable": "1.0.0", "upload-length": "11" },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  test("a cross-origin POST to /app/api is 403 even with a session", async () => {
    const res = await fetch(`${env.baseUrl}/app/api/models`, {
      method: "POST",
      headers: { origin: "https://evil.example", cookie: `${SESSION_COOKIE}=${session}` },
    });
    await res.arrayBuffer();
    expect(res.status).toBe(403);
  });

  test("every route it registers answers a request with no credentials as its class says", async () => {
    const app = server?.app;
    if (app === undefined) throw new Error("no server");
    const routes = registeredRoutes(app);
    expect(routes.some((r) => r.path === "/auth/callback")).toBe(true);
    for (const route of routes) {
      const cls = patternClass(route.path);
      for (const method of route.methods) {
        const res = await app.inject({
          method: method as "GET",
          url: concretePath(route.path),
          headers: { origin: env.config.publicOrigin },
        });
        const label = `${method} ${route.path} (${cls})`;
        if (cls === "session" || cls === "bearer") expect(res.statusCode, label).toBe(401);
        else if (cls === "link") expect(res.statusCode, label).toBe(403);
        else expect([401, 403], label).not.toContain(res.statusCode);
      }
    }
  });
});
