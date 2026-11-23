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
import { DERIVED_KINDS, slicerSendOptions } from "../../src/derived/derived.js";
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
