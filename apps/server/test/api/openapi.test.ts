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
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PLATE_NUMBERS_DOC, registerOpenApi } from "../../src/api/openapi.js";
import { TOKEN_PREFIX } from "../../src/api/tokens.js";
import { apiUploadHook, refusingApi, registerV1 } from "../../src/api/v1.js";
import type {
  FilamentNumbers,
  Numbers,
  PlateFailure,
  PlatehouseNumbers,
  PlateNumbers,
} from "../../src/estimates/display.js";
import { SCRUB_MAX_CHARS } from "../../src/scrub.js";
import {
  DISK_FULL_MESSAGE,
  MAX_UPLOAD_BYTES,
  REQUEST_TIMEOUT_MS,
  registerTus,
  SLOW_LINK_BYTES_PER_SECOND,
  TEMP_TOTAL_MESSAGE,
  TOO_MANY_UPLOADS_MESSAGE,
} from "../../src/uploads/tus.js";
import { readyUploads } from "../support/uploads.js";
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

/** The upload cap as the document and the guide write it, from the cap tus enforces. */
const UPLOAD_CAP = `${MAX_UPLOAD_BYTES} bytes (${MAX_UPLOAD_BYTES / 2 ** 20} MiB)`;

/** How long one request may take, as the document and the guide write it, from the request timeout. */
const REQUEST_LIMIT =
  `about ${Math.round(REQUEST_TIMEOUT_MS / 60_000)} minutes, enough to send ` +
  `${MAX_UPLOAD_BYTES / 2 ** 20} MiB at ${(SLOW_LINK_BYTES_PER_SECOND * 8) / 1_000_000} Mbit/s`;

// The plate numbers the document shows (PLATE_NUMBERS_DOC) have exactly the
// fields the API serializes (estimates/display.ts), checked by tsc: a field
// added to or dropped from either side fails the type check (issue #280).
// The integration test (test/integration/api/api.test.ts) checks the same
// against a real plate's numbers.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type DocProps<T> = T extends { properties: infer P } ? keyof P : never;
type FileSet = (typeof PLATE_NUMBERS_DOC.properties)["file"];
type HouseSet = (typeof PLATE_NUMBERS_DOC.properties)["platehouse"];
type FailureSet = (typeof PLATE_NUMBERS_DOC.properties)["failure"];
type FilamentSet = FileSet["properties"]["filaments"]["items"];
const shapesAgree: [
  Same<keyof typeof PLATE_NUMBERS_DOC.properties, keyof PlateNumbers>,
  Same<DocProps<FileSet>, keyof Numbers>,
  Same<DocProps<HouseSet>, keyof PlatehouseNumbers>,
  Same<DocProps<FailureSet>, keyof PlateFailure>,
  Same<DocProps<FilamentSet>, keyof FilamentNumbers>,
] = [true, true, true, true, true];

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
    uploads: await readyUploads(tmp),
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

  test.each([
    ["/models/{id}", "get", "summary", "no summary"],
    ["/models/{id}", "get", "404", "takes a path parameter but 404 is not documented"],
    ["/models", "post", "400", "takes a body or query parameters but 400 is not documented"],
    ["/models", "get", "400", "takes a body or query parameters but 400 is not documented"],
    ["/uploads/{id}", "patch", "404", "takes a path parameter but 404 is not documented"],
    ["/models/{id}", "get", "414", "takes a path parameter but 414 is not documented"],
    ["/uploads/{id}", "head", "414", "takes a path parameter but 414 is not documented"],
    [
      "/collections/{name}/models/{id}",
      "delete",
      "414",
      "takes a path parameter but 414 is not documented",
    ],
    ["/models/{id}/tags/{tag}", "put", "401", "401 is not documented"],
  ])("a %s %s that loses its %s is caught", (path, method, what, line) => {
    const broken = structuredClone(doc);
    const op = broken.paths[path]?.[method];
    expect(op, `${method} ${path}`).toBeDefined();
    if (op === undefined) return;
    if (what === "summary") delete op.summary;
    else delete op.responses?.[what];
    expect(problems(broken)).toContain(`${method.toUpperCase()} ${path}: ${line}`);
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
      // Same answers, each with the GET's headers and no body (issue #261).
      expect(Object.keys(head.responses ?? {}), path).toEqual(Object.keys(get.responses ?? {}));
      for (const [code, answer] of Object.entries(get.responses ?? {})) {
        const headAnswer = head.responses?.[code];
        expect(headAnswer?.content, `HEAD ${path} ${code}`).toBeUndefined();
        expect(headAnswer?.headers, `HEAD ${path} ${code}`).toEqual(answer.headers);
      }
    }
    const content = doc.paths["/files/{id}/content"]?.head?.responses;
    expect(Object.keys(content?.["200"]?.headers ?? {})).toEqual([
      "Content-Disposition",
      "Content-Length",
    ]);
    expect(Object.keys(content?.["401"]?.headers ?? {})).toEqual(["WWW-Authenticate"]);
  });

  test("a response header written in the wrong form is caught", () => {
    const broken = structuredClone(doc);
    const answer = broken.paths["/uploads"]?.post?.responses?.["201"];
    expect(answer?.headers?.Location).toBeDefined();
    if (answer?.headers !== undefined) {
      // What @fastify/swagger makes of a header given as {description, schema}.
      answer.headers.Location = { description: "x", schema: { schema: { type: "string" } } };
    }
    expect(problems(broken)).toContain("POST /uploads 201: header Location has no typed schema");
  });

  test("every operation with a path parameter documents the router's 414, in its real shape", () => {
    let withParams = 0;
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(item)) {
        const hasPath = (op.parameters ?? []).some((p) => p.in === "path");
        const answer = op.responses?.["414"];
        if (!hasPath) {
          expect(answer, `${method} ${path}`).toBeUndefined();
          continue;
        }
        withParams += 1;
        expect(answer?.description, `${method} ${path}`).toMatch(/100 characters/);
        if (method === "head") continue;
        expect(answer?.content?.["application/json"]?.example, `${method} ${path}`).toEqual({
          error: "URI Too Long",
          code: "FST_ERR_MAX_PARAM_LENGTH",
          statusCode: 414,
        });
      }
    }
    expect(withParams).toBeGreaterThan(10);
    // A tag or collection name over 100 characters is the 414, so the 400
    // does not claim it.
    const tag400 = doc.paths["/models/{id}/tags/{tag}"]?.put?.responses?.["400"]?.description;
    expect(tag400).not.toMatch(/100/);
  });

  test("gives the upload cap tus enforces, MAX_UPLOAD_BYTES, wherever it states one", () => {
    const create = doc.paths["/uploads"]?.post;
    const length = create?.parameters?.find((p) => p.in === "header" && p.name === "upload-length");
    expect(length?.schema?.maximum).toBe(MAX_UPLOAD_BYTES);
    expect(length?.description).toBe(`The file's size in bytes, at most ${MAX_UPLOAD_BYTES}`);
    expect(create?.description).toContain(`Upload-Length, at most ${UPLOAD_CAP}.`);
    expect(create?.responses?.["413"]?.description).toBe(
      `Upload-Length is over ${MAX_UPLOAD_BYTES} bytes`,
    );
  });

  test("lists the limits on unfinished uploads among the upload creation's answers", () => {
    const answers = doc.paths["/uploads"]?.post?.responses ?? {};
    expect(answers["429"]?.description).toMatch(/20 unfinished uploads/);
    expect(answers["507"]?.description).toMatch(/UPLOAD_TEMP_MAX_BYTES/);
    expect(answers["507"]?.description).toMatch(/1 GiB/);
  });

  test("the 507 shows each of its sentences: the total's, the disk's and the folder's", () => {
    const media = doc.paths["/uploads"]?.post?.responses?.["507"]?.content?.["text/plain"];
    const values = Object.values(media?.examples ?? {}).map((e) => (e as { value: unknown }).value);
    expect(values).toEqual([
      `${TEMP_TOTAL_MESSAGE}\n`,
      `${DISK_FULL_MESSAGE}\n`,
      `${TOO_MANY_UPLOADS_MESSAGE}\n`,
    ]);
  });

  test("states an unfinished upload's lifetime wherever it states one", () => {
    // 24 hours after it was created, whatever arrives, or an hour with no byte.
    const create = doc.paths["/uploads"]?.post;
    const texts = [
      create?.description,
      create?.responses?.["429"]?.description,
      doc.paths["/uploads/{id}"]?.head?.description,
      doc.paths["/uploads/{id}"]?.head?.responses?.["404"]?.description,
      doc.paths["/uploads/{id}"]?.patch?.responses?.["404"]?.description,
    ];
    for (const text of texts) {
      expect(text).toMatch(/24 hours after it was created/);
      expect(text).toMatch(/an hour/);
    }
  });

  test("shows a plate's numbers with the fields the API sends, printerName included", () => {
    expect(shapesAgree).toEqual([true, true, true, true, true]);
    const file = PLATE_NUMBERS_DOC.properties.file;
    // Every field of a set is always sent (a missing value is null).
    expect([...file.required].sort()).toEqual(Object.keys(file.properties).sort());
    expect(file.required).toContain("printerName");
    const house = PLATE_NUMBERS_DOC.properties.platehouse;
    expect([...house.required].sort()).toEqual(
      Object.keys(house.properties)
        .filter((k) => k !== "staleFor")
        .sort(),
    );
    // The document's example has every field of a set.
    const example = doc.paths["/models/{id}"]?.get?.responses?.["200"]?.content?.[
      "application/json"
    ]?.example as { files: Array<{ plates: Array<{ numbers: { file: object } }> }> };
    expect(Object.keys(example.files[0]?.plates[0]?.numbers.file ?? {}).sort()).toEqual(
      Object.keys(file.properties).sort(),
    );
    // My printers (#240): the numbers are the default printer's, never "the selected printer".
    const text = JSON.stringify(doc);
    expect(text).not.toMatch(/selected printer|printer selected|chosen in Settings/i);
    expect(text).toMatch(/default printer of My printers/);
    expect(PLATE_NUMBERS_DOC.properties.failure.properties.detail.description).toContain(
      `at most ${SCRUB_MAX_CHARS} characters`,
    );
  });

  // Issue #380 (the maintainer, 2026-11-22): derivedStatus keeps its 0.1.0
  // meaning, and a file's preview picture is reported as previewStatus and
  // previewMessage beside it, always sent. Issue #501 corrected the words of
  // the derivedStatus description in 0.1.2; the meaning did not change.
  test("a file keeps derivedStatus with its 0.1.0 meaning and documents previewStatus and previewMessage", () => {
    const example = doc.paths["/files/{id}"]?.get?.responses?.["200"]?.content?.[
      "application/json"
    ] as { schema: Record<string, unknown>; example: Record<string, unknown> } | undefined;
    const schema = example?.schema as {
      properties: Record<string, { description?: string; type?: unknown; enum?: unknown }>;
      required: string[];
    };
    expect(schema.properties.derivedStatus?.description).toBe(
      "For .scad files, the OpenSCAD render; for STEP files, the conversion to a mesh: pending, ok or failed. Null for STL and 3MF files. The preview picture is previewStatus.",
    );
    expect(schema.properties.previewStatus?.description).toMatch(/STL and STEP/);
    expect(schema.properties.previewStatus?.description).toMatch(/pending, ok or failed/);
    expect(schema.properties.previewMessage?.description).toMatch(/why/i);
    expect(schema.required).toEqual(expect.arrayContaining(["previewStatus", "previewMessage"]));
    expect(example?.example).toMatchObject({ previewStatus: null, previewMessage: null });
  });

  test("states the request time limit and the upload cap from the constants the server uses", () => {
    expect(doc.paths["/uploads/{id}"]?.patch?.description).toContain(
      `A single request may take up to ${REQUEST_LIMIT}.`,
    );
    expect(doc.info.description).toContain(`uploads are at most ${UPLOAD_CAP}.`);
    // The upload cap is written as "N MiB" nowhere else in the document, so
    // a hand-typed copy of it cannot drift. (Only the MiB figure is counted;
    // the request time limit is checked by the line above, not here.)
    const text = JSON.stringify(doc);
    const mib = `${MAX_UPLOAD_BYTES / 2 ** 20} MiB`;
    expect(text.split(mib).length - 1).toBe(
      text.split(`(${mib})`).length - 1 + (text.split(`send ${mib}`).length - 1),
    );
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

/** The upload requests docs/api.md's "What each answer means" table lists, in its order. */
const UPLOAD_OPERATIONS = [
  ["POST", "/uploads"],
  ["HEAD", "/uploads/{id}"],
  ["PATCH", "/uploads/{id}"],
  ["GET", "/uploads/{id}/result"],
] as const;

/** The rows of the markdown table under a heading: each row's cells, trimmed, backticks off. */
function tableUnder(markdown: string, heading: string): string[][] {
  const start = markdown.indexOf(`\n${heading}\n`);
  expect(start, heading).toBeGreaterThan(-1);
  const rows: string[][] = [];
  let inTable = false;
  for (const line of markdown.slice(start + heading.length + 2).split("\n")) {
    if (line.startsWith("#")) break;
    if (!line.startsWith("|")) {
      if (inTable) break;
      continue;
    }
    inTable = true;
    const cells = line
      .slice(1, -1)
      .split("|")
      .map((c) => c.trim().replace(/^`|`$/g, ""));
    if (cells.every((c) => /^-+$/.test(c))) continue;
    rows.push(cells);
  }
  return rows;
}

/** The bodies of the markdown's ```sh fenced blocks, in order. */
function shBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/^```sh\n([\s\S]*?)^```$/gm)].map((m) => m[1] ?? "");
}

describe("docs/api.md", () => {
  const guide = readFileSync(join(ROOT, "docs/api.md"), "utf8");

  test("its upload status table is every upload answer, in the OpenAPI document's words", () => {
    const expected: string[][] = [["Request", "Status", "What it means"]];
    for (const [method, path] of UPLOAD_OPERATIONS) {
      const responses = doc.paths[path]?.[method.toLowerCase()]?.responses ?? {};
      expect(Object.keys(responses).length, `${method} ${path}`).toBeGreaterThan(3);
      for (const code of Object.keys(responses).sort()) {
        expected.push([`${method} ${path}`, code, responses[code]?.description ?? ""]);
      }
    }
    expect(tableUnder(guide, "### What each answer means")).toEqual(expected);
  });

  test("the reader cannot learn a wrong 410 or 404 from the table", () => {
    // The two meanings the review found wrong (issues #275, #276): a 410 is
    // never an expired upload, and an expired upload is a 404.
    const rows = tableUnder(guide, "### What each answer means");
    const meaning = (request: string, code: string) =>
      rows.find((r) => r[0] === request && r[1] === code)?.[2] ?? "";
    for (const request of ["HEAD /uploads/{id}", "PATCH /uploads/{id}"]) {
      expect(meaning(request, "410"), request).not.toMatch(/24 hours|expired/i);
      expect(meaning(request, "404"), request).toMatch(/24 hours/);
    }
    expect(meaning("PATCH /uploads/{id}", "503")).toMatch(/upload was removed/);
    // @tus/server also answers 400 when another request takes this upload's
    // lock mid-PATCH (@tus/utils ERRORS.ABORTED), which is not a bad header (issue #261).
    expect(meaning("PATCH /uploads/{id}", "400")).toMatch(/another request on this upload/);
  });

  test("its limit rows give the upload cap tus enforces, MAX_UPLOAD_BYTES", () => {
    // The 413 row is held to the document's words by the status table test.
    const limit = (heading: string, what: string) =>
      tableUnder(guide, heading).find((r) => r[0] === what)?.[1];
    expect(limit("## Limits", "An uploaded file")).toBe(UPLOAD_CAP);
    expect(limit("## Limits", "One request")).toBe(REQUEST_LIMIT);
    expect(limit("### Resumable and chunked uploads: use a tus client", "Size")).toBe(
      `at most ${UPLOAD_CAP}`,
    );
  });

  test("its token setup runs in any POSIX sh, dash included, and exports the token", () => {
    // Every example depends on this block, and it is fenced as sh. dash, which
    // is /bin/sh on Debian and Ubuntu, refuses bash's `read -s` and leaves the
    // token empty, so every example then answers 401 (PR #235 review). POSIX
    // read takes -r and nothing else; the hidden prompt is stty's job.
    const setup = shBlocks(guide).find((block) => block.includes("PLATEHOUSE_TOKEN"));
    expect(setup, "the sh block that sets PLATEHOUSE_TOKEN").toBeDefined();
    const reads = [...(setup ?? "").matchAll(/(?:^|[;&|])\s*read\b([^;&|#\n]*)/gm)];
    expect(reads.length).toBeGreaterThan(0);
    for (const [, args] of reads) {
      for (const option of (args ?? "")
        .trim()
        .split(/\s+/)
        .filter((a) => a.startsWith("-"))) {
        expect(option, "a POSIX read option").toBe("-r");
      }
    }
    // Run it, with the token on stdin, under /bin/sh and under dash where this
    // machine has it (CI runs on Ubuntu, where /bin/sh is dash). With stdin a pipe stty
    // complains on stderr, which the block survives.
    const shells = ["/bin/sh", "/bin/dash"].filter((shell) => existsSync(shell));
    for (const shell of shells) {
      const out = execFileSync(
        shell,
        ["-c", `${setup}\nprintf '<%s>' "$(printenv PLATEHOUSE_TOKEN)"`],
        { input: `${TOKEN_PREFIX}example\n`, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
      );
      expect(out, shell).toMatch(new RegExp(`<${TOKEN_PREFIX}example>$`));
    }
  });

  test("it no longer documents a hand-written resumable client in shell", () => {
    expect(guide).not.toMatch(/platehouse-upload\.sh|give_up|CHUNK=/);
    expect(guide).toMatch(/tus-js-client/);
    expect(guide).toMatch(/tuspy/);
  });
});
