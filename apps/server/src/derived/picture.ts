// When an STL's or STEP file's preview picture is shown (issues #316 and
// #380), in one place, so the library card (app-api/library.ts) and the
// model page (app-api/model.ts) agree. The picture has its own status,
// files.preview_status (migration 0012), apart from derived_status.
import type { FileKind } from "../db/types.js";

/** The file kinds that get a preview picture of their own: STL and STEP. */
export function hasPreviewPicture(kind: FileKind): boolean {
  return kind === "stl" || kind === "step";
}

/**
 * Whether a stored picture is shown, by its status: while it is ok, and
 * while a new one is being made (pending), when the stored picture is still
 * of the file's current version (an earlier version's is deleted, never
 * kept). Not once it failed, which shows the file-type icon and the reason,
 * and not before one was ever queued (null).
 */
export function isPictureShown(previewStatus: string | null): boolean {
  return previewStatus === "ok" || previewStatus === "pending";
}
