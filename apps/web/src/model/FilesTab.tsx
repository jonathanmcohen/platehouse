// The Files tab (build plan Task 20): every file of the model with its type
// and size, View (shows it in the viewer on the left), Download (Task 17's
// /files/:id/download), and, for a .3mf, Open in Bambu Studio and Open in
// OrcaSlicer (AC-040). A SCAD file shows its rendered preview image, and a
// render that failed shows OpenSCAD's own message (AC-052).
import type { ModelFile } from "./ModelPage";
import { OpenInSlicer, type Platform } from "./OpenInSlicer";
import { parseStatusWords } from "./PlatesTab";

const KIND_LABEL: Record<ModelFile["kind"], string> = {
  "3mf": "3MF",
  stl: "STL",
  step: "STEP",
  scad: "SCAD",
};

/** A size as the Files tab shows it: 684 B, 120.6 KB, 89.4 MB. */
export function formatSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Number((bytes / 1000).toFixed(1))} KB`;
  if (bytes < 1_000_000_000) return `${Number((bytes / 1_000_000).toFixed(1))} MB`;
  return `${Number((bytes / 1_000_000_000).toFixed(2))} GB`;
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

export function FilesTab({ files, shown, onView, navigateTo, platform }: FilesTabProps) {
  return (
    <ul className="studio-list">
      {files.map((file) => {
        const words = file.kind === "3mf" ? parseStatusWords(file) : null;
        return (
          <li key={file.id} className="studio-list-item">
            <div className="studio-row">
              <h3 className="ph-file-title">{file.name}</h3>
              <span className="studio-muted">
                {KIND_LABEL[file.kind]}, {formatSize(file.size)}
              </span>
            </div>
            {file.preview === null ? null : (
              <img className="ph-file-preview" src={file.preview} alt={`Preview of ${file.name}`} />
            )}
            {words === null ? null : <p className="studio-muted">{words}</p>}
            {file.derivedMessage === null ? null : (
              <pre className="ph-detail">{file.derivedMessage}</pre>
            )}
            <div className="studio-actions">
              {viewable(file) ? (
                <button
                  type="button"
                  className="studio-button"
                  aria-pressed={shown === file.id}
                  onClick={() => onView(file.id)}
                >
                  View<span className="studio-visually-hidden"> {file.name}</span>
                </button>
              ) : null}
              <a className="studio-button" href={file.download}>
                Download<span className="studio-visually-hidden"> {file.name}</span>
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
