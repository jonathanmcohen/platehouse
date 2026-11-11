// Build plan Task 16 with Task 15's route-class gate: every Public API v1
// route, the tus upload routes at /api/v1/uploads included, is bearer-class.
// A bearer-class request is never sent to login and never needs Origin; a
// session cookie, or a token sent as a cookie, never authenticates it. The
// routes are read from app.printRoutes(), so a v1 route added later is
// checked without anyone listing it, and one registered where the gate would
// class it as anything but bearer (at /api/v1 itself, say) fails here.
//
// No container: tokens are in memory and the library is a stub that answers
// as an empty library would. The DB-backed operations are api.test.ts's.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTokens, TOKEN_BODY_LENGTH, TOKEN_PREFIX } from "../../../src/api/tokens.js";
import type { ApiLibrary, ApiModel } from "../../../src/api/v1.js";
import { patternClass } from "../../../src/auth/gate.js";
import { SESSION_COOKIE } from "../../../src/auth/sessions.js";
import {
  type AuthTestApp,
  authTestApp,
  concretePath,
  memoryTokenStore,
  type RouteEntry,
  registeredRoutes,
  TEST_ORIGIN,
} from "../support/oidc-issuer.js";

const MODEL: ApiModel = {
  id: "0198f0c4-6a1b-7c2d-8e3f-4a5b6c7d8e9f",
  name: "Stub model",
  caption: null,
  description: null,
  creator: null,
  license: null,
  licenseNote: null,
  externalRef: null,
  tags: [],
  collections: [],
  createdAt: "2026-11-11T00:00:00.000Z",
  updatedAt: "2026-11-11T00:00:00.000Z",
};

/** An empty library: nothing is found, and a create answers a fixed model. */
const emptyLibrary: ApiLibrary = {
  listModels: async () => ({ models: [], nextCursor: null }),
  createModel: async () => ({ model: MODEL }),
  getModel: async () => undefined,
  getFile: async () => undefined,
  openFile: async () => undefined,
  modelIsLive: async () => false,
  addTag: async () => false,
  removeTag: async () => false,
  addToCollection: async () => false,
  removeFromCollection: async () => false,
};

/** The operations of the Public API v1 contract, as Fastify registers them. */
const CONTRACT: Array<[string, string]> = [
  ["/api/v1/openapi.json", "GET"],
  ["/api/v1/models", "GET"],
  ["/api/v1/models", "POST"],
  ["/api/v1/models/:id", "GET"],
  ["/api/v1/files/:id", "GET"],
  ["/api/v1/files/:id/content", "GET"],
  ["/api/v1/models/:id/tags/:tag", "PUT"],
  ["/api/v1/models/:id/tags/:tag", "DELETE"],
  ["/api/v1/collections/:name/models/:id", "PUT"],
  ["/api/v1/collections/:name/models/:id", "DELETE"],
  ["/api/v1/uploads", "POST"],
  ["/api/v1/uploads/:id", "HEAD"],
  ["/api/v1/uploads/:id", "PATCH"],
  ["/api/v1/uploads/:id/result", "GET"],
];

let t: AuthTestApp;
let token: string;
let sessionCookie: string;
let routes: RouteEntry[];

function apiRoutes(): RouteEntry[] {
  return routes.filter((r) => r.path.startsWith("/api"));
}

beforeAll(async () => {
  const tokens = createTokens({ store: memoryTokenStore() });
  t = await authTestApp({ api: { tokens, library: emptyLibrary } });
  token = (await tokens.createToken("route-class test")).token;
  sessionCookie = (await t.sessions.start("someone")).id;
  routes = registeredRoutes(t.app);
});

afterAll(async () => {
  await t?.close();
});

describe("the v1 routes", () => {
  test("every operation of the contract is registered", () => {
    const listed = new Map(routes.map((r) => [r.path, r.methods]));
    for (const [path, method] of CONTRACT) {
      expect(listed.get(path), `${method} ${path}`).toContain(method);
    }
  });

  test("every route under /api is bearer-class", () => {
    const api = apiRoutes();
    expect(api.length).toBeGreaterThanOrEqual(new Set(CONTRACT.map(([p]) => p)).size);
    for (const route of api) {
      expect(patternClass(route.path), route.path).toBe("bearer");
    }
  });

  test("no route deletes, trashes or purges a model, a file or a blob", () => {
    for (const route of apiRoutes()) {
      expect(route.path, route.path).not.toMatch(/trash|purge|delete|restore/i);
      if (route.methods.includes("DELETE")) {
        expect(
          ["/api/v1/models/:id/tags/:tag", "/api/v1/collections/:name/models/:id"].includes(
            route.path,
          ),
          `DELETE ${route.path}`,
        ).toBe(true);
      }
    }
  });
});

describe("a request with no token", () => {
  test("is 401 JSON on every v1 route, never a login redirect, whatever else it carries", async () => {
    const tokenCookie = { [SESSION_COOKIE]: sessionCookie, ph_token: token, token };
    for (const route of apiRoutes()) {
      for (const method of route.methods) {
        for (const [label, extra] of [
          ["nothing", {}],
          ["a live session cookie", { cookies: { [SESSION_COOKIE]: sessionCookie } }],
          ["the token as a cookie", { cookies: tokenCookie }],
          ["the token in the query", { query: { access_token: token, token } }],
        ] as const) {
          const res = await t.app.inject({
            method: method as "GET",
            url: concretePath(route.path),
            headers: { accept: "text/html,application/json", origin: TEST_ORIGIN },
            ...extra,
          });
          const what = `${method} ${route.path} with ${label}`;
          expect(res.statusCode, what).toBe(401);
          expect(res.headers.location, what).toBeUndefined();
          expect(res.headers["set-cookie"], what).toBeUndefined();
          expect(res.headers["www-authenticate"], what).toBe("Bearer");
          if (method !== "HEAD") {
            expect(res.headers["content-type"], what).toMatch(/^application\/json/);
            expect(res.json(), what).toEqual({ error: "unauthorized" });
          }
        }
      }
    }
  });

  test("a well-formed token nobody issued is 401 too", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: "/api/v1/models",
      headers: { authorization: `Bearer ${TOKEN_PREFIX}${"z".repeat(TOKEN_BODY_LENGTH)}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "unauthorized" });
  });

  test("an unknown path under /api/v1 is 401, and 404 with a token", async () => {
    for (const method of ["GET", "POST", "DELETE"] as const) {
      const bare = await t.app.inject({ method, url: "/api/v1/no-such-route" });
      expect(bare.statusCode, method).toBe(401);
      expect(bare.json(), method).toEqual({ error: "unauthorized" });
      const withToken = await t.app.inject({
        method,
        url: "/api/v1/no-such-route",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(withToken.statusCode, method).toBe(404);
    }
  });
});

describe("a request with a token", () => {
  test("needs no Origin, and a foreign Origin does not refuse it", async () => {
    for (const origin of [undefined, "https://evil.example", TEST_ORIGIN]) {
      const res = await t.app.inject({
        method: "POST",
        url: "/api/v1/models",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...(origin === undefined ? {} : { origin }),
        },
        payload: JSON.stringify({ name: "Made by a script" }),
      });
      expect(res.statusCode, String(origin)).toBe(201);
    }
  });

  test("is answered by the route, and a session cookie beside it changes nothing", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: "/api/v1/models",
      headers: { authorization: `Bearer ${token}` },
      cookies: { [SESSION_COOKIE]: sessionCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ models: [], nextCursor: null });
  });
});

describe("CORS", () => {
  test("no v1 answer carries an Access-Control header, a preflight included", async () => {
    const preflight = {
      origin: "https://evil.example",
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization, content-type",
    };
    const requests = [
      { method: "OPTIONS", url: "/api/v1/models", headers: preflight },
      {
        method: "OPTIONS",
        url: "/api/v1/models",
        headers: { ...preflight, authorization: `Bearer ${token}` },
      },
      { method: "OPTIONS", url: "/api/v1/uploads", headers: preflight },
      { method: "GET", url: "/api/v1/models", headers: { origin: "https://evil.example" } },
      {
        method: "GET",
        url: "/api/v1/models",
        headers: { origin: "https://evil.example", authorization: `Bearer ${token}` },
      },
      {
        method: "GET",
        url: "/api/v1/openapi.json",
        headers: { origin: "https://evil.example", authorization: `Bearer ${token}` },
      },
      {
        method: "POST",
        url: "/api/v1/uploads",
        headers: {
          origin: "https://evil.example",
          authorization: `Bearer ${token}`,
          "tus-resumable": "1.0.0",
        },
      },
    ] as const;
    for (const r of requests) {
      const res = await t.app.inject({ method: r.method, url: r.url, headers: r.headers });
      const cors = Object.keys(res.headers).filter((h) => h.startsWith("access-control-"));
      expect(cors, `${r.method} ${r.url} (${res.statusCode})`).toEqual([]);
    }
  });
});
