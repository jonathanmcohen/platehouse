// The whole app (buildApp) with fakes: each upload mount names who creates an
// upload, so the cap on unfinished uploads (Uploads.reserve) is per session on
// /app/uploads and per API token on /api/v1/uploads. The cap itself is tested
// in tus.test.ts; this checks the names the two mounts give.
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, expect, test } from "vitest";
import { refusingApi } from "../../src/api/v1.js";
import { buildApp } from "../../src/app.js";
import { SESSION_COOKIE, type Sessions } from "../../src/auth/sessions.js";
import type { ApiToken, Session } from "../../src/db/types.js";
import type { Uploads } from "../../src/uploads/tus.js";
import { readyUploads } from "../support/uploads.js";
import { meta, TUS } from "./support/http.js";

const ORIGIN = "https://platehouse.test";
const COOKIE = "c".repeat(43);
const SESSION_ID = "S".repeat(43);
const TOKEN = `ph_${"t".repeat(43)}`;
const TOKEN_ID = "0198f0c4-6a1b-7c2d-8e3f-4a5b6c7d8e9f";
const TEMPLATE = [
  "<!doctype html>",
  '<html lang="en" data-theme="dark">',
  "  <head>",
  '    <meta charset="utf-8" />',
  '    <meta name="color-scheme" content="dark" />',
  "  </head>",
  '  <body><div id="root"></div></body>',
  "</html>",
  "",
].join("\n");

let dir: string;
let app: FastifyInstance | undefined;
let uploads: Uploads;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "platehouse-principal-"));
  await mkdir(join(dir, "web"), { recursive: true });
  await writeFile(join(dir, "web", "index.html"), TEMPLATE);
  const now = Date.now();
  const session: Session = {
    id: SESSION_ID,
    subject: "subject-a",
    displayName: null,
    createdAt: new Date(now),
    expiresAt: new Date(now + 24 * 60 * 60_000),
    idleExpiresAt: new Date(now + 24 * 60 * 60_000),
  };
  const token: ApiToken = {
    id: TOKEN_ID,
    name: "Laptop",
    prefix: TOKEN.slice(0, 8),
    tokenHash: Buffer.alloc(32),
    createdAt: new Date(now),
    lastUsedAt: null,
    revokedAt: null,
    createdBySubject: "subject-a",
    createdByName: null,
  };
  const sessions: Sessions = {
    start: async () => {
      throw new Error("not used");
    },
    find: async (cookie) => (cookie === COOKIE ? session : undefined),
    end: async () => {},
    signOutEverywhere: async () => ({
      sessionsEnded: 1,
      tokensRevoked: 0,
      unknownTokensRevoked: 0,
    }),
  };
  uploads = await readyUploads(join(dir, "tmp"));
  app = await buildApp({
    health: { database: async () => 1, queuesRunning: () => true },
    uploads,
    auth: {
      oidc: {
        begin: async () => {
          throw new Error("not used");
        },
        finish: async () => {
          throw new Error("not used");
        },
      },
      sessions,
      publicOrigin: ORIGIN,
      absoluteUrl: (path) => `${ORIGIN}${path}`,
      cookieSecret: Buffer.alloc(32, 7),
    },
    web: { dir: join(dir, "web") },
    api: {
      ...refusingApi,
      tokens: {
        authenticate: async (header) => (header === `Bearer ${TOKEN}` ? token : undefined),
      },
    },
  });
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  await rm(dir, { recursive: true, force: true });
});

/** The info file of the one upload in the folder, as text. */
async function infoOfTheUpload(): Promise<string> {
  const infos = (await readdir(uploads.dir)).filter((name) => name.endsWith(".json"));
  expect(infos).toHaveLength(1);
  return readFile(join(uploads.dir, infos[0] as string), "utf8");
}

/** The owner written into the info file of the one upload in the folder. */
async function ownerOfTheUpload(): Promise<unknown> {
  return JSON.parse(await infoOfTheUpload()).owner;
}

const creation = {
  ...TUS,
  "upload-length": "100",
  "upload-metadata": meta({ filename: "a.stl" }),
};

test("an upload made on /app/uploads belongs to the session that made it", async () => {
  const res = await app?.inject({
    method: "POST",
    url: "/app/uploads",
    headers: { ...creation, origin: ORIGIN },
    cookies: { [SESSION_COOKIE]: COOKIE },
  });
  expect(res?.statusCode).toBe(201);
  expect(await ownerOfTheUpload()).toBe(`session:${SESSION_ID}`);
  // The user it is, for the log when the room runs out, and never the cookie.
  expect(JSON.parse(await infoOfTheUpload()).holder).toBe('user "subject-a"');
  expect(await infoOfTheUpload()).not.toContain(COOKIE);
});

test("an upload made on /api/v1/uploads belongs to the API token that made it", async () => {
  const res = await app?.inject({
    method: "POST",
    url: "/api/v1/uploads",
    headers: { ...creation, authorization: `Bearer ${TOKEN}` },
  });
  expect(res?.statusCode).toBe(201);
  expect(await ownerOfTheUpload()).toBe(`token:${TOKEN_ID}`);
  expect(JSON.parse(await infoOfTheUpload()).holder).toBe(
    `token ${TOKEN_ID} made by user "subject-a"`,
  );
  expect(await infoOfTheUpload()).not.toContain(TOKEN);
});
