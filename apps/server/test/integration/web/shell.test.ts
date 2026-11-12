// Build plan Task 18, AC-070, with the Route classes contract: the server
// serves the built web app. The shell pages are session-class: without a
// session a page is sent to /auth/login, and with one it is index.html with
// data-theme and the color-scheme meta written in from the ph_theme cookie,
// never cached. The hashed build output under /assets/ is public and cached
// for a year. A server whose web app is not built still starts, and says so
// on its pages.
//
// No container: sessions are in memory, and the build is a temp folder laid
// out the way vite build lays out apps/web/dist.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildApp } from "../../../src/app.js";
import { SESSION_COOKIE } from "../../../src/auth/sessions.js";
import { createUploads } from "../../../src/uploads/tus.js";
import { THEME_COOKIE } from "../../../src/web/shell.js";
import { TEST_ORIGIN, type TestAuth, testAuth } from "../support/oidc-issuer.js";

/** The sidebar's sections: Library, Creators, Collections and Tags. */
const SHELL_PAGES = ["/", "/creators", "/collections", "/tags"];
const HTML = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const SCRIPT = "export const shell = 1;\n";
const INDEX = [
  "<!doctype html>",
  '<html lang="en" data-theme="dark">',
  "  <head>",
  '    <meta name="color-scheme" content="dark" />',
  '    <script type="module" crossorigin src="/assets/index-AbC123.js"></script>',
  "  </head>",
  '  <body><div id="root"></div></body>',
  "</html>",
  "",
].join("\n");

interface WebApp {
  app: FastifyInstance;
  auth: TestAuth;
  session: string;
  close(): Promise<void>;
}

async function webApp(web: { dir: string }): Promise<WebApp> {
  const auth = await testAuth();
  const tmp = await mkdtemp(join(tmpdir(), "platehouse-web-uploads-"));
  const app = await buildApp({
    health: { database: async () => 1, queuesRunning: () => true },
    uploads: createUploads({
      tmpDir: tmp,
      queue: { enqueue: async () => {}, result: async () => undefined },
      log: () => {},
    }),
    auth: auth.auth,
    web,
  });
  await app.ready();
  const session = (await auth.sessions.start("someone")).id;
  return {
    app,
    auth,
    session,
    async close() {
      await app.close();
      await auth.issuer.stop();
      await rm(tmp, { recursive: true, force: true });
    },
  };
}

describe("a built web app", () => {
  let dist: string;
  let t: WebApp;

  beforeAll(async () => {
    dist = await mkdtemp(join(tmpdir(), "platehouse-web-dist-"));
    await mkdir(join(dist, "assets"));
    await writeFile(join(dist, "index.html"), INDEX);
    await writeFile(join(dist, "assets", "index-AbC123.js"), SCRIPT);
    t = await webApp({ dir: dist });
  });

  afterAll(async () => {
    await t?.close();
    await rm(dist, { recursive: true, force: true });
  });

  test("a shell page without a session is sent to /auth/login", async () => {
    for (const url of SHELL_PAGES) {
      for (const method of ["GET", "HEAD"] as const) {
        const res = await t.app.inject({ method, url, headers: { accept: HTML } });
        expect(res.statusCode, `${method} ${url}`).toBe(302);
        expect(res.headers.location, `${method} ${url}`).toBe(`${TEST_ORIGIN}/auth/login`);
      }
    }
  });

  test("a shell page with a session is index.html, dark by default, never cached", async () => {
    for (const url of SHELL_PAGES) {
      const res = await t.app.inject({
        method: "GET",
        url,
        headers: { accept: HTML },
        cookies: { [SESSION_COOKIE]: t.session },
      });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers["content-type"], url).toBe("text/html; charset=utf-8");
      expect(res.headers["cache-control"], url).toBe("no-store");
      expect(res.body, url).toBe(INDEX);
    }
  });

  test.each([
    ["light", "light", "light"],
    ["system", "system", "light dark"],
    ["dark", "dark", "dark"],
    ["nonsense", "dark", "dark"],
  ])("ph_theme=%s renders data-theme %s and color-scheme %s", async (cookie, theme, scheme) => {
    const res = await t.app.inject({
      method: "GET",
      url: "/",
      headers: { accept: HTML },
      cookies: { [SESSION_COOKIE]: t.session, [THEME_COOKIE]: cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`<html lang="en" data-theme="${theme}">`);
    expect(res.body).toContain(`<meta name="color-scheme" content="${scheme}" />`);
  });

  test("HEAD of a shell page with a session is 200 with no body", async () => {
    const res = await t.app.inject({
      method: "HEAD",
      url: "/",
      cookies: { [SESSION_COOKIE]: t.session },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("");
  });

  test("a hashed asset is served with no session at all and cached for a year", async () => {
    const res = await t.app.inject({ method: "GET", url: "/assets/index-AbC123.js" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(SCRIPT);
    expect(res.headers["content-type"]).toMatch(/^(?:text|application)\/javascript/);
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  test("an asset that is not there is a plain 404", async () => {
    const res = await t.app.inject({ method: "GET", url: "/assets/index-missing.js" });
    expect(res.statusCode).toBe(404);
  });

  test("nothing outside assets/ is reachable through /assets/", async () => {
    for (const url of [
      "/assets/../index.html",
      "/assets/%2e%2e/index.html",
      "/assets/..%2findex.html",
    ]) {
      const res = await t.app.inject({ method: "GET", url });
      expect(res.statusCode, url).not.toBe(200);
      expect(res.body, url).not.toContain("<html");
    }
  });

  test("index.html itself is not a public file", async () => {
    for (const url of ["/index.html", "/assets/index.html"]) {
      const res = await t.app.inject({ method: "GET", url, headers: { accept: HTML } });
      expect(res.body, url).not.toContain("<html");
    }
  });

  test("a page that is not a shell page is still a 404 with a session", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: "/no-such-page",
      headers: { accept: HTML },
      cookies: { [SESSION_COOKIE]: t.session },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("a web app that is not built", () => {
  let dist: string;
  let t: WebApp;

  beforeAll(async () => {
    dist = await mkdtemp(join(tmpdir(), "platehouse-web-empty-"));
    t = await webApp({ dir: join(dist, "dist") });
  });

  afterAll(async () => {
    await t?.close();
    await rm(dist, { recursive: true, force: true });
  });

  test("the server still starts and /healthz answers", async () => {
    const res = await t.app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
  });

  test("a shell page with a session says the web app is not built, and nothing else", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: "/",
      headers: { accept: HTML },
      cookies: { [SESSION_COOKIE]: t.session },
    });
    expect(res.statusCode).toBe(503);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toBe("The Platehouse web app is not built.");
    expect(res.body).not.toContain(dist);
  });

  test("an asset is a plain 404", async () => {
    const res = await t.app.inject({ method: "GET", url: "/assets/index-AbC123.js" });
    expect(res.statusCode).toBe(404);
  });
});
