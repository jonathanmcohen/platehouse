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
// PUBLIC_ORIGIN whatever Host the request carries (AC-091). A refused link
// makes no library lookup at all (the MAC is checked first), an object
// whose size differs from the record is 503 before any header, and a
// stream that runs past, falls short of or fails before the recorded size
// reaches the client as an aborted response, never a clean end (PR #156
// security review). A stream that fails before its first byte is a 503 (or
// 500) with none of the file's content headers (PR #156 review).
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
import {
  contentDisposition,
  FILE_UNAVAILABLE_MESSAGE,
  type FileContent,
  type FileHead,
} from "../../../src/api/v1.js";
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
import { reportObjectSize, StoreUnavailable } from "../../../src/storage/s3.js";
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
/**
 * How often each library call ran. A refused link must make none of them:
 * the token's MAC and expiry are checked before any lookup, so a forged
 * link never reaches the database or the store.
 */
const lookups = { linkFile: 0, openFile: 0, fileHead: 0 };
/** While set, the store reports this object size for every stream it opens. */
let storedSize: number | undefined;
/** The last stream the stubs handed out. */
let lastStream: Readable | undefined;
/** While set, every read of the store fails this way. */
let storeFails: Error | undefined;
/** While set, every database read fails this way. */
let dbFails: Error | undefined;
/** The stream the STREAMED file and blob hand out; the test writes into it. */
let gate: PassThrough | undefined;
/**
 * While set (and gate is not), the STREAMED file and blob hand out a new
 * stream from this each time they are opened, recorded at 16 bytes.
 */
let streamed: (() => Readable) | undefined;

function head(item: StubItem | { contentType: string; bytes: Buffer }, name: string): FileHead {
  return { name, contentType: item.contentType, size: item.bytes.length };
}

/**
 * A stub stream as the real store hands it out: with the object's size as
 * the store reported it (storedSize while a test sets it, else the bytes').
 */
function stored(bytes: Buffer): Readable {
  const stream = reportObjectSize(Readable.from([bytes]), storedSize ?? bytes.length);
  lastStream = stream;
  return stream;
}

const deliveryFiles: DeliveryDeps["files"] = {
  async fileHead(id) {
    lookups.fileHead += 1;
    if (dbFails) throw dbFails;
    const item = files.get(id);
    if (item === undefined) return undefined;
    if (storeFails) throw storeFails;
    return head(item, item.name);
  },
  async openFile(id): Promise<FileContent | undefined> {
    lookups.openFile += 1;
    if (dbFails) throw dbFails;
    // The STREAMED stream reports no object size, as a store that sends no
    // Content-Length would, so only the byte count guards it.
    if (id === STREAMED && (gate || streamed)) {
      opened += 1;
      const stream = gate ?? (streamed as () => Readable)();
      return { name: "Streamed.3mf", contentType: "model/3mf", size: 16, stream };
    }
    const item = files.get(id);
    if (item === undefined) return undefined;
    if (storeFails) throw storeFails;
    opened += 1;
    return { ...head(item, item.name), stream: stored(item.bytes) };
  },
};

const deliveryLibrary: DeliveryDeps["library"] = {
  async linkFile(id) {
    lookups.linkFile += 1;
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
    if (id === STREAMED_BLOB && (gate || streamed)) {
      opened += 1;
      const stream = gate ?? (streamed as () => Readable)();
      return { name: id, contentType: "image/png", size: 16, stream };
    }
    const item = blobs.get(id);
    if (item === undefined) return undefined;
    if (storeFails) throw storeFails;
    opened += 1;
    return { ...head(item, id), stream: stored(item.bytes) };
  },
};

let t: TestAuth;
let app: FastifyInstance;
let dir: string;
let sessionCookie: string;
let base: string;
const RUN_SECRET = randomBytes(32).toString("hex");
/** Every line the app's request log wrote, as the server's stdout gets it. */
const logLines: string[] = [];

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
    logger: {
      write(line: string) {
        logLines.push(line);
      },
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
  streamed = undefined;
  storedSize = undefined;
  lastStream = undefined;
});

/** Checks that no library call ran since before was taken: 0 of each. */
function expectNoLookups(before: typeof lookups, label = "") {
  expect({ ...lookups }, label).toEqual(before);
}

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
    const looked = { ...lookups };
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
            expectNoLookups(looked, label);
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
    const looked = { ...lookups };
    const link = await app.inject({
      method: "GET",
      url: "/s/not-a-token/Cube%20A.3mf",
      cookies: { [SESSION_COOKIE]: sessionCookie },
    });
    expect(link.statusCode).toBe(403);
    expect(link.body).toBe("");
    expect(opened).toBe(before);
    expectNoLookups(looked);
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
      const looked = { ...lookups };
      for (const method of ["GET", "HEAD"] as const) {
        const dead = await app.inject({ method, url: pathOf(link.url) });
        expect(dead.statusCode, method).toBe(403);
        expect(dead.body, method).toBe("");
        expect(dead.headers["content-disposition"], method).toBeUndefined();
      }
      expect(opened).toBe(before);
      expectNoLookups(looked);
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
    const looked = { ...lookups };
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
        expect(res.headers["cache-control"], `${method} ${url}`).toBe("no-store");
      }
    }
    expect(opened).toBe(before);
    expectNoLookups(looked);
  });

  test("the token is read as sent: a percent-escaped one is refused before any lookup", async () => {
    // The router decodes the path, so %41 would read as "A"; the link
    // route reads the token from the raw path, where only a literal token
    // of 48 base64url characters can match.
    const link = await linkFor(FILE_A);
    const [, , token = "", name] = pathOf(link.url).split("/");
    const first = token.charCodeAt(0).toString(16).toUpperCase();
    const escaped = `%${first}${token.slice(1)}`;
    const looked = { ...lookups };
    const res = await app.inject({ method: "GET", url: `/s/${escaped}/${name}` });
    expect(res.statusCode).toBe(403);
    expect(res.body).toBe("");
    expectNoLookups(looked);
    // The same token as minted still opens the file.
    const live = await app.inject({ method: "GET", url: `/s/${token}/${name}` });
    expect(live.statusCode).toBe(200);
  });

  test("an empty name segment is refused before any lookup", async () => {
    const link = await linkFor(FILE_A);
    const [, , token = ""] = pathOf(link.url).split("/");
    const looked = { ...lookups };
    for (const url of [`/s/${token}/`, `/s/${token}/?x=1`]) {
      for (const method of ["GET", "HEAD"] as const) {
        const res = await app.inject({ method, url });
        expect(res.statusCode, `${method} ${url}`).toBe(403);
        expect(res.body, `${method} ${url}`).toBe("");
      }
    }
    expectNoLookups(looked);
  });

  test("an unmatched /s/ path is 403 with an empty body and no-store, never a 404", async () => {
    // No name segment (a link cut short), another method, or junk: the
    // not-found handler answers as a refused link, and echoes nothing.
    const link = await linkFor(FILE_A);
    const [, , token = "", name = ""] = pathOf(link.url).split("/");
    const looked = { ...lookups };
    const before = opened;
    const requests: Array<[string, string]> = [
      ["GET", `/s/${token}`],
      ["HEAD", `/s/${token}`],
      ["GET", "/s/"],
      ["GET", "/s/zzz"],
      ["POST", `/s/${token}/x.3mf`],
      ["OPTIONS", `/s/${token}/x.3mf`],
      ["PUT", `/s/${token}/x.3mf`],
      ["DELETE", `/s/${token}/x.3mf`],
      ["PATCH", "/s/zzz/y"],
    ];
    expect(name).toContain("%");
    for (const [method, url] of requests) {
      const res = await app.inject({
        method: method as "GET",
        url,
        headers: { accept: "application/json", origin: TEST_ORIGIN },
      });
      const label = `${method} ${url}`;
      expect(res.statusCode, label).toBe(403);
      expect(res.body, label).toBe("");
      expect(res.headers["cache-control"], label).toBe("no-store");
      if (method !== "HEAD") expect(res.headers["content-length"], label).toBe("0");
    }
    expect(opened).toBe(before);
    expectNoLookups(looked);
  });

  test("an unmatched /s/ path with a percent escape is refused by the gate, echoing nothing", async () => {
    // The gate (auth/gate.ts) classes an unmatched path that is not a plain
    // route path (a percent escape, a dot segment) as session-class, so it
    // answers 401 before the not-found handler runs. Nothing is served or
    // echoed either way; the contract's 403 for these is a gate.ts change.
    const link = await linkFor(FILE_A);
    const [, , token = "", name = ""] = pathOf(link.url).split("/");
    const looked = { ...lookups };
    for (const method of ["POST", "PUT", "OPTIONS"] as const) {
      const res = await app.inject({
        method,
        url: `/s/${token}/${name}`,
        headers: { accept: "application/json", origin: TEST_ORIGIN },
      });
      expect(res.statusCode, method).toBe(401);
      expect(res.body, method).not.toContain(token);
      expect(res.body, method).not.toContain("Cube");
    }
    expectNoLookups(looked);
  });

  test("a link for file A cannot fetch file B", async () => {
    const a = await linkFor(FILE_A);
    const b = await linkFor(FILE_B);
    const tokenA = pathOf(a.url).split("/")[2] ?? "";
    const bytes = Buffer.from(tokenA, "base64url");
    Buffer.from(FILE_B.replaceAll("-", ""), "hex").copy(bytes, 0);
    const looked = { ...lookups };
    const swapped = await app.inject({
      method: "GET",
      url: `/s/${bytes.toString("base64url")}/Cube%20B.3mf`,
    });
    expect(swapped.statusCode).toBe(403);
    expect(swapped.body).toBe("");
    expectNoLookups(looked);
    const own = await app.inject({ method: "GET", url: pathOf(b.url) });
    expect(own.rawPayload.equals(files.get(FILE_B)?.bytes ?? Buffer.alloc(0))).toBe(true);
  });

  test("a name with slashes, dot-dot or escapes in it links with them replaced by _", async () => {
    // The segment replaces / \ % ? # ; and control characters with _
    // (Jon, 2026-11-12), so nothing a proxy might decode or refuse is in it;
    // Content-Disposition still carries the stored name. A raw "/" after
    // the name segment is refused.
    const cases: Array<[string, string]> = [
      ["../../etc/passwd.3mf", ".._.._etc_passwd.3mf"],
      ["a/b/c.3mf", "a_b_c.3mf"],
      ["..\\x.3mf", ".._x.3mf"],
      ["%2F%00.3mf", "_2F_00.3mf"],
      ["q?h#s;.3mf", "q_h_s_.3mf"],
    ];
    for (const [name, segment] of cases) {
      const id = "0198f0c4-6a1b-7c2d-8e3f-4a5b6c7d8efe";
      files.set(id, { ...(files.get(FILE_A) as StubItem), name, originalName: name });
      try {
        const link = await linkFor(id);
        const path = pathOf(link.url);
        expect(path.split("/"), name).toHaveLength(4);
        expect(path.split("/")[3], name).toBe(segment);
        const res = await app.inject({ method: "GET", url: path });
        expect(res.statusCode, name).toBe(200);
        expect(res.rawPayload.equals(files.get(FILE_A)?.bytes ?? Buffer.alloc(0)), name).toBe(true);
        expect(res.headers["content-disposition"], name).toBe(contentDisposition(name));
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
    const looked = { ...lookups };
    const res = await app.inject({ method: "GET", url: pathOf(link.url) });
    expect(res.statusCode).toBe(403);
    expect(res.body).toBe("");
    // A valid MAC reaches the file lookup, and nothing past it.
    expect({ ...lookups }).toEqual({ ...looked, linkFile: looked.linkFile + 1 });
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

describe("the request log and slicer links", () => {
  test("never holds a link's token or file name, live, refused or unrouted", async () => {
    const link = await linkFor(FILE_A);
    const path = pathOf(link.url);
    const [, , token = "", name = ""] = path.split("/");
    expect(token).not.toBe("");
    expect(name).toBe("Cube%20A.3mf");
    const altered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    const from = logLines.length;
    const requests: Array<[string, number]> = [
      [path, 200],
      [`/s/${altered}/${name}`, 403],
      [`/s/${token}/a/b`, 403],
      [`/s/${token}`, 403],
      // Fastify decodes %73 to "s" and routes this to the link route.
      [`/%73/${token}/${name}`, 200],
    ];
    for (const [url, status] of requests) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(status);
    }
    const log = logLines.slice(from).join("");
    // Each request is logged, with the link's segments replaced.
    expect(log).toContain('"url":"/s/[link]/[name]"');
    expect(log).toContain('"url":"/s/[link]"');
    expect(log).not.toContain(token);
    expect(log).not.toContain(altered);
    expect(log).not.toContain(token.slice(0, 16));
    expect(log).not.toContain(name);
    expect(log).not.toContain("Cube A");
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

describe("an object whose size differs from the record (PR #156 security review)", () => {
  const cookies = () => ({ [SESSION_COOKIE]: sessionCookie });

  /** Each GET that streams a stored object, its recorded size and whether it needs a session. */
  async function targets(): Promise<Array<[string, number, boolean]>> {
    const link = await linkFor(FILE_A);
    const fileSize = files.get(FILE_A)?.bytes.length ?? 0;
    const blobSize = blobs.get(BLOB_T)?.bytes.length ?? 0;
    return [
      [`/files/${FILE_A}/download`, fileSize, true],
      [`/blobs/${BLOB_T}`, blobSize, true],
      [pathOf(link.url), fileSize, false],
    ];
  }

  test.each([
    ["longer", 5],
    ["shorter", -3],
  ])(
    "an object %s than the record is 503 before any header, its stream closed",
    async (_label, delta) => {
      for (const [url, size, session] of await targets()) {
        storedSize = size + delta;
        const res = await app.inject({ method: "GET", url, cookies: session ? cookies() : {} });
        expect(res.statusCode, url).toBe(503);
        expect(res.json(), url).toEqual({
          error: "unavailable",
          message: FILE_UNAVAILABLE_MESSAGE,
        });
        expect(res.headers["content-disposition"], url).toBeUndefined();
        expect(res.headers["cache-control"], url).toBe("no-store");
        expect(lastStream?.destroyed, url).toBe(true);
      }
    },
  );

  test("an object the size of the record is served whole", async () => {
    for (const [url, size, session] of await targets()) {
      storedSize = size;
      const res = await app.inject({ method: "GET", url, cookies: session ? cookies() : {} });
      expect(res.statusCode, url).toBe(200);
      expect(res.rawPayload.length, url).toBe(size);
    }
  });
});

describe("a stream that is not exactly the recorded size reaches the client aborted", () => {
  // The STREAMED file and blob are recorded at 16 bytes and their stream
  // reports no object size, so only the byte count stands between a wrong
  // object and the client: bytes past the record would go out on the
  // keep-alive socket as the start of the next answer, and a short body
  // would leave the client waiting, so either one destroys the response.
  const cookie = () => ({ cookie: `${SESSION_COOKIE}=${sessionCookie}` });

  /**
   * Fetches url over real HTTP while the stub's stream has sent its first
   * 12 bytes, reads them, lets feed() finish or break the stream, and reads
   * on: what arrived, and the error the body ended with, if any.
   */
  async function fetchWhile(
    url: string,
    headers: Record<string, string>,
    feed: (stream: PassThrough) => void,
  ): Promise<{ received: Buffer; error: unknown }> {
    const stream = new PassThrough();
    gate = stream;
    stream.write("first-chunk-");
    const res = await fetch(`${base}${url}`, { headers });
    expect(res.status, url).toBe(200);
    expect(res.headers.get("content-length"), url).toBe("16");
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    const chunks: Buffer[] = [];
    const first = await reader.read();
    chunks.push(Buffer.from(first.value ?? []));
    feed(stream);
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) return { received: Buffer.concat(chunks), error: undefined };
        chunks.push(Buffer.from(next.value));
      }
    } catch (error) {
      return { received: Buffer.concat(chunks), error };
    }
  }

  async function urls(): Promise<Array<[string, Record<string, string>]>> {
    const link = await linkFor(STREAMED);
    return [
      [`/files/${STREAMED}/download`, cookie()],
      [`/blobs/${STREAMED_BLOB}`, cookie()],
      [pathOf(link.url), {}],
    ];
  }

  test("a stream longer than the record is cut off before its end, never sent past it", async () => {
    for (const [url, headers] of await urls()) {
      const got = await fetchWhile(url, headers, (s) => s.end("rest-and-then-more"));
      expect(got.error, url).toBeDefined();
      expect(got.received.length, url).toBeLessThan(16);
      expect(got.received.toString(), url).not.toContain("more");
    }
  });

  test("a stream that reaches the record and then goes on is never seen as complete", async () => {
    // The last recorded byte is held until the source ends, so a client
    // never holds the whole Content-Length of an object that turns out
    // longer, and so never takes the cut-off answer for a whole file.
    for (const [url, headers] of await urls()) {
      const got = await fetchWhile(url, headers, (s) => {
        s.write("rest");
        setTimeout(() => s.end("more"), 50);
      });
      expect(got.error, url).toBeDefined();
      expect(got.received.length, url).toBeLessThan(16);
    }
  });

  test("a stream shorter than the record is aborted, not left hanging or ended", async () => {
    for (const [url, headers] of await urls()) {
      const got = await fetchWhile(url, headers, (s) => s.end("abc"));
      expect(got.error, url).toBeDefined();
      expect(got.received.toString(), url).toBe("first-chunk-abc");
    }
  });

  test("a store stream destroyed after its first chunk aborts the response", async () => {
    for (const [url, headers] of await urls()) {
      const got = await fetchWhile(url, headers, (s) =>
        s.destroy(new StoreUnavailable("GetObject", "ECONNRESET")),
      );
      expect(got.error, url).toBeDefined();
      expect(got.received.toString(), url).toBe("first-chunk-");
    }
  });

  test("a stream of exactly the recorded size ends cleanly with every byte", async () => {
    for (const [url, headers] of await urls()) {
      const got = await fetchWhile(url, headers, (s) => s.end("rest"));
      expect(got.error, url).toBeUndefined();
      expect(got.received.toString(), url).toBe("first-chunk-rest");
    }
    // The server is still up after the aborted answers.
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });
});

describe("a stream that fails before its first byte is answered with no attachment header", () => {
  // Fastify copies the reply's headers onto the response before the first
  // chunk, so a stream that fails before it is answered through the scope's
  // error handler (fileRouteErrors). That answer is a JSON error, so it must
  // not keep the download's Content-Disposition, or a client that ignores
  // the status saves the error under the model's file name (PR #156 review).
  const cookies = () => ({ [SESSION_COOKIE]: sessionCookie });

  async function urls(): Promise<Array<[string, boolean]>> {
    const link = await linkFor(STREAMED);
    return [
      [`/files/${STREAMED}/download`, true],
      [`/blobs/${STREAMED_BLOB}`, true],
      [pathOf(link.url), false],
    ];
  }

  /** A stream that fails with error on its first read, before any byte. */
  function failsAtOnce(error: Error): () => Readable {
    return () =>
      new Readable({
        read() {
          this.destroy(error);
        },
      });
  }

  test.each<[string, () => Readable]>([
    [
      "the store fails on the first read",
      failsAtOnce(new StoreUnavailable("GetObject", "ETIMEDOUT")),
    ],
    ["the object is empty", () => Readable.from([])],
    ["the first chunk is already past the record", () => Readable.from([Buffer.alloc(20, 0x61)])],
  ])("%s: 503, no Content-Disposition", async (_label, open) => {
    for (const [url, session] of await urls()) {
      streamed = open;
      const res = await app.inject({ method: "GET", url, cookies: session ? cookies() : {} });
      expect(res.statusCode, url).toBe(503);
      expect(res.json(), url).toEqual({ error: "unavailable", message: FILE_UNAVAILABLE_MESSAGE });
      expect(res.headers["content-disposition"], url).toBeUndefined();
      expect(res.headers["cache-control"], url).toBe("no-store");
    }
  });

  test("any other failure before the first byte: 500, no Content-Disposition", async () => {
    for (const [url, session] of await urls()) {
      streamed = failsAtOnce(new Error("synthetic stream failure"));
      const res = await app.inject({ method: "GET", url, cookies: session ? cookies() : {} });
      expect(res.statusCode, url).toBe(500);
      expect(res.json(), url).toEqual({ error: "internal" });
      expect(res.headers["content-disposition"], url).toBeUndefined();
      expect(res.headers["cache-control"], url).toBe("no-store");
    }
  });
});
