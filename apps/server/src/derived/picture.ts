// An STL's or STEP file's preview picture (issues #316, #380 and #389): its
// status as a pure function of stored facts, and when the picture is shown.
//
// Two review rounds kept finding sequences (a replacement, a stale job, an
// outage) that left the status wrong, because each transition wrote the
// status itself, guessing what the others had done. Now every transaction
// that changes a fact about a file's picture writes only the facts, and
// then derived.ts's recomputePreview reads them back and stores what
// previewState returns, in the same transaction. The facts are:
//
// - the file's current source (files.blob_id);
// - the source the stored picture was made from (preview_source_blob_id,
//   only counted while render_png_blob_id names a stored render_png blob);
// - whether a picture job (render-stl or preview-step) for the current
//   source is queued or running, read from the queue;
// - the source the newest failed picture attempt was for, and why
//   (preview_failure_source_blob_id, preview_failure_message).
//
// A replacement that is not saved never changes the facts about the current
// source, so it never changes the picture's status. The library card
// (app-api/library.ts) and the model page (app-api/model.ts) show a stored
// picture only when the status is ok.
import type { FileKind } from "../db/types.js";
import { DERIVED_MESSAGES } from "./client.js";

/** The file kinds that get a preview picture of their own: STL and STEP. */
export function hasPreviewPicture(kind: FileKind): boolean {
  return kind === "stl" || kind === "step";
}

/**
 * Whether a stored picture is shown, by its status: only when it is ok,
 * which is exactly "the stored picture was made from the file's current
 * source". Pending, failed and none all mean there is no picture of the
 * current source, so the card shows the file-type icon.
 */
export function isPictureShown(previewStatus: string | null): boolean {
  return previewStatus === "ok";
}

/**
 * The failures of a picture the preview backfill queues again by itself:
 * the slicer or storage stayed down past the 2-hour wait (a slicer image
 * older than the app, which answers the preview route 404, ends this way
 * too), and a job that could not be queued. Each says it will be tried
 * again automatically (issue #379). Every other failure is the file's, or
 * is how a file that crashes or hangs the slicer ends (a slicer error, a
 * render that did not finish), or a store refusal that a retry does not
 * cure, and is not queued again (issue #90).
 */
export const PREVIEW_RETRIED: readonly string[] = [
  DERIVED_MESSAGES.previewSlicerDown,
  DERIVED_MESSAGES.previewStoreDown,
  DERIVED_MESSAGES.previewQueueFailed,
];

/** The stored facts a file's picture status is worked out from. */
export interface PreviewFacts {
  kind: FileKind;
  /** The file's current source (files.blob_id). */
  sourceBlobId: string;
  /** The source the stored picture was made from; null with no stored picture. */
  pictureSourceBlobId: string | null;
  /** Whether a picture job for the current source is queued or running. */
  previewJobLive: boolean;
  /** The source the newest failed picture attempt was for. */
  failureSourceBlobId: string | null;
  /** Why it failed. */
  failureMessage: string | null;
}

export type PreviewStatus = "pending" | "ok" | "failed";

/**
 * The picture's status and message from the facts, in this order: a picture
 * of the current source is ok; else a live job for the current source is
 * pending; else the newest failed attempt for the current source is failed,
 * with its reason (one of PREVIEW_RETRIED when it was an outage, which the
 * backfill tries again); else there is none, and the backfill queues one.
 * Every kind but STL and STEP has none.
 */
export function previewState(facts: PreviewFacts): {
  status: PreviewStatus | null;
  message: string | null;
} {
  if (!hasPreviewPicture(facts.kind)) return { status: null, message: null };
  if (facts.pictureSourceBlobId !== null && facts.pictureSourceBlobId === facts.sourceBlobId) {
    return { status: "ok", message: null };
  }
  if (facts.previewJobLive) return { status: "pending", message: null };
  if (facts.failureSourceBlobId === facts.sourceBlobId && facts.failureMessage !== null) {
    return { status: "failed", message: facts.failureMessage };
  }
  return { status: null, message: null };
}
