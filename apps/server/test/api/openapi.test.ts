// The Public API v1's OpenAPI description is complete, without Docker. The
// v1 routes and the tus upload mount are registered on a bare Fastify app
// exactly as app.ts registers them, and the document @fastify/swagger builds
// from them must give every operation a summary, a description, a tag, its
// parameters described, its request body with an example, its 401 and at
// least one other error response, and every response a description, a
// schema and an example (support/openapi-rules.ts). The integration test
// (test/integration/api/api.test.ts) applies the same rules to the whole
// app.
//
// The document is also written, as the web app reads it, to
// apps/web/src/api-docs/openapi.json: the API page in Settings renders that
// copy, because a browser session cannot read GET /api/v1/openapi.json,
// which takes a token. The copy must match what this code generates; after
// a route or its schema changes, run `pnpm exec vitest run --project unit
// -u apps/server/test/api/openapi.test.ts` and commit the new copy.
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { registerOpenApi } from "../../src/api/openapi.js";
import { TOKEN_PREFIX } from "../../src/api/tokens.js";
import { apiUploadHook, refusingApi, registerV1 } from "../../src/api/v1.js";
import { createUploads, registerTus } from "../../src/uploads/tus.js";
import { documentedPath, METHODS, type OpenApiDoc, problems } from "./support/openapi-rules.js";

/** The repository's root, where biome.json is. */
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/** The web app's copy of the document. */
const WEB_COPY = "apps/web/src/api-docs/openapi.json";

/**
 * JSON as the repository's formatter writes it (biome ci checks every
 * file), so the committed copy passes lint exactly as generated.
 */
function formatted(json: string): string {
  return execFileSync(
    join(ROOT, "node_modules/.bin/biome"),
    ["format", `--stdin-file-path=${WEB_COPY}`],
    {
      cwd: ROOT,
      input: json,
      encoding: "utf8",
    },
  );
}

/** The origin every example and the web app's copy use; never a real host. */
const EXAMPLE_ORIGIN = "https://platehouse.example.com";

let app: FastifyInstance;
let tmp: string;
let doc: OpenApiDoc;
const routes: Array<{ method: string; url: string }> = [];

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ph-openapi-"));
  app = Fastify();
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) routes.push({ method: String(method), url: route.url });
  });
  await registerOpenApi(app, { serverUrl: `${EXAMPLE_ORIGIN}/api/v1` });
  await registerV1(app, refusingApi);
  await registerTus(app, {
    prefix: "/api/v1/uploads",
    authHook: apiUploadHook(refusingApi),
    uploads: createUploads({
      tmpDir: tmp,
      queue: { enqueue: async () => {}, result: async () => undefined },
      log: () => {},
    }),
  });
  await app.ready();
  doc = app.swagger() as unknown as OpenApiDoc;
});

afterAll(async () => {
  await app.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("the OpenAPI document", () => {
  test("has no gaps: every operation, parameter, body and response is described", () => {
    // The rules can fail: a route with a bare schema is caught.
    const bare = structuredClone(doc);
    const first = Object.values(bare.paths)[0];
    const op = first === undefined ? undefined : Object.values(first)[0];
    if (op !== undefined) {
      delete op.description;
      delete op.responses?.["404"];
      delete op.responses?.["400"];
      delete op.responses?.["409"];
      delete op.responses?.["410"];
      delete op.responses?.["413"];
      delete op.responses?.["415"];
      delete op.responses?.["412"];
      delete op.responses?.["403"];
      delete op.responses?.["501"];
      delete op.responses?.["500"];
      delete op.responses?.["503"];
    }
    const caught = problems(bare);
    expect(caught.some((line) => line.endsWith("no description"))).toBe(true);
    expect(caught.some((line) => line.endsWith("no error response besides 401"))).toBe(true);

    expect(problems(doc)).toEqual([]);
  });

  test("describes every v1 route, and nothing else", () => {
    const v1 = routes.filter((r) => r.url.startsWith("/api/v1/"));
    expect(v1.length).toBeGreaterThan(15);
    for (const route of v1) {
      const op = doc.paths[documentedPath(route.url)]?.[route.method.toLowerCase()];
      expect(op, `${route.method} ${route.url}`).toBeDefined();
    }
    const registered = new Set(v1.map((r) => `${r.method.toLowerCase()} ${documentedPath(r.url)}`));
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const method of Object.keys(item).filter((m) => METHODS.includes(m))) {
        expect(registered.has(`${method} ${path}`), `${method} ${path}`).toBe(true);
      }
    }
  });

  test("a HEAD that mirrors a GET says it answers headers only", () => {
    for (const [path, item] of Object.entries(doc.paths)) {
      const get = item.get;
      const head = item.head;
      if (get === undefined || head === undefined) continue;
      expect(head.summary, path).not.toBe(get.summary);
      expect(head.description, path).toMatch(/no body/i);
    }
  });

  test("describes the token scheme and the server from PUBLIC_ORIGIN", () => {
    expect(doc.servers).toHaveLength(1);
    expect(doc.servers[0]?.url).toBe(`${EXAMPLE_ORIGIN}/api/v1`);
    expect(doc.security).toEqual([{ bearer: [] }]);
    const bearer = doc.components.securitySchemes?.bearer;
    expect(bearer).toMatchObject({ type: "http", scheme: "bearer" });
    expect(bearer?.description).toContain(TOKEN_PREFIX);
    expect(bearer?.description).toMatch(/Settings/);
  });

  test("its examples hold no token-shaped value and no host but the example one", () => {
    const text = JSON.stringify(doc);
    // The detector works on a token-shaped string built here.
    const shaped = `${TOKEN_PREFIX}${"x".repeat(43)}`;
    const tokenShape = /ph_[A-Za-z0-9_-]{43}/;
    expect(tokenShape.test(shaped)).toBe(true);
    expect(tokenShape.test(text)).toBe(false);
    const hosts = new Set(
      [...text.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)].map((m) => m[1] as string),
    );
    expect([...hosts].sort()).toEqual(["platehouse.example.com", "tus.io"]);
  });

  test("the web app's copy is what this code generates", async () => {
    await expect(formatted(JSON.stringify(doc, null, 2))).toMatchFileSnapshot(join(ROOT, WEB_COPY));
  });
});
