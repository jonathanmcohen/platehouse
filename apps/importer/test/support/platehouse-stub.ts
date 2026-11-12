// An in-memory MSW stub of the Platehouse Public API v1 (build plan Task 16),
// holding only the routes the importer uses, with the answers
// apps/server/src/api/v1.ts and apps/server/src/uploads/tus.ts give:
//
//   GET  /api/v1/models?externalRef=     live model with that ref, or none;
//                                        400 when combined with other fields
//   GET  /api/v1/models?limit=           live models
//   POST /api/v1/models                  201 {model} | 409 {error, trashed};
//                                        400 outside NEW_MODEL's limits
//   GET  /api/v1/models/:id              404 when trashed
//   GET  /api/v1/files/:id
//   PUT  /api/v1/models/:id/tags/:tag    204 | 404 | 400 a tag outside LABEL
//   PUT  /api/v1/collections/:name/models/:id   204 | 404 | 400 a name outside LABEL
//   (either PUT: 414 for a path parameter over the router's maxParamLength)
//   POST /api/v1/uploads                 tus 1.0.0 creation: 201 + Location,
//                                        400 no filename, 415 unsupported
//                                        type, 404 modelId not live
//   HEAD, PATCH /api/v1/uploads/:id      tus offset and append
//   GET  /api/v1/uploads/:id/result      pending | done | failed
//
// Every route needs the bearer token; anything else is 401 JSON, as the
// bearer hook answers. Nothing deletes or trashes through the API; a test
// trashes a model with trash(), as Jon would in the UI.
import { createHash, randomUUID } from "node:crypto";
import { HttpResponse, http } from "msw";

/** LABEL in apps/server/src/api/v1.ts: a tag or collection name, 1 to 100 code points, not blank. */
const MAX_LABEL = 100;
/** NEW_MODEL's maxItems for tags and for collections. */
const MAX_LABELS = 100;

function validLabel(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const n = [...v].length;
  return n >= 1 && n <= MAX_LABEL && /\S/.test(v);
}

const badLabel = () =>
  HttpResponse.json({ error: "bad_request", message: "bad label" }, { status: 400 });

/**
 * Fastify's router (find-my-way, default maxParamLength 100, not overridden
 * in apps/server/src/app.ts) measures each path parameter after decoding, in
 * UTF-16 units with String.length, and answers 414 before any hook runs, so
 * before the bearer check. MSW hands the params over decoded too.
 */
const MAX_PARAM_LENGTH = 100;

function overLongParam(request: Request, params: Record<string, unknown>): Response | null {
  const over = Object.values(params).some((v) => String(v).length > MAX_PARAM_LENGTH);
  if (!over) return null;
  return HttpResponse.json(
    {
      error: "URI Too Long",
      code: "FST_ERR_MAX_PARAM_LENGTH",
      message: `'${new URL(request.url).pathname}' is exceeding the max param length`,
      statusCode: 414,
    },
    { status: 414 },
  );
}

export interface StubPlatehouseModel {
  id: string;
  name: string;
  caption: string | null;
  description: string | null;
  creator: string | null;
  license: string | null;
  licenseNote: string | null;
  externalRef: string | null;
  tags: string[];
  collections: string[];
  trashed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StubPlatehouseFile {
  id: string;
  modelId: string;
  name: string;
  originalName: string;
  kind: string;
  size: number;
  sha256: string;
  createdAt: string;
  updatedAt: string;
}

interface Upload {
  id: string;
  length: number;
  filename: string;
  modelId: string | null;
  chunks: Buffer[];
  offset: number;
  result:
    | { status: "pending" }
    | { status: "done"; modelId: string; fileId: string }
    | {
        status: "failed";
        error: string;
      };
  pendingPolls: number;
}

export interface PlatehouseStubOptions {
  origin: string;
  bearer: string;
  /** How many result polls answer pending before the ingest's outcome; 1 by default. */
  pendingPolls?: number;
  /** Changes the bytes the stub stores for an upload, to fake a bad store. */
  mangle?: (filename: string, bytes: Buffer) => Buffer;
}

const KINDS = new Map([
  ["3mf", "3mf"],
  ["stl", "stl"],
  ["step", "step"],
  ["stp", "step"],
  ["scad", "scad"],
]);

function kindOf(name: string): string | undefined {
  const base = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? undefined : KINDS.get(base.slice(dot + 1).toLowerCase());
}

const NOT_FOUND = { error: "not_found" };

export function createPlatehouseStub(options: PlatehouseStubOptions) {
  const api = `${options.origin}/api/v1`;
  const models = new Map<string, StubPlatehouseModel>();
  const files = new Map<string, StubPlatehouseFile>();
  const uploads = new Map<string, Upload>();
  const requests: Array<{ method: string; path: string }> = [];
  const now = () => new Date().toISOString();

  const live = (id: string) => {
    const m = models.get(id);
    return m !== undefined && !m.trashed ? m : undefined;
  };
  const unauthorised = () =>
    HttpResponse.json(
      { error: "unauthorized", message: "A valid API token is required" },
      { status: 401 },
    );

  function authorised(request: Request): boolean {
    const url = new URL(request.url);
    requests.push({ method: request.method, path: url.pathname + url.search });
    return request.headers.get("authorization") === `Bearer ${options.bearer}`;
  }

  function apiModel(m: StubPlatehouseModel) {
    const { trashed: _trashed, ...shown } = m;
    return { ...shown, tags: [...m.tags].sort(), collections: [...m.collections].sort() };
  }

  function apiFile(f: StubPlatehouseFile) {
    return {
      ...f,
      parseStatus: "ok",
      derivedStatus: null,
      derivedMessage: null,
      plates: [],
    };
  }

  /**
   * As the server's tags and collections repos do (tagName, collectionName):
   * the name is trimmed before it is stored or matched, and matched without
   * case, so "Gifts " lands on an existing "gifts".
   */
  function addLabel(list: string[], label: string) {
    const name = label.trim();
    if (!list.some((x) => x.toLowerCase() === name.toLowerCase())) list.push(name);
  }

  function ingest(upload: Upload) {
    const model = upload.modelId === null ? undefined : live(upload.modelId);
    if (model === undefined) {
      upload.result = { status: "failed", error: "The model is in the trash or gone" };
      return;
    }
    let bytes: Buffer = Buffer.concat(upload.chunks);
    if (options.mangle !== undefined) bytes = options.mangle(upload.filename, bytes);
    const file: StubPlatehouseFile = {
      id: randomUUID(),
      modelId: model.id,
      name: upload.filename,
      originalName: upload.filename,
      kind: kindOf(upload.filename) ?? "3mf",
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      createdAt: now(),
      updatedAt: now(),
    };
    files.set(file.id, file);
    upload.result = { status: "done", modelId: model.id, fileId: file.id };
  }

  /** POST /api/v1/models's NEW_MODEL schema (apps/server/src/api/v1.ts), lengths in code points. */
  function validNewModel(
    body: Record<string, unknown>,
  ): body is Record<string, unknown> & { name: string } {
    const text = (key: string, min: number, max: number, nonBlank: boolean) => {
      const v = body[key];
      if (v === undefined && key !== "name") return true;
      if (typeof v !== "string") return false;
      const n = [...v].length;
      return n >= min && n <= max && (!nonBlank || /\S/.test(v));
    };
    const labels = (key: string) => {
      const v = body[key];
      if (v === undefined) return true;
      return Array.isArray(v) && v.length <= MAX_LABELS && v.every(validLabel);
    };
    return (
      text("name", 1, 500, true) &&
      text("caption", 0, 2000, false) &&
      text("description", 0, 200_000, false) &&
      text("creator", 1, 300, true) &&
      text("license", 1, 200, false) &&
      text("externalRef", 1, 300, false) &&
      labels("tags") &&
      labels("collections")
    );
  }

  /** POST /api/v1/models with this parsed body, as the server answers it. */
  function createModel(body: Record<string, unknown>): Response {
    const allowed = [
      "name",
      "caption",
      "description",
      "creator",
      "license",
      "externalRef",
      "tags",
      "collections",
    ];
    const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
    if (unknown.length > 0 || !validNewModel(body)) {
      return HttpResponse.json({ error: "bad_request", message: "bad body" }, { status: 400 });
    }
    const ref = typeof body.externalRef === "string" ? body.externalRef : null;
    const taken = [...models.values()].find((m) => ref !== null && m.externalRef === ref);
    if (taken !== undefined) {
      return HttpResponse.json({ error: "exists", trashed: taken.trashed }, { status: 409 });
    }
    const str = (v: unknown) => (typeof v === "string" ? v : null);
    const model: StubPlatehouseModel = {
      id: randomUUID(),
      name: body.name.trim(),
      caption: str(body.caption),
      description: str(body.description),
      creator: str(body.creator),
      license: str(body.license),
      licenseNote: null,
      externalRef: ref,
      tags: [],
      collections: [],
      trashed: false,
      createdAt: now(),
      updatedAt: now(),
    };
    for (const t of (body.tags as string[] | undefined) ?? []) addLabel(model.tags, t);
    for (const c of (body.collections as string[] | undefined) ?? []) {
      addLabel(model.collections, c);
    }
    models.set(model.id, model);
    return HttpResponse.json({ model: apiModel(model) }, { status: 201 });
  }

  const handlers = [
    http.get(`${api}/models`, ({ request }) => {
      if (!authorised(request)) return unauthorised();
      const q = new URL(request.url).searchParams;
      const ref = q.get("externalRef");
      if (ref !== null) {
        if ([...q.keys()].some((k) => k !== "externalRef")) {
          return HttpResponse.json(
            { error: "bad_request", message: "externalRef cannot be combined with other fields" },
            { status: 400 },
          );
        }
        const found = [...models.values()].filter((m) => m.externalRef === ref && !m.trashed);
        return HttpResponse.json({ models: found.map(apiModel), nextCursor: null });
      }
      const limit = Number(q.get("limit") ?? "50");
      const all = [...models.values()].filter((m) => !m.trashed).slice(0, limit);
      return HttpResponse.json({ models: all.map(apiModel), nextCursor: null });
    }),

    http.post(`${api}/models`, async ({ request }) => {
      if (!authorised(request)) return unauthorised();
      if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) {
        return HttpResponse.json({ error: "bad_request", message: "JSON only" }, { status: 415 });
      }
      return createModel((await request.json()) as Record<string, unknown>);
    }),

    http.get(`${api}/models/:id`, ({ request, params }) => {
      if (!authorised(request)) return unauthorised();
      const m = live(String(params.id));
      if (m === undefined) return HttpResponse.json(NOT_FOUND, { status: 404 });
      const own = [...files.values()].filter((f) => f.modelId === m.id).map(apiFile);
      return HttpResponse.json({ ...apiModel(m), files: own });
    }),

    http.get(`${api}/files/:id`, ({ request, params }) => {
      if (!authorised(request)) return unauthorised();
      const f = files.get(String(params.id));
      if (f === undefined || live(f.modelId) === undefined) {
        return HttpResponse.json(NOT_FOUND, { status: 404 });
      }
      return HttpResponse.json(apiFile(f));
    }),

    http.put(`${api}/models/:id/tags/:tag`, ({ request, params }) => {
      const tooLong = overLongParam(request, params);
      if (tooLong !== null) return tooLong;
      if (!authorised(request)) return unauthorised();
      if (!validLabel(String(params.tag))) return badLabel();
      const m = live(String(params.id));
      if (m === undefined) return HttpResponse.json(NOT_FOUND, { status: 404 });
      addLabel(m.tags, String(params.tag));
      return new HttpResponse(null, { status: 204 });
    }),

    http.put(`${api}/collections/:name/models/:id`, ({ request, params }) => {
      const tooLong = overLongParam(request, params);
      if (tooLong !== null) return tooLong;
      if (!authorised(request)) return unauthorised();
      if (!validLabel(String(params.name))) return badLabel();
      const m = live(String(params.id));
      if (m === undefined) return HttpResponse.json(NOT_FOUND, { status: 404 });
      addLabel(m.collections, String(params.name));
      return new HttpResponse(null, { status: 204 });
    }),

    http.post(`${api}/uploads`, ({ request }) => {
      if (!authorised(request)) return unauthorised();
      if (request.headers.get("tus-resumable") !== "1.0.0") {
        return new HttpResponse(null, { status: 412 });
      }
      const length = Number(request.headers.get("upload-length"));
      if (!Number.isInteger(length) || length < 0) {
        return new HttpResponse("Upload-Length is required", { status: 400 });
      }
      const meta = new Map<string, string>();
      for (const pair of (request.headers.get("upload-metadata") ?? "").split(",")) {
        const [key, value] = pair.trim().split(" ");
        if (key) meta.set(key, Buffer.from(value ?? "", "base64").toString("utf8"));
      }
      const filename = meta.get("filename");
      if (filename === undefined || filename === "") {
        return new HttpResponse("Upload-Metadata must carry filename", { status: 400 });
      }
      if (kindOf(filename) === undefined) {
        return new HttpResponse("Platehouse does not take this type of file", { status: 415 });
      }
      const modelId = meta.get("modelId") ?? null;
      if (modelId !== null && live(modelId) === undefined) {
        return HttpResponse.json(NOT_FOUND, { status: 404 });
      }
      const id = randomUUID();
      uploads.set(id, {
        id,
        length,
        filename,
        modelId,
        chunks: [],
        offset: 0,
        result: { status: "pending" },
        pendingPolls: options.pendingPolls ?? 1,
      });
      return new HttpResponse(null, {
        status: 201,
        headers: { location: `/api/v1/uploads/${id}`, "tus-resumable": "1.0.0" },
      });
    }),

    http.head(`${api}/uploads/:id`, ({ request, params }) => {
      if (!authorised(request)) return unauthorised();
      const u = uploads.get(String(params.id));
      if (u === undefined) return new HttpResponse(null, { status: 404 });
      return new HttpResponse(null, {
        status: 200,
        headers: {
          "upload-offset": String(u.offset),
          "upload-length": String(u.length),
          "tus-resumable": "1.0.0",
          "cache-control": "no-store",
        },
      });
    }),

    http.patch(`${api}/uploads/:id`, async ({ request, params }) => {
      if (!authorised(request)) return unauthorised();
      const u = uploads.get(String(params.id));
      if (u === undefined) return new HttpResponse(null, { status: 404 });
      if (request.headers.get("content-type") !== "application/offset+octet-stream") {
        return new HttpResponse(null, { status: 415 });
      }
      if (Number(request.headers.get("upload-offset")) !== u.offset) {
        return new HttpResponse(null, { status: 409 });
      }
      const chunk = Buffer.from(await request.arrayBuffer());
      if (u.offset + chunk.length > u.length) return new HttpResponse(null, { status: 413 });
      u.chunks.push(chunk);
      u.offset += chunk.length;
      if (u.offset === u.length) ingest(u);
      return new HttpResponse(null, {
        status: 204,
        headers: { "upload-offset": String(u.offset), "tus-resumable": "1.0.0" },
      });
    }),

    http.get(`${api}/uploads/:id/result`, ({ request, params }) => {
      if (!authorised(request)) return unauthorised();
      const u = uploads.get(String(params.id));
      if (u === undefined) return HttpResponse.json(NOT_FOUND, { status: 404 });
      if (u.result.status !== "pending" && u.pendingPolls > 0) {
        u.pendingPolls -= 1;
        return HttpResponse.json({ status: "pending" });
      }
      return HttpResponse.json(u.result);
    }),
  ];

  return {
    handlers,
    models,
    files,
    uploads,
    requests,
    /** Makes a model as POST /api/v1/models would, for a test that loses the answer. */
    createModel,
    /** Trashes a model, as Jon would in the UI. */
    trash(id: string) {
      const m = models.get(id);
      if (m !== undefined) m.trashed = true;
    },
    byRef(ref: string) {
      return [...models.values()].filter((m) => m.externalRef === ref);
    },
    filesOf(modelId: string) {
      return [...files.values()].filter((f) => f.modelId === modelId);
    },
  };
}

export type PlatehouseStub = ReturnType<typeof createPlatehouseStub>;
