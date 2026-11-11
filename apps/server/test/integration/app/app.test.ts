// Build plan Task 30: the Fastify app buildApp(deps) returns. GET /healthz is
// 200 only when the database answers and pg-boss is started, else 503 with
// no detail in the body. The tus upload handler is mounted at /app/uploads
// and /api/v1/uploads behind an auth hook that refuses every request with 401
// until Tasks 15 and 16 replace it, so no upload route is ever open. The HTTP
// request timeout lets a 512 MiB single PATCH through on a slow link.
//
// These tests need no container: the health checks are stubs and the upload
// store is a real one in a temp folder.
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  MAX_UPLOAD_BYTES,
  type UploadQueue,
  uploadsDir,
} from "../../../src/uploads/tus.js";

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

describe("the request timeout", () => {
  test("lets a 512 MiB single PATCH through at 1 Mbit/s", async () => {
    const a = await appWith();
    const needed = (MAX_UPLOAD_BYTES / 125_000) * 1000;
    expect(REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(needed);
    expect(a.server.requestTimeout).toBe(REQUEST_TIMEOUT_MS);
  });
});
