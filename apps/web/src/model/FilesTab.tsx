// The Files tab (build plan Task 20): every file of the model with its type
// and size, View (shows it in the viewer on the left), Download (Task 17's
// /files/:id/download), and, for a .3mf, Open in Bambu Studio and Open in
// OrcaSlicer (AC-040). A SCAD file shows its rendered preview image. A STEP
// or SCAD file whose mesh or render is still being made says so, and one
// that failed says it could not be rendered, with the server's reason
// (OpenSCAD's own message for a SCAD it rejects, AC-052). The page polls
// while a render is pending, so View appears here when it lands.
import type { ReactNode } from "react";
import { ENGLISH_I18N, type Formatters, type I18n, type MessageKey, useI18n } from "../i18n/I18n";
import { serverTextWith } from "../i18n/serverText";
import type { ModelFile } from "./ModelPage";
import { OpenInSlicer, type Platform } from "./OpenInSlicer";
import { parseStatusWords } from "./PlatesTab";

const KIND_LABEL: Record<ModelFile["kind"], string> = {
  "3mf": "3MF",
  stl: "STL",
  step: "STEP",
  scad: "SCAD",
};

/** A size as the Files tab shows it: 684 B, 120.6 KB, 89.4 MB. English when no language is given. */
export function formatSize(bytes: number, fmt: Formatters = ENGLISH_I18N.fmt): string {
  return fmt.size(bytes);
}

/** What a STEP or SCAD file says about its mesh or render, by derived status. */
export function derivedStatusWords(
  file: Pick<ModelFile, "derivedStatus">,
  i18n: Pick<I18n, "t"> = ENGLISH_I18N,
): string | null {
  switch (file.derivedStatus) {
    case "pending":
      return i18n.t("model.files.rendering");
    case "failed":
      return i18n.t("model.files.renderFailed");
    default:
      return null;
  }
}

/** Each sentence Platehouse writes about a render, by the code the server sends. */
const DERIVED_KEYS: Readonly<Record<string, MessageKey>> = {
  slicerError: "derived.slicerError",
  replaceFailed: "derived.replaceFailed",
  slicerDown: "derived.slicerDown",
  replaceSlicerDown: "derived.replaceSlicerDown",
  storeDown: "derived.storeDown",
  replaceStoreDown: "derived.replaceStoreDown",
  storeRefused: "derived.storeRefused",
  replaceStoreRefused: "derived.replaceStoreRefused",
  queueFailed: "derived.queueFailed",
  renderLost: "derived.renderLost",
  replaceLost: "derived.replaceLost",
  previousRendersScad: "derived.previousRendersScad",
  previousRendersStep: "derived.previousRendersStep",
  previousScad: "derived.previousScad",
  previousStep: "derived.previousStep",
  scadTooLarge: "derived.scadTooLarge",
  stepTooLarge: "derived.stepTooLarge",
  previewFailed: "derived.previewFailed",
  previewRejected: "derived.previewRejected",
  stlTooLarge: "derived.stlTooLarge",
};

/**
 * What a file says about its render, in the shown language. An English page
 * shows derivedMessage as the server wrote it, never en.json's copy of its
 * sentences. Another language shows Platehouse's own sentences
 * (derivedCodes) in the catalog's words, then the program's own message
 * (derivedDetail) as it is. An answer without codes, or with a code this
 * page does not know, shows derivedMessage as the server wrote it.
 */
export function derivedMessageIn(
  i18n: Pick<I18n, "t" | "locale">,
  file: Pick<ModelFile, "derivedMessage" | "derivedCodes" | "derivedDetail">,
): string | null {
  const sent = file.derivedMessage;
  if (sent === null) return null;
  return serverTextWith(i18n, sent, () => {
    const codes = file.derivedCodes;
    if (
      codes === undefined ||
      codes.length === 0 ||
      codes.some((c) => DERIVED_KEYS[c] === undefined)
    ) {
      return undefined;
    }
    const parts = codes.map((c) => i18n.t(DERIVED_KEYS[c] as MessageKey));
    const detail = file.derivedDetail;
    if (detail !== undefined && detail !== null && detail !== "") parts.push(detail);
    return parts.join(" ");
  });
}

/** Whether the viewer can show the file: a .3mf's plates, a 3D view, or a preview image. */
export function viewable(file: ModelFile): boolean {
  return (
    (file.kind === "3mf" && file.plates.length > 0) || file.view !== null || file.preview !== null
  );
}

export interface FilesTabProps {
  files: ModelFile[];
  /** The file the viewer shows. */
  shown: string | null;
  onView(fileId: string): void;
  navigateTo?: ((url: string) => void) | undefined;
  platform?: Platform | undefined;
}

/** A <hidden> run of a message: text for screen readers only. */
export function hiddenText(children: ReactNode): ReactNode {
  return <span className="studio-visually-hidden">{children}</span>;
}

export function FilesTab({ files, shown, onView, navigateTo, platform }: FilesTabProps) {
  const i18n = useI18n();
  const { t, rich } = i18n;
  return (
    <ul className="studio-list">
      {files.map((file) => {
        const words =
          file.kind === "3mf" ? parseStatusWords(file, i18n) : derivedStatusWords(file, i18n);
        const derived = derivedMessageIn(i18n, file);
        return (
          <li key={file.id} className="studio-list-item">
            <div className="studio-row">
              <h2 className="ph-file-title">{file.name}</h2>
              <span className="studio-muted">
                {t("model.files.kindSize", {
                  kind: KIND_LABEL[file.kind],
                  size: i18n.fmt.size(file.size),
                })}
              </span>
            </div>
            {file.preview === null ? null : (
              <img
                className="ph-file-preview"
                src={file.preview}
                alt={t("model.previewOf", { name: file.name })}
              />
            )}
            {words === null ? null : <p className="studio-muted">{words}</p>}
            {derived === null ? null : <pre className="ph-detail">{derived}</pre>}
            <div className="studio-actions">
              {viewable(file) ? (
                <button
                  type="button"
                  className="studio-button"
                  aria-pressed={shown === file.id}
                  onClick={() => onView(file.id)}
                >
                  {rich("model.files.view", { name: file.name }, { hidden: hiddenText })}
                </button>
              ) : null}
              <a className="studio-button" href={file.download}>
                {rich("model.files.download", { name: file.name }, { hidden: hiddenText })}
              </a>
            </div>
            {file.kind === "3mf" ? (
              <OpenInSlicer
                fileId={file.id}
                fileName={file.name}
                navigateTo={navigateTo}
                platform={platform}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
