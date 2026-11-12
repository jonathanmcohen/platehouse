// Build plan Task 15: patternClass(pattern) for a matched route and
// routeClass(path) for an unmatched request are the Route classes table of
// the contract, and anything unlisted is session. Every route the app
// registers has a class (walks app.printRoutes()), and answers a request with no
// credentials the way its class says: session routes 401 (or a redirect to
// login for a page), bearer routes their own 401 with cookies ignored,
// public routes are not refused, link routes 403. No route is open.
//
// No container: the issuer is the local mock and sessions are in memory.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { UPLOAD_PREFIXES } from "../../../src/app.js";
import { patternClass, type RouteClass, routeClass } from "../../../src/auth/gate.js";
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
    // a path that is not a plain route path is session, whatever it starts
    // with, except under /api/v1/ (below)
    ["/auth/../app/api/models", "session"],
    ["/auth/./login", "session"],
    ["/assets/%2e%2e/app", "session"],
    ["//api/v1/models", "session"],
    ["/app/api/%2e%2e/x", "session"],
    // an unmatched path that starts /api/v1/ is bearer even when it is not a
    // plain route path: it can serve nothing but the 404, and as session a
    // typo such as Big%20thing was sent to the login or refused for Origin,
    // and a valid token never got its 404 (issue #140)
    ["/api/v1/%2e%2e/files/x", "bearer"],
    ["/api/v1/model/Big%20thing", "bearer"],
    ["/api/v1//models", "bearer"],
    ["/api/v1/./models", "bearer"],
    ["/api/v1/../app/api/models", "bearer"],
    ["/api/v1/models\\x", "bearer"],
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

describe("patternClass", () => {
  // A matched route's registered pattern is code, not a request, so it is
  // classed by its prefix alone. Fastify writes a regex-constrained param
  // with backslashes (and may use ?, % or // inside the regex), which the
  // plain-path test on raw request paths would wrongly class as session.
  const cases: Array<[string, RouteClass]> = [
    ["/api/v1/models", "bearer"],
    ["/api/v1/models/:id(\\d+)", "bearer"],
    ["/api/v1/models/:id(^\\d+)/files/:name", "bearer"],
    ["/api/v1/uploads/:id(^[\\w-]{36}$)?", "bearer"],
    ["/s/:token/:name", "link"],
    ["/s/:token(^[\\w-]+)/:name", "link"],
    ["/s/:token(^[A-Za-z0-9_%-]+)/:name", "link"],
    ["/auth/login", "public"],
    ["/assets/:file(^[\\w.-]+\\.js$)", "public"],
    ["/healthz", "public"],
    ["/app/uploads/:id(\\d+)", "session"],
    ["/files/:id(\\d+)/download", "session"],
    ["/", "session"],
    ["/api/v1", "session"],
    ["/s", "session"],
    ["/healthz/", "session"],
    ["*", "session"],
    ["", "session"],
  ];

  test.each(cases)("%s is %s", (pattern, expected) => {
    expect(patternClass(pattern)).toBe(expected);
  });

  test("agrees with routeClass on every plain path routeClass accepts", () => {
    for (const path of ["/api/v1/models", "/s/abc/cube.3mf", "/auth/login", "/settings"]) {
      expect(patternClass(path), path).toBe(routeClass(path));
    }
  });
});

describe("a route registered with a regex-constrained param", () => {
  // Registered here, in the test only (never shipped code), the way Task 16's
  // bearer routes and Task 17's link routes may be: the gate classes them by
  // their prefix, so a bearer or link route is never made to need a session
  // cookie or a same-origin Origin header, and a session route still does.
  const BEARER = "/api/v1/regex-test/:id(^\\d+)";
  const LINK = "/s/:token(^[\\w-]+)/:name";
  const SESSION = "/regex-test/:id(^\\d+)";
  let t: AuthTestApp;
  const ran: string[] = [];

  beforeAll(async () => {
    t = await authTestApp({
      beforeReady: (app) => {
        for (const url of [BEARER, LINK, SESSION]) {
          app.route({
            method: ["GET", "POST"],
            url,
            handler: async () => {
              ran.push(url);
              return { ok: true };
            },
          });
        }
      },
    });
  });

  afterAll(async () => {
    await t?.close();
  });

  test("bearer and link routes reach their handler with no cookie and no Origin", async () => {
    for (const [url, route] of [
      ["/api/v1/regex-test/42", BEARER],
      ["/s/abc-123/cube.3mf", LINK],
    ] as const) {
      for (const method of ["GET", "POST"] as const) {
        ran.length = 0;
        const res = await t.app.inject({ method, url, headers: { accept: "text/html" } });
        expect(res.statusCode, `${method} ${url}`).toBe(200);
        expect(ran, `${method} ${url}`).toEqual([route]);
      }
    }
  });

  test("a session route with a regex param still needs Origin and a session", async () => {
    ran.length = 0;
    const post = await t.app.inject({ method: "POST", url: "/regex-test/42" });
    const get = await t.app.inject({ method: "GET", url: "/regex-test/42" });
    expect(post.statusCode).toBe(403);
    expect(get.statusCode).toBe(401);
    expect(ran).toEqual([]);
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
      const cls = patternClass(route.path);
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
      const cls = patternClass(route.path);
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

  // Issue #140: before, these were session, so the page was sent to the login
  // and the PUT without Origin was 403, whatever bearer token came with it.
  // inject parses the URL as a browser does and resolves a dot segment, %2e%2e
  // included, before the app sees it, so a dot segment cannot be sent this
  // way; the routeClass cases above cover it.
  test.each([
    ["a percent escape", "/api/v1/model/Big%20thing"],
    ["an escaped slash", "/api/v1/models%2Fx"],
    ["a doubled slash", "/api/v1//models"],
  ])(
    "an unknown /api/v1 path with %s is bearer: 401 JSON, never the login or 403",
    async (_label, url) => {
      for (const method of ["GET", "PUT", "DELETE"] as const) {
        for (const cookies of [{}, { [SESSION_COOKIE]: sessionCookie }]) {
          const res = await t.app.inject({
            method,
            url,
            cookies,
            headers: { accept: "text/html" },
          });
          const label = `${method} ${url} ${Object.keys(cookies).length ? "with" : "without"} a session`;
          expect(res.statusCode, label).toBe(401);
          expect(res.json(), label).toEqual({ error: "unauthorized" });
          expect(res.headers["cache-control"], label).toBe("no-store");
        }
      }
    },
  );

  test("an unknown path under a public prefix is a plain 404", async () => {
    for (const url of ["/auth/no-such-route", "/assets/no-such-file.js"]) {
      const res = await t.app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(404);
    }
  });
});
