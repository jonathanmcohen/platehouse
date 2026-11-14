// The end-to-end run's setup (build plan Task 22): signs in once through
// Traefik and the mock issuer, the way a browser signs in to Pocket ID, and
// fills the library the specs look at. It is a global setup, not a test, so
// the CI guard counts only real specs.
//
// Sign-in: a fresh browser opens /, the gate sends it to /auth/login, the
// app sends it to the issuer's authorize endpoint, the issuer signs the test
// user in at once and sends it back to /auth/callback, and the app sets its
// session cookie and sends it to /. The browser state is saved for the specs.
//
// The library (support/seed.ts): an API token from POST /app/api/tokens,
// three generated .3mf files uploaded through /api/v1/uploads with that token
// and no cookie, a tag and a collection on one model, and one model trashed.
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium, request } from "@playwright/test";
import { buildSliceable } from "../packages/threemf/test/support/sliceable.js";
import { ORIGIN, RUN_DIR, SEED_PATH, STATE_PATH } from "./support/env.js";
import { HOSTILE_NAME, type Seed, uploadFile, waitForNumbers } from "./support/seed.js";

export default async function globalSetup(): Promise<void> {
  mkdirSync(RUN_DIR, { recursive: true });
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: ORIGIN });
    const page = await context.newPage();
    await page.goto("/");
    const landed = new URL(page.url());
    if (landed.origin !== ORIGIN || landed.pathname !== "/") {
      throw new Error(`signing in through the issuer ended at ${landed.origin}${landed.pathname}`);
    }
    await context.storageState({ path: STATE_PATH });

    const minted = await page.request.post("/app/api/tokens", {
      data: { name: "e2e run" },
      headers: { origin: ORIGIN },
    });
    if (minted.status() !== 201) {
      throw new Error(`POST /app/api/tokens answered ${minted.status()}`);
    }
    const { token } = (await minted.json()) as { token: string };

    const api = await request.newContext({
      baseURL: ORIGIN,
      ignoreHTTPSErrors: true,
      extraHTTPHeaders: { authorization: `Bearer ${token}` },
    });
    try {
      const calibration = await uploadFile(
        api,
        "Calibration cubes.3mf",
        buildSliceable({ plates: 3, filaments: 2 }),
      );
      const hostile = await uploadFile(
        api,
        HOSTILE_NAME,
        buildSliceable({ plates: 1, filaments: 1 }),
      );
      const trashed = await uploadFile(
        api,
        "Old bracket.3mf",
        buildSliceable({ plates: 1, filaments: 1 }),
      );

      for (const path of [
        `/api/v1/models/${calibration.modelId}/tags/e2e`,
        `/api/v1/collections/${encodeURIComponent("E2E set")}/models/${calibration.modelId}`,
      ]) {
        const res = await api.put(path);
        if (res.status() !== 204) throw new Error(`PUT ${path} answered ${res.status()}`);
      }

      await waitForNumbers(api, calibration.modelId);
      await waitForNumbers(api, hostile.modelId);

      const moved = await page.request.post(`/app/api/models/${trashed.modelId}/trash`, {
        headers: { origin: ORIGIN },
      });
      if (!moved.ok()) throw new Error(`trashing a model answered ${moved.status()}`);

      const seed: Seed = { token, calibration, hostile, trashed };
      writeFileSync(SEED_PATH, JSON.stringify(seed), { mode: 0o600 });
    } finally {
      await api.dispose();
    }
  } finally {
    await browser.close();
  }
}
