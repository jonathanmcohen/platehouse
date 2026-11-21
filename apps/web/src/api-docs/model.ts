// What the API reference page shows, read out of the Public API v1's
// OpenAPI document (./openapi.json, written by the server's test
// apps/server/test/api/openapi.test.ts from the routes themselves, so it is
// always the API this build serves). Plain functions with no React, so the
// page stays a thin view and these are tested on their own.
//
// - Operations are grouped by their tag, in the order of the document's
//   tags list, each group's operations in document order.
// - A HEAD that Fastify answers for a GET route is not listed on its own:
//   the GET says HEAD answers the same headers with no body. A HEAD with a
//   meaning of its own (the tus resume check) is listed.
// - A schema becomes a list of fields, nested for objects and arrays, each
//   with its type, whether it is required or may be null, its limits and its
//   description, so the page renders shapes without knowing JSON Schema.

/** The parts of a JSON Schema the page reads. */
export interface Schema {
  type?: string;
  format?: string;
  description?: string;
  nullable?: boolean;
  enum?: unknown[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  additionalProperties?: boolean | Schema;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  example?: unknown;
}

export interface Media {
  schema?: Schema;
  example?: unknown;
  examples?: Record<string, { summary?: string; value?: unknown }>;
}

export interface Parameter {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  schema?: Schema;
  example?: unknown;
}

export interface ResponseDoc {
  description?: string;
  headers?: Record<string, { description?: string; schema?: Schema }>;
  content?: Record<string, Media>;
}

export interface OperationDoc {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: Parameter[];
  requestBody?: { description?: string; content?: Record<string, Media> };
  responses?: Record<string, ResponseDoc>;
}

export interface ApiDocument {
  openapi: string;
  info: { title: string; version: string; description?: string };
  tags?: Array<{ name: string; description?: string }>;
  paths: Record<string, Record<string, OperationDoc>>;
  components?: {
    securitySchemes?: Record<string, { description?: string; scheme?: string }>;
  };
}

/** One operation as the page lists it. */
export interface Operation {
  /** A stable id for the page's anchors: the operationId. */
  id: string;
  method: string;
  path: string;
  summary: string;
  description: string;
  /** True when Fastify also answers HEAD on this path with the same headers. */
  alsoHead: boolean;
  parameters: Parameter[];
  requestBody: Array<{ type: string; media: Media; description: string }>;
  responses: Array<{ code: string; response: ResponseDoc }>;
}

export interface Group {
  /** An id for the group's heading, made from its name. */
  id: string;
  name: string;
  description: string;
  operations: Operation[];
}

/** The order methods are listed in on one path. */
const METHOD_ORDER = ["get", "head", "post", "put", "patch", "delete"];

/** An id for an anchor: lower case, letters and digits, words joined by "-". */
export function anchorId(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** The operations of the document grouped by tag, in the document's tag order. */
export function groupOperations(doc: ApiDocument): Group[] {
  const groups = new Map<string, Group>();
  for (const tag of doc.tags ?? []) {
    groups.set(tag.name, {
      id: `api-${anchorId(tag.name)}`,
      name: tag.name,
      description: tag.description ?? "",
      operations: [],
    });
  }
  for (const [path, item] of Object.entries(doc.paths)) {
    const methods = Object.keys(item)
      .filter((m) => METHOD_ORDER.includes(m))
      .sort((a, b) => METHOD_ORDER.indexOf(a) - METHOD_ORDER.indexOf(b));
    for (const method of methods) {
      const op = item[method];
      if (op === undefined) continue;
      // A HEAD that only mirrors a GET is folded into the GET.
      if (method === "head" && item.get !== undefined) continue;
      const tag = op.tags?.[0] ?? "Other";
      let group = groups.get(tag);
      if (group === undefined) {
        group = { id: `api-${anchorId(tag)}`, name: tag, description: "", operations: [] };
        groups.set(tag, group);
      }
      group.operations.push({
        id: op.operationId ?? anchorId(`${method} ${path}`),
        method: method.toUpperCase(),
        path,
        summary: op.summary ?? "",
        description: op.description ?? "",
        alsoHead: method === "get" && item.head !== undefined,
        parameters: op.parameters ?? [],
        requestBody: Object.entries(op.requestBody?.content ?? {}).map(([type, media]) => ({
          type,
          media,
          description: op.requestBody?.description ?? media.schema?.description ?? "",
        })),
        responses: Object.entries(op.responses ?? {})
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([code, response]) => ({ code, response })),
      });
    }
  }
  return [...groups.values()].filter((g) => g.operations.length > 0);
}

/** One field of a schema, flattened for display; depth is its nesting. */
export interface Field {
  name: string;
  depth: number;
  type: string;
  required: boolean;
  nullable: boolean;
  description: string;
  /** Limits and allowed values, as short phrases. */
  rules: string[];
}

/** A schema's type as a reader says it: "string", "array of object", "binary". */
export function typeLabel(schema: Schema): string {
  if (schema.format === "binary") return "binary";
  if (schema.type === "array") {
    return schema.items === undefined ? "array" : `array of ${typeLabel(schema.items)}`;
  }
  const base = schema.type ?? "any";
  return schema.format !== undefined && schema.format !== "binary"
    ? `${base} (${schema.format})`
    : base;
}

/** A schema's limits as short phrases, such as "1 to 100 characters" or "one of: a, b". */
export function rulesOf(schema: Schema): string[] {
  const rules: string[] = [];
  const values = (schema.enum ?? []).filter((v) => v !== null);
  if (values.length === 1) rules.push(`always ${String(values[0])}`);
  else if (values.length > 1) rules.push(`one of: ${values.map(String).join(", ")}`);
  const range = (min: number | undefined, max: number | undefined, unit: string) => {
    if (min !== undefined && max !== undefined) rules.push(`${min} to ${max}${unit}`);
    else if (max !== undefined) rules.push(`at most ${max}${unit}`);
    else if (min !== undefined && min > 0) rules.push(`at least ${min}${unit}`);
  };
  range(schema.minLength, schema.maxLength, " characters");
  range(schema.minimum, schema.maximum, "");
  range(schema.minItems, schema.maxItems, " items");
  if (schema.pattern === "\\S") rules.push("not blank");
  return rules;
}

/**
 * A schema's fields, depth first: an object's properties, an array's item
 * fields one level down. A schema that is not an object (a string body, an
 * array of strings) has no fields; typeLabel names it.
 */
export function fieldsOf(schema: Schema | undefined, depth = 0): Field[] {
  if (schema === undefined) return [];
  const target = schema.type === "array" && schema.items !== undefined ? schema.items : schema;
  const required = new Set(target.required ?? []);
  const fields: Field[] = [];
  for (const [name, prop] of Object.entries(target.properties ?? {})) {
    fields.push({
      name,
      depth,
      type: typeLabel(prop),
      required: required.has(name),
      nullable: prop.nullable === true,
      description: prop.description ?? "",
      rules: rulesOf(prop),
    });
    const inner = prop.type === "array" ? prop.items : prop;
    if (inner?.properties !== undefined) fields.push(...fieldsOf(inner, depth + 1));
  }
  return fields;
}

/** A media type's examples, each with an optional label. */
export function examplesOf(media: Media): Array<{ label: string; text: string }> {
  if (media.example !== undefined) return [{ label: "", text: exampleText(media.example) }];
  return Object.entries(media.examples ?? {}).map(([key, ex]) => ({
    label: ex.summary ?? key,
    text: exampleText(ex.value),
  }));
}

/** An example as the page prints it: JSON indented, text as it is. */
export function exampleText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

/** A parameter's place, as a reader says it. */
export function placeLabel(where: string): string {
  if (where === "query") return "query";
  if (where === "path") return "path";
  if (where === "header") return "header";
  return where;
}

/** Text split into paragraphs on blank lines. */
export function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== "");
}
