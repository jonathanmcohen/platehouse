// An MSW stub of Manyfold 0.154.1, built from its recorded OpenAPI document
// (openapi.ts). It serves only documented paths: the GETs an import reads
// (models, model files, creators, collections) and every documented method
// other than GET. Anything else, an undocumented path or a documented GET the
// importer has no business reading, is unhandled, and the harness refuses it
// and fails the test. Every JSON body a GET answers is checked against the
// documented 200 schema before it is sent.
//
// What it does beyond the document, from how Manyfold behaves behind Traefik
// (the prior art manyfold.mjs at automation 1ce8c57):
// - POST /oauth/token, the document's clientCredentials tokenUrl, answers a
//   Doorkeeper-shaped token for the client id and secret it was given.
// - Absolute links come back as http:// (Traefik terminates TLS), list
//   members carry relative @id links, and lists page through view.next.
// - A file's contentUrl answers 302 to a presigned URL on the object store,
//   another host, whose query string is the signature. The object store
//   refuses a request that carries an Authorization header.
//
// Documented methods other than GET answer 405 and are recorded, so a test
// can show none was ever sent. The data is synthetic: no designer's file.
import { createHash, randomBytes } from "node:crypto";
import { HttpResponse, http, type JsonBodyType } from "msw";
import { assertDocumented, documentedPaths, V0 } from "./openapi.js";

export interface StubFile {
  id: string;
  filename: string;
  encodingFormat?: string;
  bytes: Buffer;
  /** What Manyfold reports as contentSize, when it should differ from bytes.length. */
  contentSize?: number;
}

export interface StubModel {
  id: string;
  name: string;
  caption?: string;
  description?: string;
  creatorId?: string;
  license?: string;
  keywords?: string[];
  collectionIds?: string[];
  files: StubFile[];
}

export interface StubData {
  models: StubModel[];
  creators: Array<{ id: string; name: string }>;
  collections: Array<{ id: string; name: string }>;
}

export interface ManyfoldStubOptions {
  origin: string;
  objectOrigin: string;
  clientId: string;
  clientKey: string;
  data: StubData;
  /** Members per list page; 2 so that paging is always exercised. */
  pageSize?: number;
}

export interface TokenRequest {
  grantType: string | null;
  scope: string | null;
  basicOk: boolean;
}

export interface ObjectRequest {
  url: string;
  authorization: string | null;
}

/** A body of n deterministic bytes, different per seed. */
export function bytesOf(seed: string, n: number): Buffer {
  const out = Buffer.alloc(n);
  let block = createHash("sha256").update(seed).digest();
  for (let i = 0; i < n; i += block.length) {
    block.copy(out, i, 0, Math.min(block.length, n - i));
    block = createHash("sha256").update(block).digest();
  }
  return out;
}

export function createManyfoldStub(options: ManyfoldStubOptions) {
  const { origin, objectOrigin, data } = options;
  const pageSize = options.pageSize ?? 2;
  const host = new URL(origin).host;
  /** Links as Manyfold sends them behind Traefik: http://, on its own host. */
  const link = (path: string) => `http://${host}${path}`;
  const accessToken = `mf-access-${randomBytes(12).toString("hex")}`;
  const tokenRequests: TokenRequest[] = [];
  const objectRequests: ObjectRequest[] = [];
  const signedQueries: string[] = [];
  const writes: string[] = [];

  const authorised = (request: Request) =>
    request.headers.get("authorization") === `Bearer ${accessToken}`;
  const unauthorised = () => new HttpResponse(null, { status: 401 });

  function json(path: string, body: unknown) {
    assertDocumented(path, body);
    return HttpResponse.json(body as JsonBodyType, { headers: { "content-type": V0 } });
  }

  function page<T>(collection: string, all: T[], url: URL, member: (t: T) => unknown) {
    const n = Math.max(1, Number(url.searchParams.get("page") ?? "1"));
    const last = Math.max(1, Math.ceil(all.length / pageSize));
    const view: Record<string, string> = {
      "@id": link(`/${collection}?page=${n}`),
      "@type": "hydra:PartialCollectionView",
      first: link(`/${collection}?page=1`),
      last: link(`/${collection}?page=${last}`),
    };
    if (n > 1) view.prev = link(`/${collection}?page=${n - 1}`);
    if (n < last) view.next = link(`/${collection}?page=${n + 1}`);
    return json(`/${collection}`, {
      "@context": ["https://www.w3.org/ns/hydra/core"],
      "@id": link(`/${collection}`),
      "@type": "hydra:Collection",
      totalItems: all.length,
      member: all.slice((n - 1) * pageSize, n * pageSize).map(member),
      view,
    });
  }

  function modelBody(m: StubModel) {
    const body: Record<string, unknown> = {
      "@context": ["https://schema.org/"],
      "@id": link(`/models/${m.id}`),
      "@type": "3DModel",
      name: m.name,
      hasPart: m.files.map((f) => ({
        "@id": link(`/models/${m.id}/model_files/${f.id}`),
        "@type": "3DModel",
        name: f.filename.replace(/\.[^.]+$/, ""),
        encodingFormat: f.encodingFormat ?? "model/3mf",
      })),
      keywords: m.keywords ?? [],
      isPartOf: (m.collectionIds ?? []).map((id) => ({
        "@id": link(`/collections/${id}`),
        "@type": "Collection",
      })),
      sensitive: false,
    };
    if (m.caption !== undefined) body.caption = m.caption;
    if (m.description !== undefined) body.description = m.description;
    if (m.creatorId !== undefined) {
      body.creator = { "@id": link(`/creators/${m.creatorId}`), "@type": "Organization" };
    }
    if (m.license !== undefined) {
      body["spdx:license"] = {
        "@type": "spdx:License",
        "@id": `http://spdx.org/licenses/${m.license}`,
        licenseId: m.license,
      };
    }
    return body;
  }

  const findModel = (id: string) => data.models.find((m) => m.id === id);

  const handlers = [
    http.post(`${origin}/oauth/token`, async ({ request }) => {
      const form = new URLSearchParams(await request.text());
      const expected = `Basic ${Buffer.from(`${options.clientId}:${options.clientKey}`).toString("base64")}`;
      const basicOk = request.headers.get("authorization") === expected;
      tokenRequests.push({ grantType: form.get("grant_type"), scope: form.get("scope"), basicOk });
      if (!basicOk || form.get("grant_type") !== "client_credentials") {
        return HttpResponse.json({ error: "invalid_client" }, { status: 401 });
      }
      return HttpResponse.json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 7200,
        scope: form.get("scope") ?? "public",
        created_at: 1_794_000_000,
      });
    }),

    http.get(`${origin}/models`, ({ request }) => {
      if (!authorised(request)) return unauthorised();
      return page("models", data.models, new URL(request.url), (m) => ({
        "@id": `/models/${m.id}`,
        "@type": "3DModel",
        name: m.name,
      }));
    }),

    http.get(`${origin}/models/:id`, ({ request, params }) => {
      if (!authorised(request)) return unauthorised();
      const m = findModel(String(params.id));
      if (m === undefined) return new HttpResponse(null, { status: 404 });
      return json("/models/{id}", modelBody(m));
    }),

    http.get(`${origin}/models/:model_id/model_files/:id`, ({ request, params }) => {
      if (!authorised(request)) return unauthorised();
      const m = findModel(String(params.model_id));
      const raw = String(params.id);
      const dot = raw.indexOf(".");
      const fileId = dot === -1 ? raw : raw.slice(0, dot);
      const f = m?.files.find((x) => x.id === fileId);
      if (m === undefined || f === undefined) return new HttpResponse(null, { status: 404 });
      if (dot !== -1) {
        // The contentUrl: a redirect to a presigned object-store URL.
        const signature = randomBytes(16).toString("hex");
        const query = `X-Amz-Credential=stub-credential%2F20261112&X-Amz-Signature=${signature}`;
        signedQueries.push(query);
        return new HttpResponse(null, {
          status: 302,
          headers: { location: `${objectOrigin}/manyfold/${m.id}/${f.id}?${query}` },
        });
      }
      const ext = f.filename.slice(f.filename.lastIndexOf("."));
      return json("/models/{model_id}/model_files/{id}", {
        "@context": ["https://schema.org/"],
        "@id": link(`/models/${m.id}/model_files/${f.id}`),
        "@type": "3DModel",
        name: f.filename.replace(/\.[^.]+$/, ""),
        filename: f.filename,
        encodingFormat: f.encodingFormat ?? "model/3mf",
        contentUrl: link(`/models/${m.id}/model_files/${f.id}${ext}`),
        contentSize: f.contentSize ?? f.bytes.length,
        isPartOf: { "@id": link(`/models/${m.id}`), "@type": "3DModel" },
        presupported: false,
        previewable: false,
      });
    }),

    http.get(`${objectOrigin}/manyfold/:model/:file`, ({ request, params }) => {
      objectRequests.push({
        url: request.url,
        authorization: request.headers.get("authorization"),
      });
      if (request.headers.get("authorization") !== null) {
        return new HttpResponse("Only one auth mechanism allowed", { status: 400 });
      }
      const query = new URL(request.url).search.slice(1);
      if (!signedQueries.includes(query)) return new HttpResponse(null, { status: 403 });
      const f = findModel(String(params.model))?.files.find((x) => x.id === String(params.file));
      if (f === undefined) return new HttpResponse(null, { status: 404 });
      return new HttpResponse(new Uint8Array(f.bytes), {
        headers: { "content-type": "application/octet-stream" },
      });
    }),

    http.get(`${origin}/creators`, ({ request }) => {
      if (!authorised(request)) return unauthorised();
      return page("creators", data.creators, new URL(request.url), (c) => ({
        "@id": `/creators/${c.id}`,
        name: c.name,
      }));
    }),

    http.get(`${origin}/creators/:id`, ({ request, params }) => {
      if (!authorised(request)) return unauthorised();
      const c = data.creators.find((x) => x.id === String(params.id));
      if (c === undefined) return new HttpResponse(null, { status: 404 });
      return json("/creators/{id}", {
        "@context": ["https://schema.org/"],
        "@id": link(`/creators/${c.id}`),
        "@type": "Organization",
        name: c.name,
        slug: c.id,
      });
    }),

    http.get(`${origin}/collections`, ({ request }) => {
      if (!authorised(request)) return unauthorised();
      return page("collections", data.collections, new URL(request.url), (c) => ({
        "@id": `/collections/${c.id}`,
        name: c.name,
      }));
    }),

    http.get(`${origin}/collections/:id`, ({ request, params }) => {
      if (!authorised(request)) return unauthorised();
      const c = data.collections.find((x) => x.id === String(params.id));
      if (c === undefined) return new HttpResponse(null, { status: 404 });
      return json("/collections/{id}", {
        "@context": ["https://schema.org/"],
        "@id": link(`/collections/${c.id}`),
        "@type": "Collection",
        name: c.name,
      });
    }),
  ];

  // Every documented method other than GET: recorded and refused. A GET the
  // handlers above do not serve (nodeinfo, oembed, groups, raw) is left
  // unhandled, so the importer reaching for it fails the test.
  for (const [path, methods] of documentedPaths()) {
    const mswPath = `${origin}${path.replace(/\{([^}]+)\}/g, ":$1")}`;
    for (const method of methods) {
      if (method === "get") continue;
      const verb = method as "post" | "put" | "patch" | "delete" | "head" | "options";
      handlers.push(
        http[verb](mswPath, ({ request }) => {
          writes.push(`${request.method} ${new URL(request.url).pathname}`);
          return new HttpResponse(null, { status: 405 });
        }),
      );
    }
  }

  return {
    handlers,
    accessToken,
    tokenRequests,
    objectRequests,
    signedQueries,
    writes,
  };
}

export type ManyfoldStub = ReturnType<typeof createManyfoldStub>;
