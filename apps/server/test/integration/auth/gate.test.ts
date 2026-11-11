// Build plan Task 15: the gate for session routes. A request with no live
// session is refused: a page (a GET or HEAD that accepts HTML) is sent to
// /auth/login on PUBLIC_ORIGIN, anything else gets 401 JSON. A session store
// that fails answers 503 with no detail. Every state-changing request (any
// method but GET, HEAD and OPTIONS) on a session-class route needs Origin to
// equal PUBLIC_ORIGIN, or it gets 403 before any session lookup: /app/api,
// the tus routes at /app/uploads, and any session route added later, which
// is covered by default because the check follows the matched route's class.
//
// No container: sessions are in memory.
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { UPLOAD_PREFIXES } from "../../../src/app.js";
import { routeClass } from "../../../src/auth/gate.js";
import { SESSION_COOKIE } from "../../../src/auth/sessions.js";
import { uploadsDir } from "../../../src/uploads/tus.js";
import {
  type AuthTestApp,
  authTestApp,
  memorySessionStore,
  setCookie,
  TEST_ORIGIN,
} from "../support/oidc-issuer.js";

const RESULT_PATH = "/app/uploads/0198f0c4-6a1b-7c2d-8e3f-4a5b6c7d8e9f/result";
const HTML = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

let t: AuthTestApp;
let session: string;

beforeEach(async () => {
  t = await authTestApp();
  session = (await t.sessions.start("someone")).id;
});

afterEach(async () => {
  await t?.close();
});

describe("a session route with no session", () => {
  test("a page request is sent to /auth/login on PUBLIC_ORIGIN", async () => {
    for (const method of ["GET", "HEAD"] as const) {
      const res = await t.app.inject({ method, url: "/models/abc", headers: { accept: HTML } });
      expect(res.statusCode, method).toBe(302);
      expect(res.headers.location, method).toBe(`${TEST_ORIGIN}/auth/login`);
      expect(res.headers["cache-control"], method).toBe("no-store");
    }
  });

  test("the login redirect ignores a spoofed Host (AC-091)", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: "/models/abc",
      headers: { accept: HTML, host: "evil.example", "x-forwarded-host": "evil.example" },
    });
    expect(res.headers.location).toBe(`${TEST_ORIGIN}/auth/login`);
  });

  test("anything else gets 401 JSON", async () => {
    const cases = [
      { method: "GET", url: RESULT_PATH, headers: { accept: "application/json" } },
      { method: "GET", url: "/blobs/abc", headers: { accept: "image/avif,image/webp,*/*" } },
      { method: "GET", url: "/models/abc", headers: {} },
      { method: "POST", url: "/app/uploads", headers: { accept: HTML, origin: TEST_ORIGIN } },
      { method: "DELETE", url: "/models/abc", headers: { accept: HTML, origin: TEST_ORIGIN } },
    ] as const;
    for (const c of cases) {
      const res = await t.app.inject({ method: c.method, url: c.url, headers: c.headers });
      const label = `${c.method} ${c.url}`;
      expect(res.statusCode, label).toBe(401);
      expect(res.headers["content-type"], label).toMatch(/^application\/json/);
      expect(res.json(), label).toEqual({ error: "unauthorized" });
      expect(res.headers.location, label).toBeUndefined();
    }
  });

  test("an unknown or ended session cookie is refused and cleared", async () => {
    for (const cookie of ["A".repeat(43), "not-a-session", ""]) {
      const res = await t.app.inject({
        method: "GET",
        url: RESULT_PATH,
        cookies: { [SESSION_COOKIE]: cookie },
      });
      expect(res.statusCode, cookie).toBe(401);
      if (cookie !== "") {
        expect(setCookie(res, SESSION_COOKIE)?.attributes.get("max-age"), cookie).toBe("0");
      }
    }
    await t.sessions.end(session);
    const ended = await t.app.inject({
      method: "GET",
      url: RESULT_PATH,
      cookies: { [SESSION_COOKIE]: session },
    });
    expect(ended.statusCode).toBe(401);
  });

  test("a session cookie that is not a session id is refused without asking the store", async () => {
    const before = t.store.gets;
    for (const cookie of ["short", "x".repeat(44), `${"a".repeat(42)}=`, "a b".repeat(15)]) {
      const res = await t.app.inject({
        method: "GET",
        url: RESULT_PATH,
        cookies: { [SESSION_COOKIE]: cookie },
      });
      expect(res.statusCode, cookie).toBe(401);
    }
    expect(t.store.gets).toBe(before);
  });
});

describe("a session store that fails", () => {
  test("answers 503 with no detail, and the error never reaches the client", async () => {
    await t.close();
    const store = memorySessionStore();
    t = await authTestApp({ store });
    session = (await t.sessions.start("someone")).id;
    store.failWith = new Error("connect ECONNREFUSED 10.9.8.7:5432 password authentication failed");
    for (const accept of ["application/json", HTML]) {
      const res = await t.app.inject({
        method: "GET",
        url: RESULT_PATH,
        headers: { accept },
        cookies: { [SESSION_COOKIE]: session },
      });
      expect(res.statusCode, accept).toBe(503);
      expect(res.body, accept).not.toMatch(/ECONNREFUSED|10\.9\.8\.7|5432|password/);
    }
  });
});

describe("the Origin check on state-changing session requests: /app/api", () => {
  const url = "/app/api/models/abc/tags/x";

  test("a cross-origin POST to /app/api is 403", async () => {
    const res = await t.app.inject({
      method: "POST",
      url,
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      cookies: { [SESSION_COOKIE]: session },
      payload: "{}",
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "forbidden" });
  });

  test("PUT, PATCH and DELETE from another origin, or with no Origin, are 403 too", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      for (const origin of [
        "https://evil.example",
        "http://platehouse.test",
        "https://platehouse.test:8443",
        "https://sub.platehouse.test",
        "null",
        undefined,
      ]) {
        const res = await t.app.inject({
          method,
          url,
          headers: origin === undefined ? {} : { origin },
          cookies: { [SESSION_COOKIE]: session },
        });
        expect(res.statusCode, `${method} from ${origin ?? "no Origin"}`).toBe(403);
      }
    }
  });

  test("the same origin gets past the check", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const res = await t.app.inject({
        method,
        url,
        headers: { origin: TEST_ORIGIN },
        cookies: { [SESSION_COOKIE]: session },
      });
      // No /app/api route exists yet (Task 19), so past the gate is a 404.
      expect(res.statusCode, method).toBe(404);
    }
  });

  test("a read from another origin is not refused by the Origin check", async () => {
    const res = await t.app.inject({
      method: "GET",
      url,
      headers: { origin: "https://evil.example" },
      cookies: { [SESSION_COOKIE]: session },
    });
    expect(res.statusCode).toBe(404);
  });

  test("a cross-origin POST is refused before any session lookup", async () => {
    const before = t.store.gets;
    const res = await t.app.inject({
      method: "POST",
      url,
      headers: { origin: "https://evil.example" },
    });
    expect(res.statusCode).toBe(403);
    expect(t.store.gets).toBe(before);
  });
});

/** Origins that are not PUBLIC_ORIGIN, and no Origin at all. */
const FOREIGN_ORIGINS = ["https://evil.example", "https://sub.platehouse.test", "null", undefined];

function originHeader(origin: string | undefined): Record<string, string> {
  return origin === undefined ? {} : { origin };
}

describe("the Origin check on state-changing session requests: the tus routes at /app/uploads", () => {
  const creation = {
    "tus-resumable": "1.0.0",
    "upload-length": "11",
    "upload-metadata": `filename ${Buffer.from("cube.stl").toString("base64")}`,
  };
  const patchHeaders = {
    "tus-resumable": "1.0.0",
    "upload-offset": "0",
    "content-type": "application/offset+octet-stream",
  };

  async function uploadFiles(): Promise<string[]> {
    return readdir(uploadsDir(t.dir)).catch(() => []);
  }

  /** A same-origin creation with the session; returns the upload's path. */
  async function createUpload(): Promise<string> {
    const res = await t.app.inject({
      method: "POST",
      url: UPLOAD_PREFIXES.app,
      headers: { ...creation, origin: TEST_ORIGIN },
      cookies: { [SESSION_COOKIE]: session },
    });
    expect(res.statusCode).toBe(201);
    return String(res.headers.location);
  }

  async function offsetOf(path: string): Promise<string | undefined> {
    const head = await t.app.inject({
      method: "HEAD",
      url: path,
      headers: { "tus-resumable": "1.0.0" },
      cookies: { [SESSION_COOKIE]: session },
    });
    expect(head.statusCode).toBe(200);
    const offset = head.headers["upload-offset"];
    return offset === undefined ? undefined : String(offset);
  }

  test("a cross-origin or Origin-less POST with a valid session is 403 and stores nothing", async () => {
    for (const origin of FOREIGN_ORIGINS) {
      const res = await t.app.inject({
        method: "POST",
        url: UPLOAD_PREFIXES.app,
        headers: { ...creation, ...originHeader(origin) },
        cookies: { [SESSION_COOKIE]: session },
      });
      const label = `POST from ${origin ?? "no Origin"}`;
      expect(res.statusCode, label).toBe(403);
      expect(res.json(), label).toEqual({ error: "forbidden" });
    }
    expect(await uploadFiles()).toEqual([]);
  });

  test("a cross-origin or Origin-less PATCH with a valid session is 403 and writes nothing", async () => {
    const path = await createUpload();
    for (const origin of FOREIGN_ORIGINS) {
      const res = await t.app.inject({
        method: "PATCH",
        url: path,
        headers: { ...patchHeaders, ...originHeader(origin) },
        cookies: { [SESSION_COOKIE]: session },
        payload: Buffer.from("hello world"),
      });
      expect(res.statusCode, `PATCH from ${origin ?? "no Origin"}`).toBe(403);
    }
    expect(await offsetOf(path)).toBe("0");
    const id = path.slice(path.lastIndexOf("/") + 1);
    expect((await stat(join(uploadsDir(t.dir), id))).size).toBe(0);
  });

  test("a cross-origin or Origin-less DELETE with a valid session is 403 and the upload stays", async () => {
    const path = await createUpload();
    const before = await uploadFiles();
    for (const origin of FOREIGN_ORIGINS) {
      const res = await t.app.inject({
        method: "DELETE",
        url: path,
        headers: { "tus-resumable": "1.0.0", ...originHeader(origin) },
        cookies: { [SESSION_COOKIE]: session },
      });
      expect(res.statusCode, `DELETE from ${origin ?? "no Origin"}`).toBe(403);
    }
    expect(await uploadFiles()).toEqual(before);
    expect(await offsetOf(path)).toBe("0");
  });

  test("the same origin with a session still creates, writes and gets past the check on DELETE", async () => {
    const path = await createUpload();
    const patch = await t.app.inject({
      method: "PATCH",
      url: path,
      headers: { ...patchHeaders, origin: TEST_ORIGIN },
      cookies: { [SESSION_COOKIE]: session },
      payload: Buffer.from("hello"),
    });
    expect(patch.statusCode).toBe(204);
    expect(await offsetOf(path)).toBe("5");
    // There is no DELETE route on an upload (uploads/tus.ts: an abandoned
    // upload is swept), so past the gate is a 404, not a 403.
    const del = await t.app.inject({
      method: "DELETE",
      url: path,
      headers: { "tus-resumable": "1.0.0", origin: TEST_ORIGIN },
      cookies: { [SESSION_COOKIE]: session },
    });
    expect(del.statusCode).toBe(404);
  });
});

describe("the Origin check on state-changing session requests: a route added later", () => {
  // A route registered here, in the test only, at a path the route-class
  // table does not list: it is session by default, and so is its Origin check.
  const FUTURE = "/future/settings";
  let ran: number;

  beforeEach(async () => {
    await t.close();
    ran = 0;
    t = await authTestApp({
      beforeReady: (app) => {
        app.route({
          method: ["GET", "POST", "PUT", "PATCH", "DELETE"],
          url: FUTURE,
          handler: async () => {
            ran += 1;
            return { ok: true };
          },
        });
      },
    });
    session = (await t.sessions.start("someone")).id;
  });

  test("is a session route by default", () => {
    expect(routeClass(FUTURE)).toBe("session");
  });

  test("POST, PUT, PATCH and DELETE from another origin or none are 403 and never reach it", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      for (const origin of FOREIGN_ORIGINS) {
        const res = await t.app.inject({
          method,
          url: FUTURE,
          headers: originHeader(origin),
          cookies: { [SESSION_COOKIE]: session },
        });
        expect(res.statusCode, `${method} from ${origin ?? "no Origin"}`).toBe(403);
      }
    }
    expect(ran).toBe(0);
  });

  test("the same origin with a session reaches it, and a read needs no Origin", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const res = await t.app.inject({
        method,
        url: FUTURE,
        headers: { origin: TEST_ORIGIN },
        cookies: { [SESSION_COOKIE]: session },
      });
      expect(res.statusCode, method).toBe(200);
    }
    const read = await t.app.inject({
      method: "GET",
      url: FUTURE,
      cookies: { [SESSION_COOKIE]: session },
    });
    expect(read.statusCode).toBe(200);
    expect(ran).toBe(5);
  });
});
