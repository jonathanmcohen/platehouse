// The recorded Manyfold API description and a small checker for it.
//
// test/fixtures/manyfold-openapi-0.154.1.json is app/api/v0/openapi.json
// from Manyfold's public source at tag v0.154.1 (commit d8bccfe), the version
// Jon runs. Its content is upstream's unchanged; only the whitespace is the
// repo's Biome formatting. Upstream's file has sha256
// 7ca71106280aac4af8172bdc8c46966c0cdc9a87f753fe03f1ca08899314c0e1; the pin
// below is the sha256 of JSON.stringify(JSON.parse(file)), which is the same
// for upstream's bytes and the formatted copy, and changes with any edit to a
// value. Manyfold is AGPL-3.0. The document was read from the source, never
// from the live server.
//
// The Manyfold stub (manyfold-stub.ts) registers handlers only for the paths
// this document lists, and checks every JSON body it serves against the
// document's response schema, so the importer is tested against the shapes
// Manyfold documents rather than shapes the tests made up. The checker covers
// the parts of OpenAPI 3.0 the document uses: $ref, type, properties,
// required, items, enum and nullable.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const OPENAPI_PATH = join(
  import.meta.dirname,
  "..",
  "fixtures",
  "manyfold-openapi-0.154.1.json",
);

/** sha256 of JSON.stringify(JSON.parse(app/api/v0/openapi.json)) at Manyfold v0.154.1. */
export const OPENAPI_SHA256 = "6912fc0187d3dba6b9a0f4a725ff23c674cee35599cb7d8aaf0fb45001d18b74";

const raw = readFileSync(OPENAPI_PATH, "utf8");

/** The same digest of the fixture, to compare with OPENAPI_SHA256. */
export const openapiSha256 = createHash("sha256")
  .update(JSON.stringify(JSON.parse(raw)))
  .digest("hex");

type Schema = {
  $ref?: string;
  type?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: unknown[];
  nullable?: boolean;
};

type Operation = {
  responses?: Record<string, { content?: Record<string, { schema?: Schema }> }>;
};

export const openapi = JSON.parse(raw) as {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Schema> };
};

/** The JSON media type Manyfold answers with. */
export const V0 = "application/vnd.manyfold.v0+json";

/** The document's paths with their methods, e.g. ["/models/{id}", ["delete", "get", "patch"]]. */
export function documentedPaths(): Array<[string, string[]]> {
  return Object.entries(openapi.paths).map(([path, ops]) => [
    path,
    Object.keys(ops).filter((k) => k !== "parameters"),
  ]);
}

function resolve(schema: Schema): Schema {
  let s = schema;
  while (s.$ref !== undefined) {
    const name = s.$ref.replace("#/components/schemas/", "");
    const next = openapi.components.schemas[name];
    if (next === undefined) throw new Error(`openapi: no schema ${s.$ref}`);
    s = next;
  }
  return s;
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

/** Problems with value against schema, as "path: problem" lines; empty when it conforms. */
export function check(schema: Schema, value: unknown, at = "$"): string[] {
  const s = resolve(schema);
  if (value === null) return s.nullable === true ? [] : [`${at}: null`];
  const problems: string[] = [];
  if (s.type !== undefined) {
    const actual = typeOf(value);
    const ok = actual === s.type || (s.type === "number" && actual === "integer");
    if (!ok) return [`${at}: ${actual}, documented as ${s.type}`];
  }
  if (s.enum !== undefined && !s.enum.includes(value)) {
    problems.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(s.enum)}`);
  }
  if (typeOf(value) === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of s.required ?? []) {
      if (!(key in obj)) problems.push(`${at}: missing required ${key}`);
    }
    for (const [key, sub] of Object.entries(s.properties ?? {})) {
      if (key in obj) problems.push(...check(sub, obj[key], `${at}.${key}`));
    }
  }
  if (Array.isArray(value) && s.items !== undefined) {
    const items = s.items;
    value.forEach((item, i) => {
      problems.push(...check(items, item, `${at}[${i}]`));
    });
  }
  return problems;
}

/** The documented 200 schema of a GET, for the JSON media type. */
export function responseSchema(path: string): Schema {
  const schema = openapi.paths[path]?.get?.responses?.["200"]?.content?.[V0]?.schema;
  if (schema === undefined)
    throw new Error(`openapi: no documented 200 ${V0} body for GET ${path}`);
  return schema;
}

/** Throws when body does not conform to the documented 200 body of GET path. */
export function assertDocumented(path: string, body: unknown): void {
  const problems = check(responseSchema(path), body);
  if (problems.length > 0) {
    throw new Error(
      `stub body for GET ${path} breaks the recorded OpenAPI:\n${problems.join("\n")}`,
    );
  }
}
