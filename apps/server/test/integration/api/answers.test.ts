// Build plan Task 16: two properties of the v1 answers that the DB-backed
// suite (api.test.ts) does not isolate.
//
// - A HEAD on a file's content answers the GET's headers and opens no store
//   stream. Fastify answers HEAD with the GET handler, and a stream given to
//   reply.send on a HEAD is drained to its end, so before this a HEAD read the
//   whole object from the bucket.
// - Every bearer-class answer carries Cache-Control: no-store: the v1 routes,
//   the tus mount at /api/v1/uploads (create, PATCH, HEAD, the result route
//   and the upload hook's 404) and the 404 a valid token gets on an unknown
//   /api/v1 path. A route that sets its own Cache-Control keeps it.
//
// No container: tokens are in memory, the library is a stub and the upload
// queue records nothing. Every byte and name is synthetic.
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTokens } from "../../../src/api/tokens.js";
import type { ApiLibrary, ApiModel } from "../../../src/api/v1.js";
import { meta, OCTET, TUS } from "../../uploads/support/http.js";
import { type AuthTestApp, authTestApp, memoryTokenStore } from "../support/oidc-issuer.js";

const FILE_ID = "0198f0c4-6a1b-7c2d-8e3f-4a5b6c7d8e9f";
const BYTES = Buffer.from("solid synthetic\nendsolid synthetic\n");

const MODEL: ApiModel = {
  id: "0198f0c4-6a1b-7c2d-8e3f-4a5b6c7d8e90",
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

/** How many store streams the stub library opened. */
let streamsOpened = 0;

const HEAD = { name: "bracket.stl", contentType: "model/stl", size: BYTES.length };

/** One file, FILE_ID; every open of its bytes is counted. */
const library: ApiLibrary = {
  listModels: async () => ({ models: [], nextCursor: null }),
  createModel: async () => ({ model: MODEL }),
  getModel: async () => undefined,
  getFile: async () => undefined,
  fileHead: async (id) => (id === FILE_ID ? HEAD : undefined),
  openFile: async (id) => {
    if (id !== FILE_ID) return undefined;
    streamsOpened += 1;
    return { ...HEAD, stream: Readable.from([BYTES]) };
  },
  modelIsLive: async () => false,
  addTag: async () => false,
  removeTag: async () => false,
  addToCollection: async () => false,
  removeFromCollection: async () => false,
};

let t: AuthTestApp;
let token: string;

beforeAll(async () => {
  const tokens = createTokens({ store: memoryTokenStore() });
  t = await authTestApp({ api: { tokens, library } });
  token = (await tokens.createToken("answers test")).token;
});

afterAll(async () => {
  await t?.close();
});

function bearer(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...extra };
}

describe("HEAD on a file's content", () => {
  test("answers the GET's headers with no body and opens no store stream", async () => {
    const before = streamsOpened;
    const res = await t.app.inject({
      method: "HEAD",
      url: `/api/v1/files/${FILE_ID}/content`,
      headers: bearer(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-length"]).toBe(String(BYTES.length));
    expect(res.headers["content-type"]).toBe("model/stl");
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="bracket\.stl"/);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.rawPayload.length).toBe(0);
    expect(streamsOpened).toBe(before);
  });

  test("is 404 for a file that is not there, and opens nothing", async () => {
    const before = streamsOpened;
    const res = await t.app.inject({
      method: "HEAD",
      url: "/api/v1/files/0198f0c4-6a1b-7c2d-8e3f-000000000000/content",
      headers: bearer(),
    });
    expect(res.statusCode).toBe(404);
    expect(streamsOpened).toBe(before);
  });

  test("the GET still sends the bytes", async () => {
    const before = streamsOpened;
    const res = await t.app.inject({
      method: "GET",
      url: `/api/v1/files/${FILE_ID}/content`,
      headers: bearer(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(BYTES)).toBe(true);
    expect(streamsOpened).toBe(before + 1);
  });
});

describe("Cache-Control on bearer-class answers", () => {
  test("the tus mount at /api/v1/uploads answers no-store: create, PATCH, HEAD and result", async () => {
    const created = await t.app.inject({
      method: "POST",
      url: "/api/v1/uploads",
      headers: bearer({
        ...TUS,
        "upload-length": String(BYTES.length * 2),
        "upload-metadata": meta({ filename: "part.stl" }),
      }),
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.headers["cache-control"], "POST").toBe("no-store");
    const location = String(created.headers.location);

    const patch = await t.app.inject({
      method: "PATCH",
      url: location,
      headers: bearer({ ...TUS, "upload-offset": "0", "content-type": OCTET }),
      payload: BYTES,
    });
    expect(patch.statusCode, patch.body).toBe(204);
    expect(patch.headers["cache-control"], "PATCH").toBe("no-store");

    const head = await t.app.inject({ method: "HEAD", url: location, headers: bearer(TUS) });
    expect(head.statusCode).toBe(200);
    expect(head.headers["cache-control"], "HEAD").toBe("no-store");

    const pending = await t.app.inject({
      method: "GET",
      url: `${location}/result`,
      headers: bearer(),
    });
    expect(pending.statusCode).toBe(200);
    expect(pending.json()).toEqual({ status: "pending" });
    expect(pending.headers["cache-control"], "result").toBe("no-store");

    const unknown = await t.app.inject({
      method: "GET",
      url: "/api/v1/uploads/0198f0c4-6a1b-7c2d-8e3f-000000000000/result",
      headers: bearer(),
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.headers["cache-control"], "unknown result").toBe("no-store");
  });

  test("the upload hook's 404 for a model that is not live is no-store", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/api/v1/uploads",
      headers: bearer({
        ...TUS,
        "upload-length": String(BYTES.length),
        "upload-metadata": meta({ filename: "late.stl", modelId: MODEL.id }),
      }),
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  test("the 404 a token gets on an unknown /api/v1 path is no-store", async () => {
    for (const method of ["GET", "POST", "DELETE"] as const) {
      const res = await t.app.inject({
        method,
        url: "/api/v1/no-such-route",
        headers: bearer(),
      });
      expect(res.statusCode, method).toBe(404);
      expect(res.headers["cache-control"], method).toBe("no-store");
    }
  });

  test("a v1 route that sets its own Cache-Control keeps it", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: `/api/v1/files/${FILE_ID}/content`,
      headers: bearer(),
    });
    expect(res.headers["cache-control"]).toBe("private, no-store");
  });
});
