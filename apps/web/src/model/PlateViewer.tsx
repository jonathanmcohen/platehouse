// A .3mf in the viewer area: the selected
// plate's thumbnail large, with the plate strip under it. The large image has
// buttons to turn and flip it on screen (PlateImage). It is keyed by file and
// plate, so a turn lasts only while that plate of that file is shown.
//
// The plate's 3D view (issue #358): Show in 3D, a real button under the
// picture, or a click on the picture itself, shows the objects on that plate
// in the 3D viewer (Plate3d), which three.js is loaded for only then. Show
// picture, in the same place, goes back to the picture. Focus follows the
// button, so a keyboard user lands on Show picture when the view opens and
// on Show in 3D when it closes. While the view is open, choosing another
// plate in the strip shows that plate in 3D. A plate whose 3D view cannot
// be shown (no mesh the server can read, the file unavailable, no WebGL)
// goes back to its picture, says why under it, and puts focus back on Show
// in 3D; the reason goes when the view is opened again or another plate is
// chosen. The reason is put in a status region that is on the page in every
// mode, empty until then, so a screen reader announces it after the focus
// move. A plate with no thumbnail still has Show in 3D.
import { useEffect, useRef, useState } from "react";
import { type MessageKey, useI18n } from "../i18n/I18n";
import type { ModelFile } from "./ModelPage";
import { Plate3d, type Plate3dFailure } from "./Plate3d";
import { PlateImage } from "./PlateImage";
import { PlateStrip, plateLabel } from "./PlateStrip";
import type { ThreeLoader } from "./Viewer3d";

/** What each failure says, with the plate's label. */
const FAILURE_WORDS: Readonly<Record<Plate3dFailure, MessageKey>> = {
  no_plate: "model.plate3d.failed.noPlate",
  no_objects: "model.plate3d.failed.noObjects",
  no_mesh: "model.plate3d.failed.noMesh",
  too_large: "model.plate3d.failed.tooLarge",
  damaged: "model.plate3d.failed.damaged",
  unavailable: "model.plate3d.failed.unavailable",
  busy: "model.plate3d.failed.busy",
  signedOut: "common.signedOut",
  browser: "model.plate3d.failed.browser",
  error: "model.plate3d.failed.error",
};

export interface PlateViewerProps {
  file: ModelFile;
  /** The index of the plate shown large. */
  selected: number;
  onSelect(index: number): void;
  /** three.js for the plate's 3D view; the real one, imported on first use, when left out. */
  loadThree?: ThreeLoader | undefined;
}

export function PlateViewer({ file, selected, onSelect, loadThree }: PlateViewerProps) {
  const i18n = useI18n();
  const plates = [...file.plates].sort((a, b) => a.index - b.index);
  const shown = plates.find((p) => p.index === selected) ?? plates[0];
  const [inThreeD, setInThreeD] = useState(false);
  const [failed, setFailed] = useState<{ plateId: string; failure: Plate3dFailure } | null>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  /** Set by the user's own open, close or failure, so focus moves only then. */
  const refocus = useRef(false);

  // The toggle is a new element in each mode, so focus is put back on it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: inThreeD and failed are the triggers: focus moves after the mode the user chose is on screen.
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    toggleRef.current?.focus();
  }, [inThreeD, failed]);

  function open() {
    refocus.current = true;
    setFailed(null);
    setInThreeD(true);
  }

  function close() {
    refocus.current = true;
    setInThreeD(false);
  }

  function select(index: number) {
    setFailed(null);
    onSelect(index);
  }

  if (shown === undefined) {
    return (
      <>
        <div className="studio-viewer-frame">
          <p className="studio-placeholder">{i18n.t("model.plate.noThumbnails")}</p>
        </div>
        <PlateStrip plates={plates} selected={0} onSelect={select} />
      </>
    );
  }

  const label = plateLabel(shown, i18n);
  const toggle = (
    <div className="studio-actions">
      <button
        ref={toggleRef}
        type="button"
        className="studio-button ph-plate-view-toggle"
        onClick={inThreeD ? close : open}
      >
        {i18n.t(inThreeD ? "model.plate3d.close" : "model.plate3d.open")}
      </button>
    </div>
  );
  const words =
    failed === null || failed.plateId !== shown.id
      ? null
      : i18n.t(FAILURE_WORDS[failed.failure], { label });
  // Always in the page, empty until a failure, so a screen reader hears what
  // is put in it after the focus move.
  const reason = (
    <div role="status" data-plate-view-status>
      {words === null ? null : <p className="studio-alert studio-alert-alert">{words}</p>}
    </div>
  );

  return (
    <>
      {inThreeD ? (
        <Plate3d
          key={`${file.id}:${shown.id}`}
          plateId={shown.id}
          label={label}
          download={file.download}
          loadThree={loadThree}
          actions={toggle}
          onFailed={(failure) => {
            refocus.current = true;
            setFailed({ plateId: shown.id, failure });
            setInThreeD(false);
          }}
        />
      ) : shown.thumbnail === null ? (
        <>
          <div className="studio-viewer-frame">
            <p className="studio-placeholder">{i18n.t("model.plate.noThumbnail", { label })}</p>
          </div>
          {toggle}
        </>
      ) : (
        <PlateImage
          key={`${file.id}:${shown.index}`}
          src={shown.thumbnail}
          alt={i18n.t("model.plate.alt", { index: shown.index, label })}
          onOpen={open}
          openLabel={i18n.t("model.plate3d.openLabel", { label })}
          actions={toggle}
        />
      )}
      {reason}
      <PlateStrip plates={plates} selected={shown.index} onSelect={select} />
    </>
  );
}
