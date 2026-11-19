// A .3mf in the viewer area (build plan Task 20, AC-051): the selected
// plate's thumbnail large, with the plate strip under it. A .3mf never gets
// a 3D view, so nothing here loads three.js. The large image has buttons to
// turn and flip it on screen (PlateImage). It is keyed by file and plate, so
// a turn lasts only while that plate of that file is shown.
import type { ModelFile } from "./ModelPage";
import { PlateImage } from "./PlateImage";
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
      {shown === undefined ? (
        <div className="studio-viewer-frame">
          <p className="studio-placeholder">This file has no plate thumbnails.</p>
        </div>
      ) : shown.thumbnail === null ? (
        <div className="studio-viewer-frame">
          <p className="studio-placeholder">No thumbnail for {plateLabel(shown)}.</p>
        </div>
      ) : (
        <PlateImage
          key={`${file.id}:${shown.index}`}
          src={shown.thumbnail}
          alt={`Plate ${shown.index}: ${plateLabel(shown)}`}
        />
      )}
      <PlateStrip plates={plates} selected={shown?.index ?? 0} onSelect={onSelect} />
    </>
  );
}
