// Build plan Task 17 with Task 15's route-class gate: the delivery routes,
// mounted the way the server mounts them (buildApp with deps.delivery), each
// in its class (the Route classes table): GET /files/:id/download and GET
// /blobs/:id are session-class, POST /app/api/files/:id/slicer-link is
// session-class and state-changing, so it needs Origin to be PUBLIC_ORIGIN,
// and GET /s/<token>/<name> is link-class: no session, the token alone, and
// a refusal is 403 with an empty body. Every route of the app is walked from
// app.printRoutes(), so a delivery route registered in the wrong class, or a
// new route nobody listed, fails here.
//
// Also here, against a library stub: bytes are streamed (the first chunk
// reaches the client before the store has sent the rest), a HEAD opens no
// stream, a store outage is 503 "This file is unavailable right now", an
// error from the database leaks nothing, and the link URL comes from
// PUBLIC_ORIGIN whatever Host the request carries (AC-091).
//
// No container: sessions are in memory and the issuer is the local mock.
// The DB and bucket tests are in delivery.test.ts. Every byte is synthetic.
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { FILE_UNAVAILABLE_MESSAGE, type FileContent, type FileHead } from "../../../src/api/v1.js";
import { buildApp } from "../../../src/app.js";
import { patternClass, type RouteClass } from "../../../src/auth/gate.js";
import { SESSION_COOKIE } from "../../../src/auth/sessions.js";
import {
  BLOB_CACHE_CONTROL,
  type DeliveryDeps,
  FILE_CACHE_CONTROL,
  type LinkFile,
} from "../../../src/delivery/download.js";
import { LINK_LIFETIME_SECONDS, type SlicerLink } from "../../../src/delivery/links.js";
import { StoreUnavailable } from "../../../src/storage/s3.js";
import { createUploads } from "../../../src/uploads/tus.js";
import {
  concretePath,
  registeredRoutes,
  TEST_ORIGIN,
  type TestAuth,
  testAuth,
} from "../support/oidc-issuer.js";

const FILE_A = "0198f0c4-6a1b-7c2d-8e3f-4a5b6c7d8e9f";
const FILE_B = "0198f0c4-6a1b-7c2d-8e3f-4a5b6c7d8ea0";
const BLOB_T = "0198f0c4-6a1b-7c2d-8e3f-4a5b6c7d8eb1";
const STREAMED = "0198f0c4-6a1b-7c2d-8e3f-4a5b6c7d8ec2";
const STREAMED_BLOB = "0198f0c4-6a1b-7c2d-8e3f-4a5b6c7d8ed3";

interface StubItem {
  name: string;
  originalName: string;
  kind: LinkFile["kind"];
  contentType: string;
  bytes: Buffer;
}

const files = new Map<string, StubItem>([
  [
    FILE_A,
    {
      name: "Cube A.3mf",
      originalName: "Cube A.3mf",
      kind: "3mf",
      contentType: "model/3mf",
      bytes: Buffer.from(`file A ${randomBytes(8).toString("hex")}`),
    },
  ],
  [
    FILE_B,
    {
      name: "Cube B.3mf",
      originalName: "Cube B.3mf",
      kind: "3mf",
      contentType: "model/3mf",
      bytes: Buffer.from(`file B ${randomBytes(8).toString("hex")}`),
    },
  ],
]);
const blobs = new Map<string, { contentType: string; bytes: Buffer }>([
  [BLOB_T, { contentType: "image/png", bytes: Buffer.from("thumbnail png bytes") }],
]);

/** How many streams the stubs opened (each one a GetObject on the real store). */
let opened = 0;
/** While set, every read of the store fails this way. */
let storeFails: Error | undefined;
/** While set, every database read fails this way. */
let dbFails: Error | undefined;
/** The stream the STREAMED file and blob hand out; the test writes into it. */
let gate: PassThrough | undefined;

function head(item: StubItem | { contentType: string; bytes: Buffer }, name: string): FileHead {
  return { name, contentType: item.contentType, size: item.bytes.length };
}

const deliveryFiles: DeliveryDeps["files"] = {
  async fileHead(id) {
    if (dbFails) throw dbFails;
    const item = files.get(id);
    if (item === undefined) return undefined;
    if (storeFails) throw storeFails;
    return head(item, item.name);
  },
  async openFile(id): Promise<FileContent | undefined> {
    if (dbFails) throw dbFails;
    if (id === STREAMED && gate) {
      opened += 1;
      return { name: "Streamed.3mf", contentType: "model/3mf", size: 16, stream: gate };
    }
    const item = files.get(id);
    if (item === undefined) return undefined;
    if (storeFails) throw storeFails;
    opened += 1;
    return { ...head(item, item.name), stream: Readable.from([item.bytes]) };
  },
};

const deliveryLibrary: DeliveryDeps["library"] = {
  async linkFile(id) {
    if (dbFails) throw dbFails;
    if (id === STREAMED) {
      return { id, name: "Streamed.3mf", originalName: "Streamed.3mf", kind: "3mf" };
    }
    const item = files.get(id);
    return item === undefined
      ? undefined
      : { id, name: item.name, originalName: item.originalName, kind: item.kind };
  },
  async blobHead(id) {
    if (dbFails) throw dbFails;
    const item = blobs.get(id);
    if (item === undefined) return undefined;
    if (storeFails) throw storeFails;
    return head(item, id);
  },
  async openBlob(id) {
    if (dbFails) throw dbFails;
    if (id === STREAMED_BLOB && gate) {
      opened += 1;
      return { name: id, contentType: "image/png", size: 16, stream: gate };
    }
    const item = blobs.get(id);
    if (item === undefined) return undefined;
    if (storeFails) throw storeFails;
    opened += 1;
    return { ...head(item, id), stream: Readable.from([item.bytes]) };
  },
};

let t: TestAuth;
let app: FastifyInstance;
let dir: string;
let sessionCookie: string;
let base: string;
const RUN_SECRET = randomBytes(32).toString("hex");

beforeAll(async () => {
  t = await testAuth();
  dir = await mkdtemp(join(tmpdir(), "platehouse-delivery-"));
  app = await buildApp({
    health: { database: async () => 1, queuesRunning: () => true },
    uploads: createUploads({
      tmpDir: dir,
      queue: { enqueue: async () => {}, result: async () => undefined },
      log: () => {},
    }),
    auth: t.auth,
    delivery: {
      files: deliveryFiles,
      library: deliveryLibrary,
      linkSecret: RUN_SECRET,
      now: () => t.clock.now,
    },
  });
  await app.ready();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  base = `http://127.0.0.1:${address.port}`;
  sessionCookie = (await t.sessions.start("jon")).id;
});

afterAll(async () => {
  await app?.close();
  await t?.issuer.stop();
  if (dir) await rm(dir, { recursive: true, force: true });
});

afterEach(() => {
  storeFails = undefined;
  dbFails = undefined;
  gate = undefined;
});

/** Mints a link for a file through the route, as the UI does. */
async function mint(fileId: string, headers: Record<string, string> = {}) {
  const res = await app.inject({
    method: "POST",
    url: `/app/api/files/${fileId}/slicer-link`,
    headers: { origin: TEST_ORIGIN, ...headers },
    cookies: { [SESSION_COOKIE]: sessionCookie },
  });
  return res;
}

async function linkFor(fileId: string): Promise<SlicerLink> {
  const res = await mint(fileId);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as SlicerLink;
}

/** The path of a link URL, for inject. */
function pathOf(url: string): string {
  return new URL(url).pathname;
}

/** The delivery routes, as printRoutes lists them, with their methods and class. */
const DELIVERY: Array<[string, string, RouteClass]> = [
  ["/files/:id/download", "GET", "session"],
  ["/files/:id/download", "HEAD", "session"],
  ["/blobs/:id", "GET", "session"],
  ["/blobs/:id", "HEAD", "session"],
  ["/app/api/files/:id/slicer-link", "POST", "session"],
  ["/s/:token/*", "GET", "link"],
  ["/s/:token/*", "HEAD", "link"],
];

describe("every registered route, with delivery mounted", () => {
  test("the delivery routes are registered, each in the class the table gives it", () => {
    const listed = new Map(registeredRoutes(app).map((r) => [r.path, r.methods]));
    for (const [path, method, cls] of DELIVERY) {
      expect(listed.get(path), `${method} ${path}`).toContain(method);
      expect(patternClass(path), path).toBe(cls);
    }
  });

  test("each has a class and answers a request with no credentials as its class says", async () => {
    const routes = registeredRoutes(app);
    expect(routes.length).toBeGreaterThan(14);
    const seen = new Set<RouteClass>();
    const before = opened;
    for (const route of routes) {
      const cls = patternClass(route.path);
      seen.add(cls);
      for (const method of route.methods) {
        const label = `${method} ${route.path} (${cls})`;
        const res = await app.inject({
          method: method as "GET",
          url: concretePath(route.path),
          headers: { accept: "application/json", origin: TEST_ORIGIN },
        });
        const toLogin = res.headers.location === `${TEST_ORIGIN}/auth/login`;
        switch (cls) {
          case "session":
          case "bearer":
            expect(res.statusCode, label).toBe(401);
            expect(toLogin, label).toBe(false);
            break;
          case "link":
            expect(res.statusCode, label).toBe(403);
            expect(res.body, label).toBe("");
            expect(opened, label).toBe(before);
            break;
          case "public":
            expect(res.statusCode, label).not.toBe(401);
            expect(res.statusCode, label).not.toBe(403);
            break;
        }
      }
    }
    expect([...seen].sort()).toEqual(["bearer", "link", "public", "session"]);
  });

  test("a page request to a session delivery route without a session goes to login", async () => {
    for (const url of [`/files/${FILE_A}/download`, `/blobs/${BLOB_T}`]) {
      const res = await app.inject({ method: "GET", url, headers: { accept: "text/html" } });
      expect(res.statusCode, url).toBe(302);
      expect(res.headers.location, url).toBe(`${TEST_ORIGIN}/auth/login`);
    }
  });

  test("a session opens the session delivery routes and never a link route", async () => {
    const download = await app.inject({
      method: "GET",
      url: `/files/${FILE_A}/download`,
      cookies: { [SESSION_COOKIE]: sessionCookie },
    });
    expect(download.statusCode).toBe(200);
    const before = opened;
    const link = await app.inject({
      method: "GET",
      url: "/s/not-a-token/Cube%20A.3mf",
      cookies: { [SESSION_COOKIE]: sessionCookie },
    });
    expect(link.statusCode).toBe(403);
    expect(link.body).toBe("");
    expect(opened).toBe(before);
  });
});

describe("POST /app/api/files/:id/slicer-link", () => {
  test("needs Origin to be PUBLIC_ORIGIN: another site or none is 403, nothing minted", async () => {
    for (const headers of [{ origin: "https://evil.example" }, {}, { origin: "null" }]) {
      const res = await app.inject({
        method: "POST",
        url: `/app/api/files/${FILE_A}/slicer-link`,
        headers,
        cookies: { [SESSION_COOKIE]: sessionCookie },
      });
      expect(res.statusCode, JSON.stringify(headers)).toBe(403);
      expect(res.body).not.toContain("/s/");
    }
  });

  test("needs a session: same-origin without one is 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/app/api/files/${FILE_A}/slicer-link`,
      headers: { origin: TEST_ORIGIN },
    });
    expect(res.statusCode).toBe(401);
  });

  test("answers {url, expiresAt, open} with no-store, the link ten minutes long", async () => {
    const res = await mint(FILE_A);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json() as SlicerLink;
    expect(Object.keys(body).sort()).toEqual(["expiresAt", "open", "url"]);
    expect(Object.keys(body.open).sort()).toEqual(["bambuMac", "bambuOther", "orca"]);
    expect(body.url).toMatch(/^https:\/\/platehouse\.test\/s\/[A-Za-z0-9_-]{48}\/Cube%20A\.3mf$/);
    const ms = new Date(body.expiresAt).getTime() - t.clock.now.getTime();
    expect(ms).toBeGreaterThanOrEqual(LINK_LIFETIME_SECONDS * 1000);
    expect(ms).toBeLessThanOrEqual(LINK_LIFETIME_SECONDS * 1000 + 1000);
  });

  test("the link is on PUBLIC_ORIGIN under a spoofed Host and X-Forwarded-Host (AC-091)", async () => {
    const res = await mint(FILE_A, {
      host: "evil.example",
      "x-forwarded-host": "evil.example",
      "x-forwarded-proto": "http",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SlicerLink;
    expect(new URL(body.url).origin).toBe(TEST_ORIGIN);
    expect(res.body).not.toContain("evil.example");
  });

  test("an unknown, trashed or malformed file id is 404", async () => {
    for (const id of ["0198f0c4-0000-7000-8000-000000000000", "not-a-uuid", "1"]) {
      const res = await mint(id);
      expect(res.statusCode, id).toBe(404);
      expect(res.body, id).not.toContain("/s/");
    }
  });

  test("a database error answers with no detail", async () => {
    dbFails = new Error("connect ECONNREFUSED 10.9.8.7:5432 db.internal");
    const res = await mint(FILE_A);
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(res.body).not.toContain("10.9.8.7");
    expect(res.body).not.toContain("db.internal");
  });
});

describe("GET /s/<token>/<name>", () => {
  test("works with no session and returns the file's bytes as an attachment", async () => {
    const link = await linkFor(FILE_A);
    const res = await app.inject({ method: "GET", url: pathOf(link.url) });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(files.get(FILE_A)?.bytes ?? Buffer.alloc(0))).toBe(true);
    expect(res.headers["content-type"]).toBe("model/3mf");
    expect(res.headers["content-length"]).toBe(String(files.get(FILE_A)?.bytes.length));
    expect(res.headers["content-disposition"]).toBe(
      `attachment; filename="Cube A.3mf"; filename*=UTF-8''Cube%20A.3mf`,
    );
    expect(res.headers["cache-control"]).toBe(FILE_CACHE_CONTROL);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  test("the name segment is never used for lookup", async () => {
    const link = await linkFor(FILE_A);
    const token = pathOf(link.url).split("/")[2];
    const res = await app.inject({ method: "GET", url: `/s/${token}/Cube%20B.3mf` });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(files.get(FILE_A)?.bytes ?? Buffer.alloc(0))).toBe(true);
  });

  test("works at 9:59 and is 403 with an empty body and no bytes at 10:01", async () => {
    const link = await linkFor(FILE_A);
    const start = t.clock.now;
    try {
      t.clock.advance(9 * 60_000 + 59_000);
      const live = await app.inject({ method: "GET", url: pathOf(link.url) });
      expect(live.statusCode).toBe(200);
      t.clock.advance(2_000);
      const before = opened;
      const dead = await app.inject({ method: "GET", url: pathOf(link.url) });
      expect(dead.statusCode).toBe(403);
      expect(dead.body).toBe("");
      expect(dead.headers["content-disposition"]).toBeUndefined();
      expect(opened).toBe(before);
    } finally {
      t.clock.now = start;
    }
  });

  test("an altered token is 403 with an empty body and opens nothing", async () => {
    const link = await linkFor(FILE_A);
    const [, , token, name] = pathOf(link.url).split("/");
    const bytes = Buffer.from(token ?? "", "base64url");
    bytes[30] = (bytes[30] ?? 0) ^ 0x80;
    const before = opened;
    for (const url of [
      `/s/${bytes.toString("base64url")}/${name}`,
      `/s/${token?.slice(0, -1)}/${name}`,
      `/s/${token}x/${name}`,
      `/s/${token}/${name}/extra`,
      `/s/${"A".repeat(48)}/${name}`,
    ]) {
      for (const method of ["GET", "HEAD"] as const) {
        const res = await app.inject({ method, url });
        expect(res.statusCode, `${method} ${url}`).toBe(403);
        expect(res.body, `${method} ${url}`).toBe("");
      }
    }
    expect(opened).toBe(before);
  });

  test("a link for file A cannot fetch file B", async () => {
    const a = await linkFor(FILE_A);
    const b = await linkFor(FILE_B);
    const tokenA = pathOf(a.url).split("/")[2] ?? "";
    const bytes = Buffer.from(tokenA, "base64url");
    Buffer.from(FILE_B.replaceAll("-", ""), "hex").copy(bytes, 0);
    const swapped = await app.inject({
      method: "GET",
      url: `/s/${bytes.toString("base64url")}/Cube%20B.3mf`,
    });
    expect(swapped.statusCode).toBe(403);
    expect(swapped.body).toBe("");
    const own = await app.inject({ method: "GET", url: pathOf(b.url) });
    expect(own.rawPayload.equals(files.get(FILE_B)?.bytes ?? Buffer.alloc(0))).toBe(true);
  });

  test("a name with slashes, dot-dot or escapes in it still opens its link", async () => {
    // The segment is encodeURIComponent(name), so a "/" in the name is %2F:
    // one segment, which the router decodes back into the name. Only a raw
    // "/" after the name segment is refused.
    for (const name of ["../../etc/passwd.3mf", "a/b/c.3mf", "..\\x.3mf", "%2F%00.3mf"]) {
      const id = "0198f0c4-6a1b-7c2d-8e3f-4a5b6c7d8efe";
      files.set(id, { ...(files.get(FILE_A) as StubItem), name, originalName: name });
      try {
        const link = await linkFor(id);
        const path = pathOf(link.url);
        expect(path.split("/"), name).toHaveLength(4);
        const res = await app.inject({ method: "GET", url: path });
        expect(res.statusCode, name).toBe(200);
        expect(res.rawPayload.equals(files.get(FILE_A)?.bytes ?? Buffer.alloc(0)), name).toBe(true);
      } finally {
        files.delete(id);
      }
    }
  });

  test("a HEAD answers the headers and opens no stream", async () => {
    const link = await linkFor(FILE_A);
    const before = opened;
    const res = await app.inject({ method: "HEAD", url: pathOf(link.url) });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-length"]).toBe(String(files.get(FILE_A)?.bytes.length));
    expect(res.body).toBe("");
    expect(opened).toBe(before);
  });

  test("a link to a file that has since gone is 403", async () => {
    const id = "0198f0c4-6a1b-7c2d-8e3f-4a5b6c7d8eff";
    files.set(id, { ...(files.get(FILE_A) as StubItem), name: "Gone.3mf" });
    const link = await linkFor(id);
    files.delete(id);
    const res = await app.inject({ method: "GET", url: pathOf(link.url) });
    expect(res.statusCode).toBe(403);
    expect(res.body).toBe("");
  });

  test("with the store down it is 503 with the plain message, never a store detail", async () => {
    const link = await linkFor(FILE_A);
    storeFails = new StoreUnavailable("GetObject", "ECONNREFUSED");
    const res = await app.inject({ method: "GET", url: pathOf(link.url) });
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain(FILE_UNAVAILABLE_MESSAGE);
    expect(res.body).not.toContain("ECONNREFUSED");
    expect(res.body).not.toContain("GetObject");
  });

  test("a database error answers with no detail", async () => {
    const link = await linkFor(FILE_A);
    dbFails = new Error("connect ECONNREFUSED 10.9.8.7:5432 db.internal");
    const res = await app.inject({ method: "GET", url: pathOf(link.url) });
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(res.body).not.toContain("10.9.8.7");
    expect(res.body).not.toContain("db.internal");
  });
});

describe("GET /files/:id/download and GET /blobs/:id", () => {
  const cookies = () => ({ [SESSION_COOKIE]: sessionCookie });

  test("download streams the file as an attachment with no-store", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/files/${FILE_B}/download`,
      cookies: cookies(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(files.get(FILE_B)?.bytes ?? Buffer.alloc(0))).toBe(true);
    expect(res.headers["content-disposition"]).toBe(
      `attachment; filename="Cube B.3mf"; filename*=UTF-8''Cube%20B.3mf`,
    );
    expect(res.headers["cache-control"]).toBe(FILE_CACHE_CONTROL);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  test("a blob is served with its content type and the immutable cache header", async () => {
    const res = await app.inject({ method: "GET", url: `/blobs/${BLOB_T}`, cookies: cookies() });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("thumbnail png bytes");
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["cache-control"]).toBe(BLOB_CACHE_CONTROL);
    expect(BLOB_CACHE_CONTROL).toBe("private, max-age=31536000, immutable");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  test("a file renamed without its extension downloads and links with the real one", async () => {
    // A browser saves a download under the Content-Disposition name, so a
    // name a rename left bare gets the file's real extension there too.
    const id = "0198f0c4-6a1b-7c2d-8e3f-4a5b6c7d8efd";
    files.set(id, {
      ...(files.get(FILE_A) as StubItem),
      name: "Renamed plate",
      originalName: "plate.3mf",
    });
    const expected = `attachment; filename="Renamed plate.3mf"; filename*=UTF-8''Renamed%20plate.3mf`;
    try {
      for (const method of ["GET", "HEAD"] as const) {
        const download = await app.inject({
          method,
          url: `/files/${id}/download`,
          cookies: cookies(),
        });
        expect(download.statusCode, method).toBe(200);
        expect(download.headers["content-disposition"], method).toBe(expected);

        const link = await linkFor(id);
        expect(link.url.endsWith("/Renamed%20plate.3mf")).toBe(true);
        const fetched = await app.inject({ method, url: pathOf(link.url) });
        expect(fetched.statusCode, method).toBe(200);
        expect(fetched.headers["content-disposition"], method).toBe(expected);
      }
    } finally {
      files.delete(id);
    }
  });

  test("a HEAD on either opens no stream", async () => {
    const before = opened;
    for (const url of [`/files/${FILE_A}/download`, `/blobs/${BLOB_T}`]) {
      const res = await app.inject({ method: "HEAD", url, cookies: cookies() });
      expect(res.statusCode, url).toBe(200);
      expect(Number(res.headers["content-length"]), url).toBeGreaterThan(0);
    }
    expect(opened).toBe(before);
  });

  test("an unknown or malformed id is 404", async () => {
    for (const url of [
      "/files/0198f0c4-0000-7000-8000-000000000000/download",
      "/files/nope/download",
      "/blobs/0198f0c4-0000-7000-8000-000000000000",
      "/blobs/nope",
    ]) {
      const res = await app.inject({ method: "GET", url, cookies: cookies() });
      expect(res.statusCode, url).toBe(404);
    }
  });

  test("store down: 503 with the plain message on both, nothing about the store", async () => {
    storeFails = new StoreUnavailable("GetObject", "ETIMEDOUT");
    for (const url of [`/files/${FILE_A}/download`, `/blobs/${BLOB_T}`]) {
      for (const method of ["GET", "HEAD"] as const) {
        const res = await app.inject({ method, url, cookies: cookies() });
        expect(res.statusCode, `${method} ${url}`).toBe(503);
        if (method === "GET") {
          expect(res.json(), url).toEqual({
            error: "unavailable",
            message: FILE_UNAVAILABLE_MESSAGE,
          });
        }
        expect(res.headers["cache-control"], url).toBe("no-store");
      }
    }
  });

  test("a database error answers with no detail", async () => {
    dbFails = new Error("connect ECONNREFUSED 10.9.8.7:5432 db.internal");
    for (const url of [`/files/${FILE_A}/download`, `/blobs/${BLOB_T}`]) {
      const res = await app.inject({ method: "GET", url, cookies: cookies() });
      expect(res.statusCode, url).toBeGreaterThanOrEqual(500);
      expect(res.body, url).not.toContain("10.9.8.7");
    }
  });
});

describe("bytes are streamed, never buffered whole", () => {
  /**
   * Fetches url over real HTTP while the stub's stream has sent only its
   * first chunk, and checks that chunk reaches the client before the stream
   * ends; then ends it and reads the rest.
   */
  async function firstChunkArrivesEarly(url: string, headers: Record<string, string> = {}) {
    gate = new PassThrough();
    gate.write("first-chunk-");
    const res = await fetch(`${base}${url}`, { headers });
    expect(res.status, url).toBe(200);
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    const first = await reader.read();
    expect(Buffer.from(first.value ?? []).toString(), url).toBe("first-chunk-");
    expect(gate.writableEnded, url).toBe(false);
    gate.end("rest");
    let rest = "";
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      rest += Buffer.from(next.value).toString();
    }
    expect(rest, url).toBe("rest");
  }

  const cookie = () => ({ cookie: `${SESSION_COOKIE}=${sessionCookie}` });

  test("download", async () => {
    await firstChunkArrivesEarly(`/files/${STREAMED}/download`, cookie());
  });

  test("blob", async () => {
    await firstChunkArrivesEarly(`/blobs/${STREAMED_BLOB}`, cookie());
  });

  test("slicer link", async () => {
    const link = await linkFor(STREAMED);
    await firstChunkArrivesEarly(pathOf(link.url));
  });
});
