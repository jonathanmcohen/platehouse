// Build plan Task 15, AC-081: when Pocket ID cannot be reached, /auth/login
// shows "Login is unavailable right now" with status 503, and nothing else
// depends on it. A bearer-class route is not touched by the issuer: it still
// gives its own 401, never the login page and never a 503. An existing
// session keeps working. Login works again once the issuer is back, since a
// failed discovery is not remembered.
//
// API tokens arrive in Task 16; the "API tokens still work" half of AC-081 is
// proved by Task 16's tests. Here the bearer route is /api/v1/uploads, which
// refuses every request until then.
//
// No container: the issuer is the local mock, or a port nothing listens on,
// or a socket that never answers.
import { once } from "node:events";
import net, { type AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { UPLOAD_PREFIXES } from "../../../src/app.js";
import { ISSUER_TIMEOUT_SECONDS } from "../../../src/auth/oidc.js";
import { LOGIN_UNAVAILABLE } from "../../../src/auth/routes.js";
import { SESSION_COOKIE } from "../../../src/auth/sessions.js";
import {
  type AuthTestApp,
  authTestApp,
  loginCookieOf,
  runLogin,
  startMockIssuer,
  TEST_ORIGIN,
} from "../support/oidc-issuer.js";
import { freePort } from "../support/server.js";

let t: AuthTestApp | undefined;
let silent: net.Server | undefined;

afterEach(async () => {
  await t?.close();
  t = undefined;
  if (silent) {
    silent.close();
    silent = undefined;
  }
});

/** An app whose issuer is a port on loopback that nothing listens on. */
async function appWithIssuerDown(): Promise<AuthTestApp> {
  const port = await freePort();
  t = await authTestApp({ issuerUrl: `http://127.0.0.1:${port}` });
  return t;
}

/** An app whose issuer accepts connections and never answers. */
async function appWithSilentIssuer(): Promise<AuthTestApp> {
  silent = net.createServer(() => {});
  silent.listen(0, "127.0.0.1");
  await once(silent, "listening");
  const port = (silent.address() as AddressInfo).port;
  t = await authTestApp({ issuerUrl: `http://127.0.0.1:${port}` });
  return t;
}

function expectUnavailablePage(res: Awaited<ReturnType<AuthTestApp["app"]["inject"]>>) {
  expect(res.statusCode).toBe(503);
  expect(res.headers["content-type"]).toMatch(/^text\/html/);
  expect(res.body).toContain(LOGIN_UNAVAILABLE);
  expect(res.headers["cache-control"]).toBe("no-store");
  expect(res.body).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|fetch failed|Error/);
}

describe("with the issuer down", () => {
  test('/auth/login is 503 "Login is unavailable right now"', async () => {
    const app = (await appWithIssuerDown()).app;
    const res = await app.inject({ method: "GET", url: "/auth/login" });
    expectUnavailablePage(res);
    expect(LOGIN_UNAVAILABLE).toBe("Login is unavailable right now");
    expect(loginCookieOf(res)).toBeUndefined();
  });

  test("a bearer-class route still gives its own 401, never the login page or a 503", async () => {
    // An issuer that never answers: a route that waited on it would take
    // ISSUER_TIMEOUT_SECONDS, and one that failed on it would be a 503.
    const { app } = await appWithSilentIssuer();
    const requests = [
      { method: "POST", url: UPLOAD_PREFIXES.api, headers: { "tus-resumable": "1.0.0" } },
      {
        method: "POST",
        url: UPLOAD_PREFIXES.api,
        headers: { "tus-resumable": "1.0.0", authorization: "Bearer ph_notarealtoken" },
      },
      {
        method: "GET",
        url: `${UPLOAD_PREFIXES.api}/0198f0c4-6a1b-7c2d-8e3f-4a5b6c7d8e9f/result`,
        headers: { accept: "text/html" },
      },
    ] as const;
    for (const r of requests) {
      const started = Date.now();
      const res = await app.inject({ method: r.method, url: r.url, headers: r.headers });
      const label = `${r.method} ${r.url}`;
      expect(res.statusCode, label).toBe(401);
      expect(res.json(), label).toEqual({ error: "unauthorized" });
      expect(res.headers.location, label).toBeUndefined();
      expect(res.body, label).not.toContain(LOGIN_UNAVAILABLE);
      // Not waiting on the issuer: well inside its timeout.
      expect(Date.now() - started, label).toBeLessThan(1_000);
    }
  });

  test("a session made before the outage keeps working", async () => {
    const auth = await appWithIssuerDown();
    const session = await auth.sessions.start("someone");
    const res = await auth.app.inject({
      method: "GET",
      url: `${UPLOAD_PREFIXES.app}/0198f0c4-6a1b-7c2d-8e3f-4a5b6c7d8e9f/result`,
      cookies: { [SESSION_COOKIE]: session.id },
    });
    expect(res.statusCode).toBe(404);
  });

  test("the callback is 503 when the issuer goes down mid-login, and makes no session", async () => {
    t = await authTestApp();
    const auth = t;
    const run = await runLogin(auth, { beforeCallback: () => auth.issuer.stop() });
    expectUnavailablePage(run.callback);
    expect(run.sessionCookie).toBeUndefined();
    expect(auth.store.rows.size).toBe(0);
  });

  test("an issuer that accepts the connection and never answers is 503 within its timeout", async () => {
    const { app } = await appWithSilentIssuer();
    const started = Date.now();
    const res = await app.inject({ method: "GET", url: "/auth/login" });
    expectUnavailablePage(res);
    expect(Date.now() - started).toBeLessThan(ISSUER_TIMEOUT_SECONDS * 1000 + 3_000);
    expect(ISSUER_TIMEOUT_SECONDS).toBeLessThanOrEqual(10);
  }, 30_000);

  test("login works again once the issuer is back", async () => {
    const first = await startMockIssuer();
    const port = Number(new URL(first.url).port);
    t = await authTestApp({ issuer: first });
    await first.stop();
    const down = await t.app.inject({ method: "GET", url: "/auth/login" });
    expect(down.statusCode).toBe(503);

    const back = await startMockIssuer({
      port,
      clientId: first.clientId,
      clientSecret: first.clientSecret,
    });
    const auth = { app: t.app, issuer: back };
    try {
      const run = await runLogin(auth);
      expect(run.callback.statusCode).toBe(302);
      expect(run.callback.headers.location).toBe(`${TEST_ORIGIN}/`);
      expect(run.sessionCookie).toBeDefined();
    } finally {
      await back.stop();
    }
  });
});
