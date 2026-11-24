// An encoded slash in an API path through Traefik (#452). The Public API's tag
// route takes the tag as one path segment, so a tag named "a/b" arrives as
// /api/v1/models/<id>/tags/a%2Fb, and the reverse proxy guide requires the
// proxy to pass %2F on without decoding it. A proxy that decodes it turns it
// into a path with one more segment, which is a 404, and a proxy that refuses
// it answers 400. Unit tests never go through a proxy, so only this spec
// would notice. The request has no cookie, only the run's API token.
import { type APIRequestContext, expect, request, test } from "@playwright/test";
import { ORIGIN } from "../support/env.js";
import { readSeed, type Seed } from "../support/seed.js";

let seed: Seed;
let api: APIRequestContext;

test.beforeAll(async () => {
  seed = readSeed();
  api = await request.newContext({
    baseURL: ORIGIN,
    ignoreHTTPSErrors: true,
    storageState: { cookies: [], origins: [] },
    extraHTTPHeaders: { authorization: `Bearer ${seed.token}` },
  });
});

test.afterAll(async () => {
  await api.dispose();
});

async function tagsOf(modelId: string): Promise<string[]> {
  const res = await api.get(`/api/v1/models/${modelId}`, { maxRedirects: 0 });
  expect(res.status()).toBe(200);
  return ((await res.json()) as { tags: string[] }).tags;
}

test("a tag with a slash is added and removed through an encoded %2F", async () => {
  // The hostile-name model, so the seeded calibration model's tags stay as they were.
  const path = `/api/v1/models/${seed.hostile.modelId}/tags/a%2Fb`;
  expect(await tagsOf(seed.hostile.modelId)).not.toContain("a/b");

  const added = await api.put(path, { maxRedirects: 0 });
  expect(added.status()).toBe(204);
  expect(await tagsOf(seed.hostile.modelId)).toContain("a/b");

  const removed = await api.delete(path, { maxRedirects: 0 });
  expect(removed.status()).toBe(204);
  expect(await tagsOf(seed.hostile.modelId)).not.toContain("a/b");
});
