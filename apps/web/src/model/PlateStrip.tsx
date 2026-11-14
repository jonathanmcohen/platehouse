// The strip of plate thumbnails under a .3mf's large plate image (build plan
// Task 20, AC-051): one 72 px button per plate, in plate order. Pressing one
// shows that plate large; the shown one is aria-pressed. The buttons are in
// the Tab order, so the strip works by keyboard.
import type { ModelPlate } from "./ModelPage";

export function plateLabel(plate: Pick<ModelPlate, "index" | "name">): string {
  return plate.name !== null && plate.name.trim() !== "" ? plate.name : `Plate ${plate.index}`;
}

export interface PlateStripProps {
  plates: ModelPlate[];
  /** The index of the plate shown large. */
  selected: number;
  onSelect(index: number): void;
}

export function PlateStrip({ plates, selected, onSelect }: PlateStripProps) {
  if (plates.length < 2) return null;
  return (
    <ul className="studio-plate-strip" aria-label="Plates">
      {plates.map((plate) => (
        <li key={plate.id}>
          <button
            type="button"
            aria-pressed={plate.index === selected}
            aria-label={`Show plate ${plate.index}: ${plateLabel(plate)}`}
            onClick={() => onSelect(plate.index)}
          >
            {plate.thumbnail === null ? (
              <span className="ph-strip-empty">{plate.index}</span>
            ) : (
              <img src={plate.thumbnail} alt="" loading="lazy" />
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}
