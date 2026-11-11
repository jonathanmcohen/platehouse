// Build plan Task 30: the Fastify app buildApp(deps) returns. GET /healthz is
// 200 only when the database answers and pg-boss is started, else 503 with
// no detail in the body. The tus upload handler is mounted at /app/uploads
// and /api/v1/uploads behind an auth hook that refuses every request with 401
// until Tasks 15 and 16 replace it, so no upload route is ever open. The HTTP
// request timeout lets a 512 MiB single PATCH through on a slow link.
//
// These tests need no container: the health checks are stubs and the upload
// store is a real one in a temp folder.
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
import {
  createUploads,
  DRAIN_MS,
  MAX_UPLOAD_BYTES,
  type UploadQueue,
  uploadsDir,
} from "../../../src/uploads/tus.js";
import { send } from "../../uploads/support/http.js";

let dir: string;
let app: FastifyInstance | undefined;
let queue: UploadQueue & { enqueue: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "platehouse-app-"));
  queue = {
    enqueue: vi.fn(async () => {}),
    result: vi.fn(async () => undefined),
  };
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  await rm(dir, { recursive: true, force: true });
});

async function appWith(health: Partial<AppHealth> = {}): Promise<FastifyInstance> {
  app = await buildApp({
    health: {
      database: health.database ?? (async () => 1),
      queuesRunning: health.queuesRunning ?? (() => true),
    },
    uploads: createUploads({ tmpDir: dir, queue, log: () => {} }),
  });
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

describe("the upload routes, with no auth hook installed", () => {
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
});

interface StalledAnswer {
  /** The status line and headers of the answer, as received. */
  head: string;
  /** Whether the server closed the connection within closeWithinMs. */
  closed: boolean;
}

/**
 * A request to the listening app over a raw socket that declares a body (its
 * Content-Length, or chunked when it has none), sends only its first bytes
 * and then stalls, as a client that never finishes would. Once the answer
 * has arrived, the app is closed: that finishes only when the server has
 * closed the connection, which is what `closed` reports, within
 * closeWithinMs. The client never ends its side, so it cannot see the close
 * itself.
 */
async function stalledRequest(
  base: string,
  method: string,
  path: string,
  opts: { headers: Record<string, string>; firstBytes: Buffer; closeWithinMs: number },
): Promise<StalledAnswer> {
  const url = new URL(path, base);
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
  await Promise.race([answered.promise, sleep(opts.closeWithinMs)]);
  const closing = app?.close();
  app = undefined;
  const closed = await Promise.race([
    closing?.then(() => true),
    sleep(opts.closeWithinMs).then(() => false),
  ]);
  socket.destroy();
  await closing;
  const split = received.indexOf("\r\n\r\n");
  return { head: split === -1 ? received : received.slice(0, split), closed: closed === true };
}

describe("a request answered before its body is read", () => {
  // Node keeps reading an unread body after the answer for as long as the
  // request timeout allows, about 72 minutes here. A refused upload or a 404
  // must not hold its connection that long: the answer goes out with
  // Connection: close and the connection closes within DRAIN_MS.
  const someId = "0198f0c4-6a1b-7c2d-8e3f-4a5b6c7d8e9f";
  const closeWithinMs = DRAIN_MS + 2_000;
  let base: string;

  beforeEach(async () => {
    const a = await appWith();
    await a.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${(a.server.address() as AddressInfo).port}`;
  });

  test("a refused chunked creation is answered 401 and its connection closes", async () => {
    const res = await stalledRequest(base, "POST", UPLOAD_PREFIXES.app, {
      headers: { "tus-resumable": "1.0.0", "upload-length": "100000" },
      firstBytes: Buffer.alloc(1000, 1),
      closeWithinMs,
    });
    expect(res.head).toMatch(/^HTTP\/1\.1 401 /);
    expect(res.head.toLowerCase()).toContain("\r\nconnection: close");
    expect(res.closed).toBe(true);
    expect(await uploadFiles()).toEqual([]);
  });

  test("a refused PATCH whose body never finishes is answered 401 and its connection closes", async () => {
    const res = await stalledRequest(base, "PATCH", `${UPLOAD_PREFIXES.api}/${someId}`, {
      headers: {
        "tus-resumable": "1.0.0",
        "upload-offset": "0",
        "content-type": "application/offset+octet-stream",
        "content-length": "100000",
      },
      firstBytes: Buffer.alloc(1000, 1),
      closeWithinMs,
    });
    expect(res.head).toMatch(/^HTTP\/1\.1 401 /);
    expect(res.head.toLowerCase()).toContain("\r\nconnection: close");
    expect(res.closed).toBe(true);
    expect(await uploadFiles()).toEqual([]);
  });

  test("a 404 whose body never finishes is answered and its connection closes", async () => {
    const res = await stalledRequest(base, "POST", "/no-such-route", {
      headers: { "content-type": "application/octet-stream" },
      firstBytes: Buffer.alloc(1000, 1),
      closeWithinMs,
    });
    expect(res.head).toMatch(/^HTTP\/1\.1 404 /);
    expect(res.head.toLowerCase()).toContain("\r\nconnection: close");
    expect(res.closed).toBe(true);
  });

  test("a 404 keeps Fastify's own answer", async () => {
    const res = await send(base, "POST", "/no-such-route", {
      headers: { "content-type": "application/octet-stream" },
      body: Buffer.alloc(10, 1),
    });
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toEqual({
      message: "Route POST:/no-such-route not found",
      error: "Not Found",
      statusCode: 404,
    });
  });

  test("a refused or unknown request with no body keeps its connection", async () => {
    const refused = await send(base, "GET", `${UPLOAD_PREFIXES.app}/${someId}/result`);
    const missing = await send(base, "GET", "/no-such-route");
    expect([refused.status, missing.status]).toEqual([401, 404]);
    expect(refused.headers.connection).not.toBe("close");
    expect(missing.headers.connection).not.toBe("close");
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
