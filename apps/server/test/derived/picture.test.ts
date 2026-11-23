// Issue #389: an STL's or STEP file's preview status is a pure function of
// stored facts. These pin that function, previewState, branch by branch, and
// that only an ok picture is shown.
import { describe, expect, test } from "vitest";
import { DERIVED_MESSAGES } from "../../src/derived/client.js";
import {
  isPictureShown,
  PREVIEW_RETRIED,
  type PreviewFacts,
  previewState,
} from "../../src/derived/picture.js";

const CURRENT = "0190a0b0-0000-7000-8000-0000000000c1";
const EARLIER = "0190a0b0-0000-7000-8000-0000000000c0";
const REPLACEMENT = "0190a0b0-0000-7000-8000-0000000000c2";

const none: PreviewFacts = {
  kind: "stl",
  sourceBlobId: CURRENT,
  pictureSourceBlobId: null,
  previewJobLive: false,
  failureSourceBlobId: null,
  failureMessage: null,
};

describe("previewState", () => {
  test("a picture of the current source is ok, whatever else is true", () => {
    expect(
      previewState({
        ...none,
        pictureSourceBlobId: CURRENT,
        previewJobLive: true,
        failureSourceBlobId: CURRENT,
        failureMessage: "ERROR: an older attempt",
      }),
    ).toEqual({ status: "ok", message: null });
  });

  test("a picture of an earlier source is not ok", () => {
    expect(previewState({ ...none, pictureSourceBlobId: EARLIER })).toEqual({
      status: null,
      message: null,
    });
  });

  test("with no picture of the current source, a live job for it is pending", () => {
    expect(previewState({ ...none, pictureSourceBlobId: EARLIER, previewJobLive: true })).toEqual({
      status: "pending",
      message: null,
    });
  });

  test("with nothing live, the newest failed attempt for the current source is failed, with its reason", () => {
    expect(
      previewState({ ...none, failureSourceBlobId: CURRENT, failureMessage: "ERROR: bad facet" }),
    ).toEqual({ status: "failed", message: "ERROR: bad facet" });
    for (const outage of PREVIEW_RETRIED) {
      expect(
        previewState({ ...none, failureSourceBlobId: CURRENT, failureMessage: outage }),
      ).toEqual({ status: "failed", message: outage });
    }
  });

  test("a failure of another source, such as a replacement that was not saved, changes nothing", () => {
    expect(
      previewState({ ...none, failureSourceBlobId: REPLACEMENT, failureMessage: "ERROR: x" }),
    ).toEqual({ status: null, message: null });
    expect(
      previewState({
        ...none,
        pictureSourceBlobId: CURRENT,
        failureSourceBlobId: REPLACEMENT,
        failureMessage: "The slicer could not render this file.",
      }),
    ).toEqual({ status: "ok", message: null });
  });

  test("a STEP file follows the same rules", () => {
    expect(previewState({ ...none, kind: "step", pictureSourceBlobId: CURRENT })).toEqual({
      status: "ok",
      message: null,
    });
    expect(previewState({ ...none, kind: "step", previewJobLive: true })).toEqual({
      status: "pending",
      message: null,
    });
  });

  test("every other kind has no picture status", () => {
    for (const kind of ["3mf", "scad"] as const) {
      expect(
        previewState({
          ...none,
          kind,
          pictureSourceBlobId: CURRENT,
          previewJobLive: true,
          failureSourceBlobId: CURRENT,
          failureMessage: "x",
        }),
      ).toEqual({ status: null, message: null });
    }
  });

  test("the outage reasons the backfill retries say so", () => {
    expect(PREVIEW_RETRIED.length).toBe(4);
    for (const message of PREVIEW_RETRIED) {
      expect(message).toMatch(/tried again automatically/);
      expect(message).not.toMatch(/started again/);
    }
  });
});

describe("a temp file problem (issue #415)", () => {
  test("says it will be tried again, and the backfill tries it again", () => {
    expect(DERIVED_MESSAGES.previewTempFailed).toBe(
      "Platehouse could not write a temporary file; it will be tried again automatically.",
    );
    expect(PREVIEW_RETRIED).toContain(DERIVED_MESSAGES.previewTempFailed);
  });

  test("is not the render check's sentence, which the backfill leaves alone", () => {
    expect(DERIVED_MESSAGES.previewTempFailed).not.toBe(DERIVED_MESSAGES.renderLost);
    expect(PREVIEW_RETRIED).not.toContain(DERIVED_MESSAGES.renderLost);
  });
});

describe("isPictureShown", () => {
  test("only an ok picture is shown", () => {
    expect(isPictureShown("ok")).toBe(true);
    for (const status of ["pending", "failed", null]) expect(isPictureShown(status)).toBe(false);
  });
});
