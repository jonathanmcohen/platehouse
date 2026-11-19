// The large plate image of a .3mf, with buttons to turn and flip it
// (requested 2026-11-19: some plate thumbnails in Jon's files are upside
// down). The turn is on screen only: nothing is sent to the server and
// nothing is stored, not even in the browser. PlateViewer keys this
// component by file and plate, so choosing another plate, viewing another
// file or opening the model again shows the image as it was stored.
//
// Turns and flips are as seen on screen: Flip horizontal always swaps left
// and right of what is shown, whatever turn came before. The state is the
// picture's quarter turns clockwise (0 to 3) and whether it is mirrored left
// to right and top to bottom, drawn as rotate(), then scaleX() and scaleY()
// in that order (CSS applies the rightmost first, so the mirrors act on the
// image before the turn). A flip on screen after a turn of q is a mirror
// first and a turn of -q (M R(q) = R(-q) M), so a flip negates the turn.
//
// studio.css gives the viewer frame aspect-ratio 4 / 3 and the image
// width and height 100% with object-fit: contain. A quarter-turned 4:3 box
// is 3:4, so it is scaled by 3/4 (QUARTER_TURN_SCALE) to fit back inside
// the frame. A transform never changes layout, so nothing around it moves.
// The buttons are the 3D view's pattern (Viewer3d): a fieldset with a
// hidden legend, text studio-buttons, studio.css's focus ring and tokens.
import { useState } from "react";

/** Height over width of studio.css's .studio-viewer-frame (aspect-ratio: 4 / 3). */
export const QUARTER_TURN_SCALE = 3 / 4;

export interface PlateTransform {
  /** Quarter turns clockwise, 0 to 3. */
  turns: number;
  /** Mirrored left to right, before the turn. */
  flipX: boolean;
  /** Mirrored top to bottom, before the turn. */
  flipY: boolean;
}

export const UNTURNED: PlateTransform = { turns: 0, flipX: false, flipY: false };

const quarter = (n: number) => ((n % 4) + 4) % 4;

export function rotateRight(t: PlateTransform): PlateTransform {
  return { ...t, turns: quarter(t.turns + 1) };
}

export function rotateLeft(t: PlateTransform): PlateTransform {
  return { ...t, turns: quarter(t.turns - 1) };
}

export function flipHorizontal(t: PlateTransform): PlateTransform {
  return { ...t, turns: quarter(-t.turns), flipX: !t.flipX };
}

export function flipVertical(t: PlateTransform): PlateTransform {
  return { ...t, turns: quarter(-t.turns), flipY: !t.flipY };
}

/** The CSS transform for a state; an empty string when the image is as stored. */
export function cssTransform(t: PlateTransform): string {
  const parts: string[] = [];
  if (t.turns !== 0) parts.push(`rotate(${t.turns * 90}deg)`);
  if (t.flipX) parts.push("scaleX(-1)");
  if (t.flipY) parts.push("scaleY(-1)");
  if (t.turns % 2 === 1) parts.push(`scale(${QUARTER_TURN_SCALE})`);
  return parts.join(" ");
}

export interface PlateImageProps {
  src: string;
  alt: string;
}

export function PlateImage({ src, alt }: PlateImageProps) {
  const [transform, setTransform] = useState<PlateTransform>(UNTURNED);
  const css = cssTransform(transform);
  return (
    <>
      <div className="studio-viewer-frame">
        <img
          className="studio-plate-large"
          src={src}
          alt={alt}
          style={css === "" ? undefined : { transform: css }}
        />
      </div>
      <fieldset className="studio-actions ph-viewer-controls ph-plate-controls">
        <legend className="studio-visually-hidden">Plate image controls</legend>
        <button type="button" className="studio-button" onClick={() => setTransform(rotateLeft)}>
          Rotate left
        </button>
        <button type="button" className="studio-button" onClick={() => setTransform(rotateRight)}>
          Rotate right
        </button>
        <button
          type="button"
          className="studio-button"
          onClick={() => setTransform(flipHorizontal)}
        >
          Flip horizontal
        </button>
        <button type="button" className="studio-button" onClick={() => setTransform(flipVertical)}>
          Flip vertical
        </button>
        <button type="button" className="studio-button" onClick={() => setTransform(UNTURNED)}>
          Reset
        </button>
      </fieldset>
    </>
  );
}
