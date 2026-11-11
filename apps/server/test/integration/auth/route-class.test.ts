// Build plan Task 15: routeClass(path) is the Route classes table of the
// contract, and anything unlisted is session. Every route the app registers
// has a class (walks app.printRoutes()), and answers a request with no
// credentials the way its class says: session routes 401 (or a redirect to
// login for a page), bearer routes their own 401 with cookies ignored,
// public routes are not refused, link routes 403. No route is open.
//
// No container: the issuer is the local mock and sessions are in memory.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { UPLOAD_PREFIXES } from "../../../src/app.js";
import { type RouteClass, routeClass } from "../../../src/auth/gate.js";
import { SESSION_COOKIE } from "../../../src/auth/sessions.js";
import {
  type AuthTestApp,
  authTestApp,
  concretePath,
  registeredRoutes,
  TEST_ORIGIN,
} from "../support/oidc-issuer.js";

describe("routeClass", () => {
  const cases: Array<[string, RouteClass]> = [
    // /api/v1/: bearer only
    ["/api/v1/uploads", "bearer"],
    ["/api/v1/uploads/:id", "bearer"],
    ["/api/v1/uploads/:id/result", "bearer"],
    ["/api/v1/models", "bearer"],
    ["/api/v1/openapi.json", "bearer"],
    // /s/: link token
    ["/s/:token/:name", "link"],
    ["/s/abc/cube.3mf", "link"],
    // /auth/, /healthz, /assets/: none
    ["/auth/login", "public"],
    ["/auth/callback", "public"],
    ["/auth/logout", "public"],
    ["/healthz", "public"],
    ["/assets/index-4f3a2b.js", "public"],
    // everything else: session
    ["/", "session"],
    ["/app/api/models", "session"],
    ["/app/uploads", "session"],
    ["/app/uploads/", "session"],
    ["/app/uploads/:id", "session"],
    ["/app/uploads/:id/result", "session"],
    ["/files/:id/download", "session"],
    ["/blobs/:id", "session"],
    ["/models/abc", "session"],
    ["/settings", "session"],
    // near misses of a listed prefix are unlisted, so session
    ["/api/v1", "session"],
    ["/api/v2/models", "session"],
    ["/api", "session"],
    ["/API/V1/models", "session"],
    ["/s", "session"],
    ["/auth", "session"],
    ["/authx/login", "session"],
    ["/healthz/", "session"],
    ["/healthzz", "session"],
    ["/Healthz", "session"],
    ["/assets", "session"],
    ["/assetsx/a.js", "session"],
    // a path that is not a plain route path is session, whatever it starts with
    ["/auth/../app/api/models", "session"],
    ["/auth/./login", "session"],
    ["/assets/%2e%2e/app", "session"],
    ["/api/v1/%2e%2e/files/x", "session"],
    ["//api/v1/models", "session"],
    ["/auth\\..\\files", "session"],
    ["auth/login", "session"],
    ["", "session"],
  ];

  test.each(cases)("%s is %s", (path, expected) => {
    expect(routeClass(path)).toBe(expected);
  });

  test("a query string does not change the class", () => {
    expect(routeClass("/healthz?x=1")).toBe("public");
    expect(routeClass("/api/v1/models?q=cube")).toBe("bearer");
    expect(routeClass("/app/api/models?next=/auth/login")).toBe("session");
    expect(routeClass("/files/1?/auth/")).toBe("session");
  });
});

describe("every registered route", () => {
  let t: AuthTestApp;
  let sessionCookie: string;

  beforeAll(async () => {
    t = await authTestApp();
    sessionCookie = (await t.sessions.start("someone")).id;
  });

  afterAll(async () => {
    await t?.close();
  });

  test("printRoutes lists the routes this task and Task 30 register", () => {
    const listed = new Map(registeredRoutes(t.app).map((r) => [r.path, r.methods]));
    const expected: Array<[string, string]> = [
      ["/healthz", "GET"],
      ["/healthz", "HEAD"],
      ["/auth/login", "GET"],
      ["/auth/callback", "GET"],
      ["/auth/logout", "POST"],
      ...[UPLOAD_PREFIXES.app, UPLOAD_PREFIXES.api].flatMap(
        (p): Array<[string, string]> => [
          [p, "POST"],
          [`${p}/:id`, "HEAD"],
          [`${p}/:id`, "PATCH"],
          [`${p}/:id/result`, "GET"],
        ],
      ),
    ];
    for (const [path, method] of expected) {
      expect(listed.get(path), `${method} ${path}`).toContain(method);
    }
  });

  test("each has a class and answers a request with no credentials as its class says", async () => {
    const routes = registeredRoutes(t.app);
    expect(routes.length).toBeGreaterThan(10);
    const seen = new Set<RouteClass>();
    for (const route of routes) {
      const cls = routeClass(route.path);
      expect(["bearer", "link", "public", "session"], route.path).toContain(cls);
      seen.add(cls);
      for (const method of route.methods) {
        const label = `${method} ${route.path} (${cls})`;
        const res = await t.app.inject({
          method: method as "GET",
          url: concretePath(route.path),
          // Same-origin, as the browser sends it: the Origin checks (the
          // gate's on every session route, POST /auth/logout's own) pass, so
          // what is left is the class's answer to no credentials.
          headers: { accept: "application/json", origin: TEST_ORIGIN },
        });
        const toLogin = res.headers.location === `${TEST_ORIGIN}/auth/login`;
        switch (cls) {
          case "session":
          case "bearer":
            expect(res.statusCode, label).toBe(401);
            expect(toLogin, label).toBe(false);
            if (method !== "HEAD") expect(res.json(), label).toEqual({ error: "unauthorized" });
            break;
          case "link":
            expect(res.statusCode, label).toBe(403);
            break;
          case "public":
            expect(res.statusCode, label).not.toBe(401);
            expect(res.statusCode, label).not.toBe(403);
            expect(toLogin, label).toBe(false);
            break;
        }
      }
    }
    expect([...seen].sort()).toEqual(["bearer", "public", "session"]);
  });

  test("a session lets a request past every session route, and no bearer route", async () => {
    for (const route of registeredRoutes(t.app)) {
      const cls = routeClass(route.path);
      if (cls !== "session" && cls !== "bearer") continue;
      for (const method of route.methods) {
        const res = await t.app.inject({
          method: method as "GET",
          url: concretePath(route.path),
          cookies: { [SESSION_COOKIE]: sessionCookie },
        });
        const label = `${method} ${route.path} (${cls})`;
        if (cls === "session") expect(res.statusCode, label).not.toBe(401);
        else expect(res.statusCode, label).toBe(401);
      }
    }
  });

  test("an unknown path is session: refused without one, 404 with one", async () => {
    const page = await t.app.inject({
      method: "GET",
      url: "/no-such-page",
      headers: { accept: "text/html,application/xhtml+xml" },
    });
    const api = await t.app.inject({
      method: "POST",
      url: "/no-such-route",
      headers: { origin: TEST_ORIGIN },
    });
    const signedIn = await t.app.inject({
      method: "GET",
      url: "/no-such-page",
      cookies: { [SESSION_COOKIE]: sessionCookie },
    });
    expect(page.statusCode).toBe(302);
    expect(page.headers.location).toBe(`${TEST_ORIGIN}/auth/login`);
    expect(api.statusCode).toBe(401);
    expect(signedIn.statusCode).toBe(404);
  });

  test("an unknown path gets the session Origin check too: a POST without Origin is 403", async () => {
    for (const cookies of [{}, { [SESSION_COOKIE]: sessionCookie }]) {
      const res = await t.app.inject({ method: "POST", url: "/no-such-route", cookies });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "forbidden" });
    }
  });

  test("an unknown path under a public prefix is a plain 404", async () => {
    for (const url of ["/auth/no-such-route", "/assets/no-such-file.js"]) {
      const res = await t.app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(404);
    }
  });
});
