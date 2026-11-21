// Platehouse's logo, icon A "Layered house" (the maintainer's pick, 2026-11-19): a roof
// over three stacked print layers, on a 64 x 64 viewBox, exactly as picked.
// The small art is the 16 px version: a heavier roof and two thicker layers,
// so it stays crisp at that size.
//
// This is the one copy of the geometry. The Logo component draws it in the
// current accent, and tools/brand/generate.ts draws it into the static icon
// files (favicons, app icons, the docs logos) in the default accent. It has
// no colour of its own.

export interface LogoLayer {
  x: number;
  y: number;
  width: number;
  height: number;
  rx: number;
  /** 1 for the top layer; the lower layers fade. */
  opacity: number;
}

export interface LogoArt {
  /** The roof: an open path, stroked with round caps and joins. */
  roof: { d: string; strokeWidth: number };
  layers: readonly LogoLayer[];
}

/** The logo's viewBox side, in its own units. */
export const LOGO_VIEWBOX = 64;

/** The full icon, for 32 px and up. */
export const FULL_ART: LogoArt = {
  roof: { d: "M9 29 L32 10 L55 29", strokeWidth: 6 },
  layers: [
    { x: 15, y: 32, width: 34, height: 6, rx: 2, opacity: 1 },
    { x: 15, y: 41, width: 34, height: 6, rx: 2, opacity: 0.78 },
    { x: 15, y: 50, width: 34, height: 6, rx: 2, opacity: 0.56 },
  ],
};

/** The small icon, for 16 px. */
export const SMALL_ART: LogoArt = {
  roof: { d: "M9 29 L32 10 L55 29", strokeWidth: 7 },
  layers: [
    { x: 14, y: 33, width: 36, height: 9, rx: 2, opacity: 1 },
    { x: 14, y: 47, width: 36, height: 9, rx: 2, opacity: 0.7 },
  ],
};
