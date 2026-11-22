// The Public API v1's answers, byte for byte, without Docker. Written before
// the route schemas gained their documentation (summaries, descriptions,
// examples and every error response), and passing on the code before that
// change, so it shows the documentation changed no answer: the response
// schemas also drive serialization, so a schema edit could otherwise change
// a body's keys, their order or their values unnoticed. Each answer is
// pinned as the exact text sent, with its status and the headers a client
// reads. The integration suite (test/integration/api) runs the same routes
// over Postgres and the S3 test server.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { registerOpenApi } from "../../src/api/openapi.js";
import {
  type ApiDeps,
  type ApiFile,
  type ApiLibrary,
  type ApiModel,
  apiUploadHook,
  registerV1,
} from "../../src/api/v1.js";
import type { ApiToken } from "../../src/db/types.js";
import { InvalidCursor } from "../../src/library/search.js";
import { BlobNotFound, StoreUnavailable } from "../../src/storage/s3.js";
import { createUploads, registerTus } from "../../src/uploads/tus.js";

// Built from parts so no source line holds a whole token-shaped string.
const GOOD = `ph_${"A".repeat(20)}${"B".repeat(23)}`;
const AUTH = { authorization: `Bearer ${GOOD}` };
const MODEL_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const FILE_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a6c";
const PLATE_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a7d";
const GONE = "0190a1b2-c3d4-7e5f-8a9b-000000000000";

const MODEL: ApiModel = {
  id: MODEL_ID,
  name: "Cable clip",
  caption: "A clip for desk cables",
  description: "Prints without supports.",
  creator: "Example Maker",
  license: "CC-BY-4.0",
  licenseNote: null,
  externalRef: "manyfold:42",
  tags: ["desk", "clips"],
  collections: ["Office"],
  createdAt: "2026-11-01T10:00:00.000Z",
  updatedAt: "2026-11-02T11:30:00.000Z",
};

const FILE: ApiFile = {
  id: FILE_ID,
  modelId: MODEL_ID,
  name: "cable-clip.3mf",
  originalName: "cable-clip.3mf",
  kind: "3mf",
  size: 5,
  sha256: "ab".repeat(32),
  parseStatus: "ok",
  derivedStatus: null,
  derivedMessage: null,
  previewStatus: null,
  previewMessage: null,
  createdAt: "2026-11-01T10:00:00.000Z",
  updatedAt: "2026-11-01T10:00:00.000Z",
  plates: [
    {
      id: PLATE_ID,
      index: 1,
      name: "Plate 1",
      objectCount: 4,
      numbers: {
        file: {
          source: "file",
          estimateId: "e1",
          printerId: "Bambu Lab P1S 0.4 nozzle",
          printerLabel: "Bambu Lab P1S 0.4 nozzle",
          printerName: "Bambu Lab P1S, 0.4 mm nozzle",
          slicer: "BambuStudio",
          slicerVersion: "02.03.00.70",
          processProfile: "0.20mm Standard @BBL X1C",
          timeSeconds: 3720,
          weightGrams: 21.5,
          filaments: [
            {
              slot: 1,
              type: "PLA",
              color: "#00AE42",
              grams: 21.5,
              profile: null,
              profileSource: null,
            },
          ],
        },
      },
    },
  ],
};

/** What the fake library does on the next call; reset by each test that changes it. */
const behaviour = {
  listThrows: undefined as Error | undefined,
  createExists: false,
  storeFails: undefined as Error | undefined,
  tagThrows: undefined as Error | undefined,
};

const library: ApiLibrary = {
  async listModels(query) {
    if (behaviour.listThrows !== undefined) throw behaviour.listThrows;
    if (query.externalRef !== undefined) return { models: [MODEL], nextCursor: null };
    return { models: [MODEL], nextCursor: "eyJuZXh0Ijp0cnVlfQ" };
  },
  async createModel(input) {
    if (behaviour.createExists) return { exists: true, trashed: true };
    return { model: { ...MODEL, name: input.name } };
  },
  async getModel(id) {
    return id === MODEL_ID ? { ...MODEL, files: [FILE] } : undefined;
  },
  async getFile(id) {
    return id === FILE_ID ? FILE : undefined;
  },
  async fileHead(id) {
    if (id !== FILE_ID) return undefined;
    if (behaviour.storeFails !== undefined) throw behaviour.storeFails;
    return { name: "cable-clip.3mf", contentType: "model/3mf", size: 5 };
  },
  async openFile(id) {
    if (id !== FILE_ID) return undefined;
    if (behaviour.storeFails !== undefined) throw behaviour.storeFails;
    return {
      name: "cable-clip.3mf",
      contentType: "model/3mf",
      size: 5,
      stream: Readable.from([Buffer.from("hello")]),
    };
  },
  async modelIsLive(id) {
    return id === MODEL_ID;
  },
  async addTag(id) {
    if (behaviour.tagThrows !== undefined) throw behaviour.tagThrows;
    return id === MODEL_ID;
  },
  async removeTag(id) {
    return id === MODEL_ID;
  },
  async addToCollection(id) {
    return id === MODEL_ID;
  },
  async removeFromCollection(id) {
    return id === MODEL_ID;
  },
};

let tokensFail = false;
const deps: ApiDeps = {
  tokens: {
    async authenticate(header) {
      if (tokensFail) throw new Error("connect ECONNREFUSED 10.0.0.9:5432");
      if (header !== AUTH.authorization) return undefined;
      return { id: "t1", name: "test", prefix: GOOD.slice(0, 8) } as unknown as ApiToken;
    },
  },
  library,
};

let app: FastifyInstance;
let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ph-v1-answers-"));
  app = Fastify();
  await registerOpenApi(app, { serverUrl: "https://platehouse.example.com/api/v1" });
  await registerV1(app, deps);
  await registerTus(app, {
    prefix: "/api/v1/uploads",
    authHook: apiUploadHook(deps),
    uploads: createUploads({
      tmpDir: tmp,
      queue: { enqueue: async () => {}, result: async () => undefined },
      log: () => {},
    }),
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await rm(tmp, { recursive: true, force: true });
});

type Method = "GET" | "HEAD" | "POST" | "PUT" | "DELETE" | "PATCH";

/** The parts of an answer a client reads: status, the headers that matter, and the exact body. */
async function answer(
  method: Method,
  url: string,
  init: { headers?: Record<string, string>; payload?: string } = {},
) {
  const res = await app.inject({
    method,
    url,
    headers: init.headers ?? AUTH,
    ...(init.payload === undefined ? {} : { payload: init.payload }),
  });
  const pick = (name: string) => {
    const value = res.headers[name];
    return value === undefined ? undefined : String(value);
  };
  return {
    status: res.statusCode,
    type: pick("content-type"),
    cache: pick("cache-control"),
    auth: pick("www-authenticate"),
    disposition: pick("content-disposition"),
    length: pick("content-length"),
    body: res.body,
  };
}

const JSON_HEADERS = { ...AUTH, "content-type": "application/json" };

describe("every v1 route without a live token", () => {
  const routes: Array<[Method, string]> = [
    ["GET", "/api/v1/openapi.json"],
    ["GET", "/api/v1/models"],
    ["POST", "/api/v1/models"],
    ["GET", `/api/v1/models/${MODEL_ID}`],
    ["GET", `/api/v1/files/${FILE_ID}`],
    ["GET", `/api/v1/files/${FILE_ID}/content`],
    ["PUT", `/api/v1/models/${MODEL_ID}/tags/desk`],
    ["DELETE", `/api/v1/models/${MODEL_ID}/tags/desk`],
    ["PUT", `/api/v1/collections/Office/models/${MODEL_ID}`],
    ["DELETE", `/api/v1/collections/Office/models/${MODEL_ID}`],
    ["POST", "/api/v1/uploads"],
    ["PATCH", `/api/v1/uploads/${MODEL_ID}`],
    ["GET", `/api/v1/uploads/${MODEL_ID}/result`],
  ];

  test.each(routes)("%s %s is 401 with WWW-Authenticate: Bearer", async (method, url) => {
    const res = await answer(method, url, { headers: {} });
    expect(res).toMatchObject({
      status: 401,
      auth: "Bearer",
      cache: "no-store",
      body: '{"error":"unauthorized"}',
    });
    expect(res.type).toMatch(/^application\/json/);
  });

  test.each(routes)("%s %s is 503 when the token store fails", async (method, url) => {
    tokensFail = true;
    try {
      const res = await answer(method, url);
      expect(res).toMatchObject({ status: 503, body: '{"error":"unavailable"}' });
    } finally {
      tokensFail = false;
    }
  });
});

describe("GET /api/v1/models", () => {
  test("a page of models", async () => {
    expect(await answer("GET", "/api/v1/models?q=clip&limit=10")).toMatchInlineSnapshot(`
      {
        "auth": undefined,
        "body": "{"models":[{"id":"0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b","name":"Cable clip","caption":"A clip for desk cables","description":"Prints without supports.","creator":"Example Maker","license":"CC-BY-4.0","licenseNote":null,"externalRef":"manyfold:42","tags":["desk","clips"],"collections":["Office"],"createdAt":"2026-11-01T10:00:00.000Z","updatedAt":"2026-11-02T11:30:00.000Z"}],"nextCursor":"eyJuZXh0Ijp0cnVlfQ"}",
        "cache": "no-store",
        "disposition": undefined,
        "length": "410",
        "status": 200,
        "type": "application/json; charset=utf-8",
      }
    `);
  });

  test("externalRef with another field is 400", async () => {
    expect(
      await answer("GET", "/api/v1/models?externalRef=manyfold:42&q=clip"),
    ).toMatchInlineSnapshot(`
        {
          "auth": undefined,
          "body": "{"error":"bad_request","message":"externalRef cannot be combined with other fields"}",
          "cache": "no-store",
          "disposition": undefined,
          "length": "84",
          "status": 400,
          "type": "application/json; charset=utf-8",
        }
      `);
  });

  test("a limit out of range is 400", async () => {
    expect(await answer("GET", "/api/v1/models?limit=0")).toMatchInlineSnapshot(`
      {
        "auth": undefined,
        "body": "{"error":"bad_request","message":"querystring/limit must be >= 1"}",
        "cache": "no-store",
        "disposition": undefined,
        "length": "66",
        "status": 400,
        "type": "application/json; charset=utf-8",
      }
    `);
  });

  test("a bad cursor is 400", async () => {
    behaviour.listThrows = new InvalidCursor();
    try {
      expect(await answer("GET", "/api/v1/models?cursor=nope")).toMatchInlineSnapshot(`
        {
          "auth": undefined,
          "body": "{"error":"bad_request","message":"The cursor is not valid"}",
          "cache": "no-store",
          "disposition": undefined,
          "length": "59",
          "status": 400,
          "type": "application/json; charset=utf-8",
        }
      `);
    } finally {
      behaviour.listThrows = undefined;
    }
  });

  test("a failure is 500 with no detail", async () => {
    behaviour.listThrows = new Error("connect ECONNREFUSED 10.0.0.9:5432");
    try {
      expect(await answer("GET", "/api/v1/models")).toMatchInlineSnapshot(`
        {
          "auth": undefined,
          "body": "{"error":"internal"}",
          "cache": "no-store",
          "disposition": undefined,
          "length": "20",
          "status": 500,
          "type": "application/json; charset=utf-8",
        }
      `);
    } finally {
      behaviour.listThrows = undefined;
    }
  });
});

describe("POST /api/v1/models", () => {
  test("201 with the model", async () => {
    expect(
      await answer("POST", "/api/v1/models", {
        headers: JSON_HEADERS,
        payload: JSON.stringify({ name: "Cable clip", tags: ["desk"] }),
      }),
    ).toMatchInlineSnapshot(`
      {
        "auth": undefined,
        "body": "{"model":{"id":"0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b","name":"Cable clip","caption":"A clip for desk cables","description":"Prints without supports.","creator":"Example Maker","license":"CC-BY-4.0","licenseNote":null,"externalRef":"manyfold:42","tags":["desk","clips"],"collections":["Office"],"createdAt":"2026-11-01T10:00:00.000Z","updatedAt":"2026-11-02T11:30:00.000Z"}}",
        "cache": "no-store",
        "disposition": undefined,
        "length": "373",
        "status": 201,
        "type": "application/json; charset=utf-8",
      }
    `);
  });

  test("a taken externalRef is 409", async () => {
    behaviour.createExists = true;
    try {
      expect(
        await answer("POST", "/api/v1/models", {
          headers: JSON_HEADERS,
          payload: JSON.stringify({ name: "Cable clip", externalRef: "manyfold:42" }),
        }),
      ).toMatchInlineSnapshot(`
        {
          "auth": undefined,
          "body": "{"error":"exists","trashed":true}",
          "cache": "no-store",
          "disposition": undefined,
          "length": "33",
          "status": 409,
          "type": "application/json; charset=utf-8",
        }
      `);
    } finally {
      behaviour.createExists = false;
    }
  });

  // docs/api.md: for an unknown body field, "message says which".
  test("an unknown key is 400, and the message names it", async () => {
    expect(
      await answer("POST", "/api/v1/models", {
        headers: JSON_HEADERS,
        payload: JSON.stringify({ name: "Cable clip", colour: "red" }),
      }),
    ).toMatchInlineSnapshot(`
      {
        "auth": undefined,
        "body": "{"error":"bad_request","message":"body has an unknown field: colour"}",
        "cache": "no-store",
        "disposition": undefined,
        "length": "69",
        "status": 400,
        "type": "application/json; charset=utf-8",
      }
    `);
  });

  // Issue #340: the OpenAPI document (and the Settings API page's copy of
  // it) shows this answer as its 400 example, so it must be the answer sent.
  test("the documented 400 example is the answer an unknown key gets", async () => {
    const doc = JSON.parse((await answer("GET", "/api/v1/openapi.json")).body) as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    const documented = doc.paths["/models"]?.post?.responses["400"] as {
      content: { "application/json": { example: unknown } };
    };
    const sent = await answer("POST", "/api/v1/models", {
      headers: JSON_HEADERS,
      payload: JSON.stringify({ name: "Cable clip", colour: "red" }),
    });
    expect(documented.content["application/json"].example).toEqual(JSON.parse(sent.body));
  });

  test("an unknown key too long to show is named by its start", async () => {
    const res = await answer("POST", "/api/v1/models", {
      headers: JSON_HEADERS,
      payload: JSON.stringify({ name: "Cable clip", ["k".repeat(5000)]: 1 }),
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: "bad_request",
      message: `body has an unknown field: ${"k".repeat(100)}...`,
    });
  });

  test("broken JSON is 400", async () => {
    expect(
      await answer("POST", "/api/v1/models", { headers: JSON_HEADERS, payload: "{" }),
    ).toMatchInlineSnapshot(`
      {
        "auth": undefined,
        "body": "{"error":"bad_request","message":"Body is not valid JSON but content-type is set to 'application/json'"}",
        "cache": "no-store",
        "disposition": undefined,
        "length": "104",
        "status": 400,
        "type": "application/json; charset=utf-8",
      }
    `);
  });

  test("a body that is not JSON is 415", async () => {
    expect(
      await answer("POST", "/api/v1/models", {
        headers: { ...AUTH, "content-type": "text/plain" },
        payload: "name=Cable clip",
      }),
    ).toMatchInlineSnapshot(`
      {
        "auth": undefined,
        "body": "{"error":"bad_request","message":"Unsupported Media Type"}",
        "cache": "no-store",
        "disposition": undefined,
        "length": "58",
        "status": 415,
        "type": "application/json; charset=utf-8",
      }
    `);
  });

  test("a body over 1 MiB is 413", async () => {
    const res = await answer("POST", "/api/v1/models", {
      headers: JSON_HEADERS,
      payload: JSON.stringify({ name: "x", description: "y".repeat(1024 * 1024) }),
    });
    expect(res).toMatchInlineSnapshot(`
      {
        "auth": undefined,
        "body": "{"error":"bad_request","message":"Request body is too large"}",
        "cache": "no-store",
        "disposition": undefined,
        "length": "61",
        "status": 413,
        "type": "application/json; charset=utf-8",
      }
    `);
  });
});

describe("one model, one file", () => {
  test("GET /models/:id is the model with its files", async () => {
    expect(await answer("GET", `/api/v1/models/${MODEL_ID}`)).toMatchInlineSnapshot(`
      {
        "auth": undefined,
        "body": "{"id":"0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b","name":"Cable clip","caption":"A clip for desk cables","description":"Prints without supports.","creator":"Example Maker","license":"CC-BY-4.0","licenseNote":null,"externalRef":"manyfold:42","tags":["desk","clips"],"collections":["Office"],"createdAt":"2026-11-01T10:00:00.000Z","updatedAt":"2026-11-02T11:30:00.000Z","files":[{"id":"0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a6c","modelId":"0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b","name":"cable-clip.3mf","originalName":"cable-clip.3mf","kind":"3mf","size":5,"sha256":"abababababababababababababababababababababababababababababababab","parseStatus":"ok","derivedStatus":null,"derivedMessage":null,"previewStatus":null,"previewMessage":null,"createdAt":"2026-11-01T10:00:00.000Z","updatedAt":"2026-11-01T10:00:00.000Z","plates":[{"id":"0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a7d","index":1,"name":"Plate 1","objectCount":4,"numbers":{"file":{"source":"file","estimateId":"e1","printerId":"Bambu Lab P1S 0.4 nozzle","printerLabel":"Bambu Lab P1S 0.4 nozzle","printerName":"Bambu Lab P1S, 0.4 mm nozzle","slicer":"BambuStudio","slicerVersion":"02.03.00.70","processProfile":"0.20mm Standard @BBL X1C","timeSeconds":3720,"weightGrams":21.5,"filaments":[{"slot":1,"type":"PLA","color":"#00AE42","grams":21.5,"profile":null,"profileSource":null}]}}}]}]}",
        "cache": "no-store",
        "disposition": undefined,
        "length": "1326",
        "status": 200,
        "type": "application/json; charset=utf-8",
      }
    `);
  });

  test("GET /models/:id of an unknown model is 404", async () => {
    expect(await answer("GET", `/api/v1/models/${GONE}`)).toMatchInlineSnapshot(`
      {
        "auth": undefined,
        "body": "{"error":"not_found"}",
        "cache": "no-store",
        "disposition": undefined,
        "length": "21",
        "status": 404,
        "type": "application/json; charset=utf-8",
      }
    `);
  });

  test("GET /files/:id is the file", async () => {
    expect(await answer("GET", `/api/v1/files/${FILE_ID}`)).toMatchInlineSnapshot(`
      {
        "auth": undefined,
        "body": "{"id":"0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a6c","modelId":"0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b","name":"cable-clip.3mf","originalName":"cable-clip.3mf","kind":"3mf","size":5,"sha256":"abababababababababababababababababababababababababababababababab","parseStatus":"ok","derivedStatus":null,"derivedMessage":null,"previewStatus":null,"previewMessage":null,"createdAt":"2026-11-01T10:00:00.000Z","updatedAt":"2026-11-01T10:00:00.000Z","plates":[{"id":"0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a7d","index":1,"name":"Plate 1","objectCount":4,"numbers":{"file":{"source":"file","estimateId":"e1","printerId":"Bambu Lab P1S 0.4 nozzle","printerLabel":"Bambu Lab P1S 0.4 nozzle","printerName":"Bambu Lab P1S, 0.4 mm nozzle","slicer":"BambuStudio","slicerVersion":"02.03.00.70","processProfile":"0.20mm Standard @BBL X1C","timeSeconds":3720,"weightGrams":21.5,"filaments":[{"slot":1,"type":"PLA","color":"#00AE42","grams":21.5,"profile":null,"profileSource":null}]}}}]}",
        "cache": "no-store",
        "disposition": undefined,
        "length": "952",
        "status": 200,
        "type": "application/json; charset=utf-8",
      }
    `);
  });

  test("GET /files/:id of an unknown file is 404", async () => {
    expect(await answer("GET", `/api/v1/files/${GONE}`)).toMatchInlineSnapshot(`
      {
        "auth": undefined,
        "body": "{"error":"not_found"}",
        "cache": "no-store",
        "disposition": undefined,
        "length": "21",
        "status": 404,
        "type": "application/json; charset=utf-8",
      }
    `);
  });
});

describe("a file's bytes", () => {
  test("GET is the bytes with the file's headers", async () => {
    expect(await answer("GET", `/api/v1/files/${FILE_ID}/content`)).toMatchInlineSnapshot(`
      {
        "auth": undefined,
        "body": "hello",
        "cache": "private, no-store",
        "disposition": "attachment; filename="cable-clip.3mf"; filename*=UTF-8''cable-clip.3mf",
        "length": "5",
        "status": 200,
        "type": "model/3mf",
      }
    `);
  });

  test("HEAD is the headers with no body", async () => {
    expect(await answer("HEAD", `/api/v1/files/${FILE_ID}/content`)).toMatchInlineSnapshot(`
      {
        "auth": undefined,
        "body": "",
        "cache": "private, no-store",
        "disposition": "attachment; filename="cable-clip.3mf"; filename*=UTF-8''cable-clip.3mf",
        "length": "5",
        "status": 200,
        "type": "model/3mf",
      }
    `);
  });

  test("an unknown file is 404", async () => {
    expect(await answer("GET", `/api/v1/files/${GONE}/content`)).toMatchInlineSnapshot(`
      {
        "auth": undefined,
        "body": "{"error":"not_found"}",
        "cache": "no-store",
        "disposition": undefined,
        "length": "21",
        "status": 404,
        "type": "application/json; charset=utf-8",
      }
    `);
  });

  test.each([
    ["the store is down", new StoreUnavailable("GetObject", "ECONNREFUSED")],
    ["the blob is missing", new BlobNotFound("GetObject")],
  ])("%s: 503", async (_name, error) => {
    behaviour.storeFails = error;
    try {
      const get = await answer("GET", `/api/v1/files/${FILE_ID}/content`);
      const head = await answer("HEAD", `/api/v1/files/${FILE_ID}/content`);
      expect(get).toMatchObject({
        status: 503,
        body: '{"error":"unavailable","message":"This file is unavailable right now"}',
      });
      expect(get.disposition).toBeUndefined();
      expect(head.status).toBe(503);
    } finally {
      behaviour.storeFails = undefined;
    }
  });
});

describe("tags and collections", () => {
  test.each<[Method, string]>([
    ["PUT", `/api/v1/models/${MODEL_ID}/tags/desk`],
    ["DELETE", `/api/v1/models/${MODEL_ID}/tags/desk`],
    ["PUT", `/api/v1/collections/Office/models/${MODEL_ID}`],
    ["DELETE", `/api/v1/collections/Office/models/${MODEL_ID}`],
  ])("%s %s is 204", async (method, url) => {
    const res = await answer(method, url);
    expect(res).toMatchObject({ status: 204, body: "", cache: "no-store" });
  });

  test.each<[Method, string]>([
    ["PUT", `/api/v1/models/${GONE}/tags/desk`],
    ["DELETE", `/api/v1/models/${GONE}/tags/desk`],
    ["PUT", `/api/v1/collections/Office/models/${GONE}`],
    ["DELETE", `/api/v1/collections/Office/models/${GONE}`],
  ])("%s %s of an unknown model is 404", async (method, url) => {
    const res = await answer(method, url);
    expect(res).toMatchObject({ status: 404, body: '{"error":"not_found"}' });
  });

  test("a blank tag is 400", async () => {
    expect(await answer("PUT", `/api/v1/models/${MODEL_ID}/tags/%20`)).toMatchInlineSnapshot(`
      {
        "auth": undefined,
        "body": "{"error":"bad_request","message":"params/tag must match pattern \\"\\\\S\\""}",
        "cache": "no-store",
        "disposition": undefined,
        "length": "73",
        "status": 400,
        "type": "application/json; charset=utf-8",
      }
    `);
  });

  test("a tag the library refuses is 400 with its message", async () => {
    behaviour.tagThrows = new RangeError("A tag is 1 to 100 characters");
    try {
      expect(await answer("PUT", `/api/v1/models/${MODEL_ID}/tags/desk`)).toMatchInlineSnapshot(`
        {
          "auth": undefined,
          "body": "{"error":"bad_request","message":"A tag is 1 to 100 characters"}",
          "cache": "no-store",
          "disposition": undefined,
          "length": "64",
          "status": 400,
          "type": "application/json; charset=utf-8",
        }
      `);
    } finally {
      behaviour.tagThrows = undefined;
    }
  });
});

describe("uploads", () => {
  test("a creation naming a model that is not live is 404", async () => {
    const modelId = Buffer.from(GONE).toString("base64");
    const filename = Buffer.from("clip.stl").toString("base64");
    expect(
      await answer("POST", "/api/v1/uploads", {
        headers: {
          ...AUTH,
          "tus-resumable": "1.0.0",
          "upload-length": "5",
          "upload-metadata": `filename ${filename},modelId ${modelId}`,
        },
      }),
    ).toMatchInlineSnapshot(`
      {
        "auth": undefined,
        "body": "{"error":"not_found"}",
        "cache": "no-store",
        "disposition": undefined,
        "length": "21",
        "status": 404,
        "type": "application/json; charset=utf-8",
      }
    `);
  });
});
