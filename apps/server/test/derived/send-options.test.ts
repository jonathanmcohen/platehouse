// Issue #441: a STEP conversion's job expiry covers storing its mesh. Its
// time budget, 750 s, is the slicer's (RENDER_UPLOAD_TIMEOUT_MS plus
// RENDER_TIMEOUT_MS); the GLB is put to the bucket after that, so under
// pg-boss's default 15-minute expiry a slow bucket could have the job
// expired and run again after it had stored the mesh. Every send of a
// conversion job, the wait for a slicer or store that is down included,
// carries CONVERT_EXPIRE_SECONDS; the other slicer job kinds keep their
// options as they were. The integration suite (test/integration/derived/
// step.test.ts) checks the sends themselves on a real pg-boss.
import { describe, expect, test } from "vitest";
import {
  CONVERT_EXPIRE_SECONDS,
  RENDER_TIMEOUT_MS,
  RENDER_UPLOAD_TIMEOUT_MS,
} from "../../src/derived/client.js";
import {
  convertExpiryFor,
  DERIVED_KINDS,
  renderTarget,
  slicerSendOptions,
} from "../../src/derived/derived.js";
import { defaultTimeouts } from "../../src/estimates/slicer-state.js";
import { SLICER_RETRY } from "../../src/jobs/queues.js";

describe("slicerSendOptions", () => {
  test("a STEP conversion may run for its budget plus 300 s to store the mesh", () => {
    expect(CONVERT_EXPIRE_SECONDS).toBe(1050);
    expect(CONVERT_EXPIRE_SECONDS).toBe(
      (RENDER_UPLOAD_TIMEOUT_MS + RENDER_TIMEOUT_MS) / 1000 + 300,
    );
  });

  test("a STEP conversion job is sent with its expiry beside its retry settings", () => {
    expect(slicerSendOptions(DERIVED_KINDS.convertStep, { ...SLICER_RETRY })).toEqual({
      ...SLICER_RETRY,
      expireInSeconds: CONVERT_EXPIRE_SECONDS,
    });
  });

  test("the wait-out requeue of a STEP conversion keeps its wait and retries, and gets the expiry", () => {
    const options = { ...SLICER_RETRY, retryLimit: 1, startAfter: 40 };
    expect(slicerSendOptions(DERIVED_KINDS.convertStep, options)).toEqual({
      ...SLICER_RETRY,
      retryLimit: 1,
      startAfter: 40,
      expireInSeconds: CONVERT_EXPIRE_SECONDS,
    });
  });

  test.each([DERIVED_KINDS.renderScad, DERIVED_KINDS.renderStl, DERIVED_KINDS.previewStep])(
    "a %s job is sent with its options unchanged",
    (kind) => {
      const options = { ...SLICER_RETRY, startAfter: 40 };
      const sent = slicerSendOptions(kind, options);
      expect(sent).toEqual({ ...SLICER_RETRY, startAfter: 40 });
      expect(sent).not.toHaveProperty("expireInSeconds");
    },
  );
});

describe("slicerSendOptions from the slicer's time limits", () => {
  test("a STEP conversion expires at the limits' conversion expiry", () => {
    expect(slicerSendOptions(DERIVED_KINDS.convertStep, {}, 1234)).toEqual({
      expireInSeconds: 1234,
    });
  });

  test("the fallback expiry is the default one, 1050 s", () => {
    expect(CONVERT_EXPIRE_SECONDS).toBe(1050);
  });
});

describe("renderTarget", () => {
  const url = "http://slicer:8080";
  const limits = { sliceSeconds: 180, scadSeconds: 600, stepSeconds: 300, uploadSeconds: 900 };

  test("a render's answer timer is the slicer's scad limit plus 30 s", () => {
    expect(renderTarget(url, DERIVED_KINDS.renderScad, limits)).toEqual({
      baseUrl: url,
      timeoutMs: 630_000,
      uploadTimeoutMs: 900_000,
    });
  });

  test("a STEP conversion's answer timer is the step limit plus 30 s", () => {
    expect(renderTarget(url, DERIVED_KINDS.convertStep, limits).timeoutMs).toBe(330_000);
  });

  test("the defaults give the fallback timers", () => {
    const target = renderTarget(url, DERIVED_KINDS.renderScad, defaultTimeouts(120));
    expect(target.timeoutMs).toBe(RENDER_TIMEOUT_MS);
    expect(target.uploadTimeoutMs).toBe(RENDER_UPLOAD_TIMEOUT_MS);
  });

  test("a timer the deps set is kept", () => {
    expect(
      renderTarget(url, DERIVED_KINDS.renderScad, limits, { timeoutMs: 5, uploadTimeoutMs: 6 }),
    ).toEqual({ baseUrl: url, timeoutMs: 5, uploadTimeoutMs: 6 });
  });
});

describe("convertExpiryFor", () => {
  const limits = { sliceSeconds: 180, scadSeconds: 120, stepSeconds: 300, uploadSeconds: 900 };

  test("a STEP conversion's expiry follows the slicer's limits", async () => {
    const state = { current: async () => ({ timeouts: limits, sandbox: null }) };
    expect(await convertExpiryFor(DERIVED_KINDS.convertStep, state)).toBe(900 + 300 + 30 + 300);
  });

  test.each([DERIVED_KINDS.renderScad, DERIVED_KINDS.renderStl, DERIVED_KINDS.previewStep])(
    "a %s send does not ask the slicer's health",
    async (kind) => {
      let asked = 0;
      const state = {
        current: async () => {
          asked += 1;
          return { timeouts: limits, sandbox: null };
        },
      };
      expect(await convertExpiryFor(kind, state)).toBe(CONVERT_EXPIRE_SECONDS);
      expect(asked).toBe(0);
    },
  );

  test("without a state, the fallback expiry stands", async () => {
    expect(await convertExpiryFor(DERIVED_KINDS.convertStep, undefined)).toBe(1050);
  });
});
