// What a complete Public API v1 description holds, checked by the unit test
// (test/api/openapi.test.ts, the v1 routes on a bare Fastify app) and by the
// integration test (test/integration/api/api.test.ts, the whole app), so a
// route added anywhere under /api/v1 without its documentation fails one of
// them. problems() returns one line per gap, empty when there is none.

export interface MediaDoc {
  schema?: Record<string, unknown>;
  example?: unknown;
  examples?: Record<string, unknown>;
}

export interface ResponseDoc {
  description?: string;
  content?: Record<string, MediaDoc>;
  headers?: Record<string, { description?: string; schema?: unknown }>;
}

export interface ParameterDoc {
  name: string;
  in: string;
  description?: string;
  schema?: Record<string, unknown>;
  example?: unknown;
}

export interface OperationDoc {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: ParameterDoc[];
  requestBody?: { description?: string; content?: Record<string, MediaDoc> };
  responses?: Record<string, ResponseDoc>;
}

export interface OpenApiDoc {
  openapi: string;
  info: { title: string; version: string; description?: string };
  servers: Array<{ url: string }>;
  tags?: Array<{ name: string; description?: string }>;
  paths: Record<string, Record<string, OperationDoc>>;
  components: {
    securitySchemes?: Record<
      string,
      { type: string; scheme?: string; bearerFormat?: string; description?: string }
    >;
  };
  security?: Array<Record<string, unknown>>;
}

/** The HTTP methods an OpenAPI path item can hold. */
export const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

/** @fastify/swagger's text for a response nobody described. */
const DEFAULT_RESPONSE = "Default Response";

function hasExample(media: MediaDoc): boolean {
  return (
    media.example !== undefined ||
    (media.examples !== undefined && Object.keys(media.examples).length > 0)
  );
}

/** Every gap in the document, one line each; empty when it is complete. */
export function problems(doc: OpenApiDoc): string[] {
  const found: string[] = [];
  const tagNames = new Set((doc.tags ?? []).map((t) => t.name));
  for (const tag of doc.tags ?? []) {
    if (!tag.description) found.push(`tag ${tag.name}: no description`);
  }
  const bearer = doc.components.securitySchemes?.bearer;
  if (bearer === undefined) found.push("no bearer security scheme");
  else if (!bearer.description || !bearer.bearerFormat) {
    found.push("bearer security scheme: no description or bearerFormat");
  }
  if (!doc.info.description) found.push("info: no description");

  const ids = new Map<string, string>();
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!METHODS.includes(method)) continue;
      const where = `${method.toUpperCase()} ${path}`;
      if (!op.summary?.trim()) found.push(`${where}: no summary`);
      if (!op.description?.trim()) found.push(`${where}: no description`);
      if (!op.operationId) found.push(`${where}: no operationId`);
      else if (ids.has(op.operationId)) {
        found.push(`${where}: operationId ${op.operationId} is also ${ids.get(op.operationId)}`);
      } else ids.set(op.operationId, where);
      if (!op.tags?.length) found.push(`${where}: no tag`);
      for (const tag of op.tags ?? []) {
        if (!tagNames.has(tag)) found.push(`${where}: tag ${tag} is not in the document's tags`);
      }

      for (const param of op.parameters ?? []) {
        if (!param.description?.trim()) {
          found.push(`${where}: ${param.in} parameter ${param.name} has no description`);
        }
        if (param.schema === undefined) {
          found.push(`${where}: ${param.in} parameter ${param.name} has no schema`);
        }
      }

      if (op.requestBody !== undefined) {
        const content = Object.entries(op.requestBody.content ?? {});
        if (content.length === 0) found.push(`${where}: request body with no content`);
        for (const [type, media] of content) {
          if (media.schema === undefined) found.push(`${where}: ${type} body has no schema`);
          if (!hasExample(media) && type === "application/json") {
            found.push(`${where}: ${type} body has no example`);
          }
        }
      }

      const responses = Object.entries(op.responses ?? {});
      const codes = responses.map(([code]) => code);
      if (!codes.includes("401")) found.push(`${where}: 401 is not documented`);
      if (!codes.some((c) => c !== "401" && /^[45]/.test(c))) {
        found.push(`${where}: no error response besides 401`);
      }
      if (!codes.some((c) => c.startsWith("2"))) found.push(`${where}: no success response`);
      if (!codes.includes("500")) found.push(`${where}: 500 is not documented`);
      if (!codes.includes("503")) found.push(`${where}: 503 is not documented`);

      let examples = 0;
      for (const [code, response] of responses) {
        if (!response.description?.trim() || response.description === DEFAULT_RESPONSE) {
          found.push(`${where} ${code}: no description`);
        }
        // A HEAD answer has no body; everything else that is not 204 or
        // a tus answer with no body carries a schema and an example.
        // A file's bytes (format binary) have no example to give.
        for (const [type, media] of Object.entries(response.content ?? {})) {
          if (media.schema === undefined) found.push(`${where} ${code} ${type}: no schema`);
          if (hasExample(media)) examples += 1;
          else if (method !== "head" && media.schema?.format !== "binary") {
            found.push(`${where} ${code} ${type}: no example`);
          }
        }
      }
      const bodyExample = Object.values(op.requestBody?.content ?? {}).some(hasExample);
      const paramExample = (op.parameters ?? []).some((p) => p.example !== undefined);
      if (method !== "head" && examples === 0 && !bodyExample && !paramExample) {
        found.push(`${where}: no example anywhere`);
      }
    }
  }
  return found;
}

/** The document's path for a Fastify route path: no prefix, no trailing slash, {param}. */
export function documentedPath(route: string): string {
  return route
    .slice("/api/v1".length)
    .replace(/\/$/, "")
    .replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}
