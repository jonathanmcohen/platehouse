// A .3mf in the viewer area (build plan Task 20, AC-051): the selected
// plate's thumbnail large, with the plate strip under it. A .3mf never gets
// a 3D view, so nothing here loads three.js.
import type { ModelFile } from "./ModelPage";
import { PlateStrip, plateLabel } from "./PlateStrip";

export interface PlateViewerProps {
  file: ModelFile;
  /** The index of the plate shown large. */
  selected: number;
  onSelect(index: number): void;
}

export function PlateViewer({ file, selected, onSelect }: PlateViewerProps) {
  const plates = [...file.plates].sort((a, b) => a.index - b.index);
  const shown = plates.find((p) => p.index === selected) ?? plates[0];
  return (
    <>
      <div className="studio-viewer-frame">
        {shown === undefined ? (
          <p className="studio-placeholder">This file has no plate thumbnails.</p>
        ) : shown.thumbnail === null ? (
          <p className="studio-placeholder">No thumbnail for {plateLabel(shown)}.</p>
        ) : (
          <img
            className="studio-plate-large"
            src={shown.thumbnail}
            alt={`Plate ${shown.index}: ${plateLabel(shown)}`}
          />
        )}
      </div>
      <PlateStrip plates={plates} selected={shown?.index ?? 0} onSelect={onSelect} />
    </>
  );
}
