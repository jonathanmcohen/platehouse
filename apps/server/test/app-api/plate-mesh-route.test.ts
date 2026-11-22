// Issue #358: GET /app/api/plates/:id/mesh, the route the model page asks
// for a plate's 3D view. The parts that need no database: what each answer
// of the plate meshes service becomes over HTTP. The service itself, with
// Postgres and the S3 test server, is in
// test/integration/plate-mesh/plate-mesh.test.ts.
import { ReadUnavailable } from "@platehouse/threemf";
import Fastify from "fastify";
import { describe, expect, test } from "vitest";
import {
  type AppPlateMeshes,
  emptyPlateMeshes,
  PLATE_MESH_API_PATHS,
  PLATE_MESH_MESSAGES,
  PLATE_MESH_UNAVAILABLE_MESSAGE,
  registerPlateMeshApi,
} from "../../src/app-api/plate-mesh.js";
import { BlobNotFound, StoreError, StoreUnavailable } from "../../src/storage/s3.js";

const PLATE_ID = "01900000-0000-7000-8000-0000000000d1";
const BLOB_ID = "01900000-0000-7000-8000-0000000000e1";

async function app(meshes: AppPlateMeshes = emptyPlateMeshes) {
  const lines: string[] = [];
  const server = Fastify({
    logger: {
      level: "info",
      stream: {
        write(line: string) {
          lines.push(line);
        },
      },
    },
  });
  await registerPlateMeshApi(server, meshes);
  await server.ready();
  return { server, lines };
}

const errorLines = (lines: readonly string[]) =>
  lines.filter((line) => (JSON.parse(line) as { level: number }).level >= 50);

const answering = (get: AppPlateMeshes["get"]): AppPlateMeshes => ({ get });

describe("GET /app/api/plates/:id/mesh", () => {
  test("names its one path", () => {
    expect(PLATE_MESH_API_PATHS).toEqual(["/app/api/plates/:id/mesh"]);
  });

  test("answers the mesh's /blobs/ address, never cached", async () => {
    const asked: string[] = [];
    const { server } = await app(
      answering(async (id) => {
        asked.push(id);
        return { status: "ok", blobId: BLOB_ID };
      }),
    );
    const res = await server.inject({ url: `/app/api/plates/${PLATE_ID}/mesh` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ url: `/blobs/${BLOB_ID}` });
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(asked).toEqual([PLATE_ID]);
  });

  test.each(["no_plate", "no_objects", "no_mesh", "too_large", "damaged"] as const)(
    "says why a plate has no 3D view (%s) with 422, its code and a sentence",
    async (problem) => {
      const { server, lines } = await app(answering(async () => ({ status: "no_mesh", problem })));
      const res = await server.inject({ url: `/app/api/plates/${PLATE_ID}/mesh` });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toEqual({
        error: "no_mesh",
        code: problem,
        message: PLATE_MESH_MESSAGES[problem],
      });
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(errorLines(lines)).toEqual([]);
    },
  );

  test("is 404 for a plate that is unknown or whose model is in the trash", async () => {
    const { server } = await app(answering(async () => ({ status: "not_found" })));
    const res = await server.inject({ url: `/app/api/plates/${PLATE_ID}/mesh` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
  });

  test("is 404 for a malformed id, without asking the service", async () => {
    let asked = false;
    const { server } = await app(
      answering(async () => {
        asked = true;
        return { status: "not_found" };
      }),
    );
    const res = await server.inject({ url: "/app/api/plates/not-a-uuid/mesh" });
    expect(res.statusCode).toBe(404);
    expect(asked).toBe(false);
  });

  test.each([
    ["a store that cannot be reached", () => new StoreUnavailable("GetObject", "ECONNREFUSED")],
    ["a store that refuses", () => new StoreError("GetObject", "AccessDenied", 403)],
    ["a source object that is gone", () => new BlobNotFound("GetObject")],
    [
      "a temp folder that cannot be written",
      () =>
        new ReadUnavailable(
          Object.assign(new Error("no space"), { code: "ENOSPC", syscall: "write" }),
        ),
    ],
  ])("is 503, saying to try again later, for %s", async (_why, make) => {
    const { server } = await app(
      answering(async () => {
        throw make();
      }),
    );
    const res = await server.inject({ url: `/app/api/plates/${PLATE_ID}/mesh` });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "unavailable", message: PLATE_MESH_UNAVAILABLE_MESSAGE });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  test("any other failure is 500, logged, with no detail in the answer", async () => {
    const { server, lines } = await app(
      answering(async () => {
        throw new Error("connect ECONNREFUSED db.internal:5432");
      }),
    );
    const res = await server.inject({ url: `/app/api/plates/${PLATE_ID}/mesh` });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal" });
    expect(res.body).not.toContain("db.internal");
    expect(errorLines(lines)).toHaveLength(1);
  });

  test("with no service given, every plate is unknown", async () => {
    const { server } = await app();
    const res = await server.inject({ url: `/app/api/plates/${PLATE_ID}/mesh` });
    expect(res.statusCode).toBe(404);
  });
});
