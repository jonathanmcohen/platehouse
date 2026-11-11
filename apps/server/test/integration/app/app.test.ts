// Build plan Task 30: the Fastify app buildApp(deps) returns. GET /healthz is
// 200 only when the database answers and pg-boss is started, else 503 with
// no detail in the body. The tus upload handler is mounted at /app/uploads
// behind the session check (Task 15) and at /api/v1/uploads behind an auth
// hook that refuses every request with 401 until Task 16 replaces it, so no
// upload route is open. The HTTP request timeout lets a 512 MiB single PATCH
// through on a slow link.
//
// Every request answered before its body is read releases that body: the
// answer carries Connection: close and the connection closes within DRAIN_MS
// (issues #107 and #108): a refused request of any class, a 404 whatever its
// content type, /healthz with a trickled body, a cross-origin refusal and
// POST /auth/logout.
//
// These tests need no container: the health checks are stubs, the upload
// store is a real one in a temp folder, the issuer is the local mock and
// sessions are in memory.
import { once } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type AppHealth,
  buildApp,
  HEALTH_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  UPLOAD_PREFIXES,
} from "../../../src/app.js";
import { SESSION_COOKIE } from "../../../src/auth/sessions.js";
import {
  createUploads,
  DRAIN_MS,
  MAX_UPLOAD_BYTES,
  type UploadQueue,
  uploadsDir,
} from "../../../src/uploads/tus.js";
import { send } from "../../uploads/support/http.js";
import { TEST_ORIGIN, type TestAuth, testAuth } from "../support/oidc-issuer.js";

let dir: string;
let app: FastifyInstance | undefined;
let auth: TestAuth;
let queue: UploadQueue & { enqueue: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "platehouse-app-"));
  queue = {
    enqueue: vi.fn(async () => {}),
    result: vi.fn(async () => undefined),
  };
  auth = await testAuth();
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  await auth.issuer.stop();
  await rm(dir, { recursive: true, force: true });
});

async function newApp(health: Partial<AppHealth> = {}): Promise<FastifyInstance> {
  return buildApp({
    health: {
      database: health.database ?? (async () => 1),
      queuesRunning: health.queuesRunning ?? (() => true),
    },
    uploads: createUploads({ tmpDir: dir, queue, log: () => {} }),
    auth: auth.auth,
  });
}

async function appWith(health: Partial<AppHealth> = {}): Promise<FastifyInstance> {
  app = await newApp(health);
  return app;
}

async function uploadFiles(): Promise<string[]> {
  try {
    return await readdir(uploadsDir(dir));
  } catch {
    return [];
  }
}

describe("GET /healthz", () => {
  test("is 200 when the database answers and the queues are running", async () => {
    const res = await (await appWith()).inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
  });

  test("is 503 with no detail when the database fails", async () => {
    const res = await (
      await appWith({
        database: async () => {
          throw new Error("connect ECONNREFUSED 10.9.8.7:5432 password authentication failed");
        },
      })
    ).inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toMatch(/ECONNREFUSED|10\.9\.8\.7|5432|password/);
  });

  test("is 503 when the database does not answer in time", async () => {
    const started = Date.now();
    const res = await (await appWith({ database: () => new Promise(() => {}) })).inject({
      method: "GET",
      url: "/healthz",
    });
    expect(res.statusCode).toBe(503);
    expect(Date.now() - started).toBeLessThan(HEALTH_TIMEOUT_MS + 2_000);
  });

  test("is 503 when pg-boss is not started", async () => {
    const res = await (await appWith({ queuesRunning: () => false })).inject({
      method: "GET",
      url: "/healthz",
    });
    expect(res.statusCode).toBe(503);
  });
});

describe("the upload routes, with no credentials", () => {
  const creation = {
    "tus-resumable": "1.0.0",
    "upload-length": "11",
    "upload-metadata": `filename ${Buffer.from("cube.stl").toString("base64")}`,
  };
  const someId = "0198f0c4-6a1b-7c2d-8e3f-4a5b6c7d8e9f";

  for (const prefix of [UPLOAD_PREFIXES.app, UPLOAD_PREFIXES.api]) {
    test(`${prefix} refuses a creation with no credentials with 401 and stores nothing`, async () => {
      const res = await (await appWith()).inject({
        method: "POST",
        url: prefix,
        headers: creation,
      });
      expect(res.statusCode).toBe(401);
      expect(await uploadFiles()).toEqual([]);
      expect(queue.enqueue).not.toHaveBeenCalled();
    });

    test(`${prefix} refuses HEAD, PATCH and the result route with 401`, async () => {
      const a = await appWith();
      const head = await a.inject({
        method: "HEAD",
        url: `${prefix}/${someId}`,
        headers: creation,
      });
      const patch = await a.inject({
        method: "PATCH",
        url: `${prefix}/${someId}`,
        headers: {
          "tus-resumable": "1.0.0",
          "upload-offset": "0",
          "content-type": "application/offset+octet-stream",
        },
        payload: Buffer.from("hello world"),
      });
      const result = await a.inject({ method: "GET", url: `${prefix}/${someId}/result` });
      expect([head.statusCode, patch.statusCode, result.statusCode]).toEqual([401, 401, 401]);
      expect(await uploadFiles()).toEqual([]);
    });

    test(`${prefix} refuses a request with made-up credentials too`, async () => {
      const res = await (await appWith()).inject({
        method: "POST",
        url: prefix,
        headers: {
          ...creation,
          authorization: "Bearer not-a-real-token",
          cookie: "__Host-ph_session=not-a-real-session",
        },
      });
      expect(res.statusCode).toBe(401);
      expect(await uploadFiles()).toEqual([]);
    });
  }

  test("with a session, /app/uploads takes a creation and /api/v1/uploads still refuses it", async () => {
    const a = await appWith();
    const { id } = await auth.sessions.start("someone");
    const ui = await a.inject({
      method: "POST",
      url: UPLOAD_PREFIXES.app,
      headers: creation,
      cookies: { [SESSION_COOKIE]: id },
    });
    expect(ui.statusCode).toBe(201);
    expect(String(ui.headers.location)).toMatch(/^\/app\/uploads\/[0-9a-f-]{36}$/);
    const before = await uploadFiles();
    const api = await a.inject({
      method: "POST",
      url: UPLOAD_PREFIXES.api,
      headers: creation,
      cookies: { [SESSION_COOKIE]: id },
    });
    expect(api.statusCode).toBe(401);
    expect(await uploadFiles()).toEqual(before);
  });
});

interface StalledAnswer {
  /** The status line and headers of the answer, as received. */
  head: string;
  /** How long the answer took to arrive, in ms (closeWithinMs when it never did). */
  answeredInMs: number;
  /** Whether the server closed the connection within closeWithinMs. */
  closed: boolean;
}

/**
 * A request to target, listening on a loopback port, over a raw socket that
 * declares a body (its Content-Length, or chunked when it has none), sends
 * only its first bytes and then stalls, as a client that never finishes
 * would. Once the answer has arrived, target is closed: that finishes only
 * when the server has closed the connection, which is what `closed` reports,
 * within closeWithinMs. The client never ends its side, so it cannot see the
 * close itself.
 */
async function stalledRequest(
  target: FastifyInstance,
  method: string,
  path: string,
  opts: { headers: Record<string, string>; firstBytes: Buffer; closeWithinMs: number },
): Promise<StalledAnswer> {
  await target.listen({ host: "127.0.0.1", port: 0 });
  const url = new URL(path, `http://127.0.0.1:${(target.server.address() as AddressInfo).port}`);
  const socket = net.connect({ host: url.hostname, port: Number(url.port), allowHalfOpen: true });
  let received = "";
  const answered = Promise.withResolvers<void>();
  socket.on("data", (chunk: Buffer) => {
    received += chunk.toString("latin1");
    if (received.includes("\r\n\r\n")) answered.resolve();
  });
  socket.on("error", () => {});
  socket.once("close", () => answered.resolve());
  await once(socket, "connect");
  const chunked = opts.headers["content-length"] === undefined;
  socket.write(
    [
      `${method} ${url.pathname} HTTP/1.1`,
      `Host: ${url.host}`,
      ...Object.entries(opts.headers).map(([name, value]) => `${name}: ${value}`),
      ...(chunked ? ["Transfer-Encoding: chunked"] : []),
      "",
      "",
    ].join("\r\n"),
  );
  socket.write(
    chunked
      ? Buffer.concat([
          Buffer.from(`${opts.firstBytes.length.toString(16)}\r\n`),
          opts.firstBytes,
          Buffer.from("\r\n"),
        ])
      : opts.firstBytes,
  );
  const sent = Date.now();
  await Promise.race([answered.promise, sleep(opts.closeWithinMs)]);
  const answeredInMs = Date.now() - sent;
  const closing = target.close();
  const closed = await Promise.race([
    closing.then(() => true),
    sleep(opts.closeWithinMs).then(() => false),
  ]);
  socket.destroy();
  await closing;
  const split = received.indexOf("\r\n\r\n");
  return {
    head: split === -1 ? received : received.slice(0, split),
    answeredInMs,
    closed,
  };
}

describe("a request answered before its body is read", () => {
  // Node keeps reading an unread body after the answer for as long as the
  // request timeout allows, about 72 minutes here. No answer the app gives
  // without reading the body may hold its connection that long: the answer
  // goes out at once with Connection: close and the connection closes within
  // DRAIN_MS. Issue #107: a 404 with a JSON or text/plain body, which the
  // root app's content-type parsers used to read first. Issue #108: GET or
  // HEAD /healthz with a trickled chunked body. And every kind of refusal:
  // the session check, the API mount's 401, the Origin check.
  const someId = "0198f0c4-6a1b-7c2d-8e3f-4a5b6c7d8e9f";
  const closeWithinMs = DRAIN_MS + 2_000;
  const json = { "content-type": "application/json" };

  interface StalledCase {
    label: string;
    method: string;
    path: string;
    headers: Record<string, string>;
    /** Send a live session cookie. */
    session?: boolean;
    status: number;
  }

  const cases: StalledCase[] = [
    {
      label: "a chunked creation on /app/uploads with no session",
      method: "POST",
      path: UPLOAD_PREFIXES.app,
      headers: { "tus-resumable": "1.0.0", "upload-length": "100000" },
      status: 401,
    },
    {
      label: "a PATCH on /api/v1/uploads whose Content-Length never arrives",
      method: "PATCH",
      path: `${UPLOAD_PREFIXES.api}/${someId}`,
      headers: {
        "tus-resumable": "1.0.0",
        "upload-offset": "0",
        "content-type": "application/offset+octet-stream",
        "content-length": "100000",
      },
      status: 401,
    },
    {
      label: "a JSON POST to a session route with no session",
      method: "POST",
      path: "/app/api/models",
      headers: { ...json, origin: TEST_ORIGIN },
      status: 401,
    },
    {
      label: "a cross-origin JSON POST to /app/api with a session",
      method: "POST",
      path: "/app/api/models",
      headers: { ...json, origin: "https://evil.example" },
      session: true,
      status: 403,
    },
    ...["POST", "PUT", "PATCH", "DELETE", "OPTIONS"].map(
      (method): StalledCase => ({
        label: `a ${method} 404 with a JSON body (#107)`,
        method,
        path: "/auth/no-such-route",
        headers: json,
        status: 404,
      }),
    ),
    {
      label: "a 404 with a text/plain body (#107)",
      method: "POST",
      path: "/auth/no-such-route",
      headers: { "content-type": "text/plain" },
      status: 404,
    },
    {
      label: "a 404 with an octet-stream body",
      method: "POST",
      path: "/auth/no-such-route",
      headers: { "content-type": "application/octet-stream" },
      status: 404,
    },
    {
      label: "a 404 with no content type",
      method: "POST",
      path: "/assets/no-such-file",
      headers: {},
      status: 404,
    },
    {
      label: "a signed-in 404 with a JSON body (#107)",
      method: "POST",
      path: "/no-such-route",
      headers: json,
      session: true,
      status: 404,
    },
    {
      label: "GET /healthz with a trickled chunked body (#108)",
      method: "GET",
      path: "/healthz",
      headers: {},
      status: 200,
    },
    {
      label: "HEAD /healthz with a trickled chunked body (#108)",
      method: "HEAD",
      path: "/healthz",
      headers: {},
      status: 200,
    },
    {
      label: "POST /auth/logout with a trickled body",
      method: "POST",
      path: "/auth/logout",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      status: 204,
    },
    {
      label: "GET /auth/callback with a trickled body",
      method: "GET",
      path: "/auth/callback",
      headers: {},
      status: 400,
    },
  ];

  test("each is answered at once with Connection: close, and its connection closes within DRAIN_MS", async () => {
    const { id } = await auth.sessions.start("someone");
    // One app each, all at once, so the drains overlap.
    const results = await Promise.all(
      cases.map(async (c) => {
        const target = await newApp();
        const headers = c.session ? { ...c.headers, cookie: `${SESSION_COOKIE}=${id}` } : c.headers;
        const res = await stalledRequest(target, c.method, c.path, {
          headers,
          firstBytes: Buffer.alloc(1000, 0x20),
          closeWithinMs,
        });
        return { c, res };
      }),
    );
    for (const { c, res } of results) {
      expect(res.head, c.label).toMatch(new RegExp(`^HTTP/1\\.1 ${c.status} `));
      expect(res.answeredInMs, c.label).toBeLessThan(2_000);
      expect(res.head.toLowerCase(), c.label).toContain("\r\nconnection: close");
      expect(res.closed, c.label).toBe(true);
    }
    expect(await uploadFiles()).toEqual([]);
  });

  test("a 404 keeps Fastify's own answer", async () => {
    const a = await appWith();
    await a.listen({ host: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${(a.server.address() as AddressInfo).port}`;
    const res = await send(base, "POST", "/auth/no-such-route", {
      headers: { "content-type": "application/octet-stream" },
      body: Buffer.alloc(10, 1),
    });
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toEqual({
      message: "Route POST:/auth/no-such-route not found",
      error: "Not Found",
      statusCode: 404,
    });
  });

  test("a refused, unknown or health request with no body keeps its connection", async () => {
    const a = await appWith();
    await a.listen({ host: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${(a.server.address() as AddressInfo).port}`;
    const refused = await send(base, "GET", `${UPLOAD_PREFIXES.app}/${someId}/result`);
    const missing = await send(base, "GET", "/auth/no-such-route");
    const health = await send(base, "GET", "/healthz");
    expect([refused.status, missing.status, health.status]).toEqual([401, 404, 200]);
    for (const res of [refused, missing, health]) expect(res.headers.connection).not.toBe("close");
  });
});

describe("the request timeout", () => {
  test("lets a 512 MiB single PATCH through at 1 Mbit/s", async () => {
    const a = await appWith();
    const needed = (MAX_UPLOAD_BYTES / 125_000) * 1000;
    expect(REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(needed);
    expect(a.server.requestTimeout).toBe(REQUEST_TIMEOUT_MS);
  });
});
