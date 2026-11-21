// The large plate image of a .3mf, with buttons to turn and flip it
// (requested 2026-11-19: some plate thumbnails in real files are upside
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
// width and height 100% with object-fit: contain, so the picture is drawn
// as large as fits inside the frame. A quarter turn scales it down only as
// much as it then needs to fit (quarterTurnScale): not at all for a square
// or tall picture (plate_N.png is usually square), by its height over its
// width up to 4:3, and by 3/4 for anything wider. The picture's shape is
// read when it loads; until then a quarter turn uses 3/4, which fits any
// shape. The image element itself can poke past the frame after a turn,
// but the part outside is empty and the frame clips it. A transform never
// changes layout, so nothing around it moves.
// The buttons are the 3D view's pattern (Viewer3d): a fieldset with a
// hidden legend, text studio-buttons, studio.css's focus ring and tokens.
import { useState } from "react";
import { useI18n } from "../i18n/I18n";

/** Height over width of studio.css's .studio-viewer-frame (aspect-ratio: 4 / 3). */
export const FRAME_RATIO = 3 / 4;

/**
 * How much a quarter turn scales the picture so it stays inside the frame,
 * from the picture's height over its width (null before it has loaded).
 *
 * The frame is W wide and H = 3/4 W high. A picture no wider than 4:3 is
 * drawn H high and H/ratio wide; turned, it is H/ratio high, so it fits at
 * scale ratio (never above 1). A wider picture is drawn W wide; turned, it
 * is W high, so it fits at 3/4.
 */
export function quarterTurnScale(ratio: number | null): number {
  if (ratio === null || !Number.isFinite(ratio) || ratio <= 0) return FRAME_RATIO;
  return Math.min(1, Math.max(FRAME_RATIO, ratio));
}

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

/**
 * The CSS transform for a state and the picture's height over its width
 * (null before it has loaded); an empty string when the image is as stored.
 */
export function cssTransform(t: PlateTransform, ratio: number | null): string {
  const parts: string[] = [];
  if (t.turns !== 0) parts.push(`rotate(${t.turns * 90}deg)`);
  if (t.flipX) parts.push("scaleX(-1)");
  if (t.flipY) parts.push("scaleY(-1)");
  const scale = quarterTurnScale(ratio);
  if (t.turns % 2 === 1 && scale !== 1) parts.push(`scale(${scale})`);
  return parts.join(" ");
}

export interface PlateImageProps {
  src: string;
  alt: string;
}

export function PlateImage({ src, alt }: PlateImageProps) {
  const { t } = useI18n();
  const [transform, setTransform] = useState<PlateTransform>(UNTURNED);
  /** The picture's height over its width, once it has loaded. */
  const [ratio, setRatio] = useState<number | null>(null);
  const css = cssTransform(transform, ratio);
  return (
    <>
      <div className="studio-viewer-frame">
        <img
          className="studio-plate-large"
          src={src}
          alt={alt}
          style={css === "" ? undefined : { transform: css }}
          onLoad={(event) => {
            const { naturalWidth, naturalHeight } = event.currentTarget;
            setRatio(naturalWidth > 0 && naturalHeight > 0 ? naturalHeight / naturalWidth : null);
          }}
        />
      </div>
      <fieldset className="studio-actions ph-viewer-controls ph-plate-controls">
        <legend className="studio-visually-hidden">{t("model.plateImage.controls")}</legend>
        <button type="button" className="studio-button" onClick={() => setTransform(rotateLeft)}>
          {t("viewer.rotateLeft")}
        </button>
        <button type="button" className="studio-button" onClick={() => setTransform(rotateRight)}>
          {t("viewer.rotateRight")}
        </button>
        <button
          type="button"
          className="studio-button"
          onClick={() => setTransform(flipHorizontal)}
        >
          {t("model.plateImage.flipHorizontal")}
        </button>
        <button type="button" className="studio-button" onClick={() => setTransform(flipVertical)}>
          {t("model.plateImage.flipVertical")}
        </button>
        <button type="button" className="studio-button" onClick={() => setTransform(UNTURNED)}>
          {t("model.plateImage.reset")}
        </button>
      </fieldset>
    </>
  );
}
