// The headless routes through Traefik (build plan Task 22; AC-082 through
// Traefik, AC-041, AC-080, lesson 1). Platehouse has two cookieless routes,
// the Public API v1 and slicer links. If a proxy login or the app's session
// gate covered either, it would redirect to login and pass every unit test
// (Cairn's OAuth loop, v0.9.16). Each request here goes through Traefik on
// https://platehouse.e2e.test from a request context with no cookie at all.
import { type APIRequestContext, expect, request, test } from "@playwright/test";
import { ISSUER, ORIGIN } from "../support/env.js";
import { HOSTILE_NAME, readSeed, type Seed, sha256 } from "../support/seed.js";

let seed: Seed;
/** No storage state, no cookie, no token. */
let bare: APIRequestContext;

test.beforeAll(async () => {
  seed = readSeed();
  bare = await request.newContext({
    baseURL: ORIGIN,
    ignoreHTTPSErrors: true,
    storageState: { cookies: [], origins: [] },
  });
});

test.afterAll(async () => {
  await bare.dispose();
});

test.describe("the Public API v1 through Traefik", () => {
  test("a token request with no cookie succeeds", async () => {
    const res = await bare.get(`/api/v1/models/${seed.calibration.modelId}`, {
      headers: { authorization: `Bearer ${seed.token}` },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("application/json");
    expect(res.headers()["set-cookie"]).toBeUndefined();
    const model = (await res.json()) as { id: string; files: { id: string }[] };
    expect(model.id).toBe(seed.calibration.modelId);
    expect(model.files.map((f) => f.id)).toContain(seed.calibration.fileId);
  });

  test("a file's content streams to a token with no cookie", async () => {
    const res = await bare.get(`/api/v1/files/${seed.calibration.fileId}/content`, {
      headers: { authorization: `Bearer ${seed.token}` },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(200);
    expect(sha256(await res.body())).toBe(seed.calibration.sha256);
  });

  test("no token is a 401 JSON answer, not a redirect to login", async () => {
    const res = await bare.get("/api/v1/models", { maxRedirects: 0 });
    expect(res.status()).toBe(401);
    expect(res.headers()["content-type"]).toContain("application/json");
    expect(res.headers().location).toBeUndefined();
  });

  test("a session cookie alone does not open the API", async ({ page }) => {
    // The page context carries the signed-in session from the global setup.
    const res = await page.request.get("/api/v1/models", { maxRedirects: 0 });
    expect(res.status()).toBe(401);
    expect(res.headers().location).toBeUndefined();
  });
});

test.describe("slicer links through Traefik", () => {
  async function mint(page: import("@playwright/test").Page, fileId: string) {
    const res = await page.request.post(`/app/api/files/${fileId}/slicer-link`, {
      headers: { origin: ORIGIN },
    });
    expect(res.status()).toBe(200);
    return (await res.json()) as { url: string; expiresAt: string };
  }

  test("a link with no cookie returns the file", async ({ page }) => {
    const { url } = await mint(page, seed.calibration.fileId);
    const link = new URL(url);
    expect(link.origin).toBe(ORIGIN);
    expect(link.search).toBe("");
    expect(link.pathname.startsWith("/s/")).toBe(true);
    expect(decodeURIComponent(link.pathname.split("/").pop() ?? "")).toBe("Calibration cubes.3mf");

    const res = await bare.get(link.pathname, { maxRedirects: 0 });
    expect(res.status()).toBe(200);
    expect(res.headers().location).toBeUndefined();
    expect(sha256(await res.body())).toBe(seed.calibration.sha256);
  });

  test("a link for a file with a hostile name works through Traefik", async ({ page }) => {
    const { url } = await mint(page, seed.hostile.fileId);
    const link = new URL(url);
    expect(link.search).toBe("");
    // Sent exactly as minted: the raw path, not one the client re-encodes.
    const res = await bare.get(`${ORIGIN}${link.pathname}`, { maxRedirects: 0 });
    expect(res.status()).toBe(200);
    expect(sha256(await res.body())).toBe(seed.hostile.sha256);
    const disposition = res.headers()["content-disposition"] ?? "";
    const encoded = /filename\*=UTF-8''([^;\s]+)/.exec(disposition)?.[1] ?? "";
    expect(decodeURIComponent(encoded)).toBe(HOSTILE_NAME);
  });

  test("an altered link is refused with no bytes", async ({ page }) => {
    const { url } = await mint(page, seed.calibration.fileId);
    const link = new URL(url);
    const parts = link.pathname.split("/");
    const token = parts[2] ?? "";
    const flipped = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    const res = await bare.get(["", "s", flipped, parts[3] ?? ""].join("/"), { maxRedirects: 0 });
    expect(res.status()).toBe(403);
    expect((await res.body()).length).toBe(0);
  });
});

test.describe("UI routes through Traefik", () => {
  test("a page with no cookie redirects to /auth/login", async () => {
    for (const path of ["/", "/settings", `/models/${seed.calibration.modelId}`]) {
      const res = await bare.get(path, { maxRedirects: 0 });
      expect(res.status(), path).toBe(302);
      const location = new URL(res.headers().location ?? "", ORIGIN);
      expect(location.origin, path).toBe(ORIGIN);
      expect(location.pathname, path).toBe("/auth/login");
    }
  });

  test("the app API with no cookie is a 401, not a page", async () => {
    const res = await bare.get("/app/api/library", { maxRedirects: 0 });
    expect(res.status()).toBe(401);
    expect(res.headers().location).toBeUndefined();
  });

  test("/auth/login sends the browser to the issuer with the public redirect_uri", async () => {
    const res = await bare.get("/auth/login", { maxRedirects: 0 });
    expect(res.status()).toBe(302);
    const authorize = new URL(res.headers().location ?? "");
    expect(`${authorize.origin}${authorize.pathname}`).toBe(`${ISSUER}/authorize`);
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/callback`);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
  });

  test("a fresh browser signs in through the issuer and lands on the library", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      storageState: { cookies: [], origins: [] },
    });
    try {
      const page = await context.newPage();
      await page.goto(`${ORIGIN}/settings`);
      expect(new URL(page.url()).origin).toBe(ORIGIN);
      await expect(page.getByRole("heading", { level: 1, name: "Library" })).toBeVisible();
      const cookies = await context.cookies(ORIGIN);
      const session = cookies.find((c) => c.name.startsWith("__Host-"));
      expect(session?.secure).toBe(true);
      expect(session?.httpOnly).toBe(true);
    } finally {
      await context.close();
    }
  });
});
