// What the static logo files are, as data and pure functions: the accent
// they are drawn in, each SVG and the web manifest as text, the PNG sizes
// and layouts, and the ICO container. generate.ts writes the files from
// this module (rasterising the PNGs in Chromium); apps/web/test/logo.test.tsx
// checks the committed files against it.
//
// ACCENT and ICON_TILE are the two places the static files' colours are set.
// The app itself draws the logo in var(--brand), so it follows the colour
// scheme; these files cannot, so they use the default scheme's colours. To
// change them, edit ACCENT and ICON_TILE together (nothing ties the two) and
// run: node tools/brand/generate.ts
//
// Plain TypeScript that Node runs as it is (type stripping): no enums, no
// parameter properties, and imports name their .ts files.
import {
  FULL_ART,
  LOGO_VIEWBOX,
  type LogoArt,
  SMALL_ART,
} from "../../apps/web/src/shell/logoArt.ts";

/** The default colour scheme's accent, Blueprint indigo (Jon, 2026-11-19). */
export const ACCENT = "#5560e0";

/**
 * The app icons' tile (the apple-touch icon, the 192, 512 and maskable PNGs):
 * a deeper shade of the accent, with the art drawn in white on it. Of the two
 * tiles offered on 2026-11-19 (this one, or the accent art on the dark
 * background) it reads better: on the dark tile the faintest layer goes
 * muddy. Nothing derives it from ACCENT: change it by hand beside ACCENT, or
 * the apple-touch icon and the 192, 512 and maskable PNGs keep the old tile.
 */
export const ICON_TILE = "#3d47c4";

/** The art's colour on ICON_TILE. */
export const ICON_ART = "#ffffff";

/** The app's dark background: the manifest's background_color. */
export const TILE = "#121418";

/** Where the web app's public files are, from the repo root. */
export const PUBLIC_DIR = "apps/web/public";

/** The art's elements in one colour, for inside an svg element. */
export function artElements(art: LogoArt, color: string): string {
  const roof =
    `<path d="${art.roof.d}" fill="none" stroke="${color}" stroke-width="${art.roof.strokeWidth}"` +
    ` stroke-linecap="round" stroke-linejoin="round"/>`;
  const layers = art.layers.map(
    (l) =>
      `<rect x="${l.x}" y="${l.y}" width="${l.width}" height="${l.height}" rx="${l.rx}"` +
      ` fill="${color}"${l.opacity === 1 ? "" : ` opacity="${l.opacity}"`}/>`,
  );
  return [roof, ...layers].join("");
}

/**
 * A standalone SVG file of the art on a transparent background, named
 * Platehouse by its title (shown where the file is an image, as in the
 * README and the docs).
 */
export function iconSvg(art: LogoArt, color: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${LOGO_VIEWBOX} ${LOGO_VIEWBOX}">` +
    `<title>Platehouse</title>${artElements(art, color)}</svg>\n`
  );
}

/** How a PNG is laid out: its side, the art's box inside it, and its tile. */
export interface IconPng {
  file: string;
  size: number;
  /** The side of the box the 64-unit viewBox is drawn into, centred. */
  inner: number;
  /**
   * square: a full-bleed tile (iOS rounds the apple-touch icon itself, and a
   * maskable icon is cropped by the platform). rounded: a tile with its own
   * rounded corners, for the manifest's "any" icons.
   */
  tile: "square" | "rounded";
}

/**
 * The PNG files. The maskable icon's art fits the safe zone (the circle of
 * radius 40% at its centre): drawn into 320 of 512 px, its farthest points,
 * the bottom layer's lower corners, are about 147 px from the centre, well
 * inside the 204.8 px circle.
 */
export const ICON_PNGS: readonly IconPng[] = [
  { file: "apple-touch-icon.png", size: 180, inner: 136, tile: "square" },
  { file: "icon-192.png", size: 192, inner: 144, tile: "rounded" },
  { file: "icon-512.png", size: 512, inner: 384, tile: "rounded" },
  { file: "icon-maskable-512.png", size: 512, inner: 320, tile: "square" },
];

/** favicon.ico's frames: the small art at 16 px, the full art at 32 px. */
export const ICO_FRAMES: ReadonlyArray<{ size: number; art: "full" | "small" }> = [
  { size: 16, art: "small" },
  { size: 32, art: "full" },
];

/** A tile's corner radius as a share of its side, for the rounded tiles. */
const ROUNDED_RADIUS = 0.1875;

/** The SVG a tiled PNG is rasterised from: the tile, then the art in white. */
export function tiledSvg(icon: IconPng): string {
  const { size, inner } = icon;
  const radius = icon.tile === "rounded" ? ` rx="${size * ROUNDED_RADIUS}"` : "";
  const offset = (size - inner) / 2;
  const scale = inner / LOGO_VIEWBOX;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">` +
    `<rect width="${size}" height="${size}"${radius} fill="${ICON_TILE}"/>` +
    `<g transform="translate(${offset} ${offset}) scale(${scale})">${artElements(FULL_ART, ICON_ART)}</g>` +
    "</svg>"
  );
}

/** The SVG an ICO frame is rasterised from: the art alone, filling the frame. */
export function frameSvg(frame: { size: number; art: "full" | "small" }): string {
  const art = frame.art === "small" ? SMALL_ART : FULL_ART;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${LOGO_VIEWBOX} ${LOGO_VIEWBOX}"` +
    ` width="${frame.size}" height="${frame.size}">${artElements(art, ACCENT)}</svg>`
  );
}

/** site.webmanifest's text. */
export function manifestText(): string {
  const manifest = {
    name: "Platehouse",
    short_name: "Platehouse",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    theme_color: ACCENT,
    background_color: TILE,
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** The text files, by their path from the repo root. */
export const TEXT_OUTPUTS: Readonly<Record<string, string>> = {
  [`${PUBLIC_DIR}/favicon.svg`]: iconSvg(FULL_ART, ACCENT),
  [`${PUBLIC_DIR}/site.webmanifest`]: manifestText(),
  // For the docs: the README shows logo.svg, and the Docusaurus site in
  // apps/docs serves both from docs/assets, favicon.svg as its favicon.
  "docs/assets/logo.svg": iconSvg(FULL_ART, ACCENT),
  "docs/assets/favicon.svg": iconSvg(FULL_ART, ACCENT),
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A PNG's width and height, from its IHDR chunk. */
export function pngSize(png: Uint8Array): { width: number; height: number } {
  const isPng =
    png.length >= 24 &&
    PNG_SIGNATURE.every((byte, i) => png[i] === byte) &&
    String.fromCharCode(...png.subarray(12, 16)) === "IHDR";
  if (!isPng) throw new Error("not a PNG: no PNG signature and IHDR chunk");
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

const ICO_HEADER = 6;
const ICO_ENTRY = 16;

/**
 * An ICO file holding these PNG frames (PNG-in-ICO, read by every current
 * browser and by Windows since Vista). A frame is at most 256 px; 256 is
 * written as 0, as the format requires.
 */
export function encodeIco(frames: ReadonlyArray<{ size: number; png: Uint8Array }>): Uint8Array {
  const total = frames.reduce((sum, f) => sum + f.png.length, 0);
  const ico = new Uint8Array(ICO_HEADER + ICO_ENTRY * frames.length + total);
  const view = new DataView(ico.buffer);
  view.setUint16(0, 0, true);
  view.setUint16(2, 1, true);
  view.setUint16(4, frames.length, true);
  let offset = ICO_HEADER + ICO_ENTRY * frames.length;
  frames.forEach((frame, i) => {
    if (frame.size < 1 || frame.size > 256) {
      throw new Error(`an ICO frame is 1 to 256 px, not ${frame.size}`);
    }
    const entry = ICO_HEADER + ICO_ENTRY * i;
    const side = frame.size === 256 ? 0 : frame.size;
    view.setUint8(entry, side);
    view.setUint8(entry + 1, side);
    view.setUint8(entry + 2, 0);
    view.setUint8(entry + 3, 0);
    view.setUint16(entry + 4, 1, true);
    view.setUint16(entry + 6, 32, true);
    view.setUint32(entry + 8, frame.png.length, true);
    view.setUint32(entry + 12, offset, true);
    ico.set(frame.png, offset);
    offset += frame.png.length;
  });
  return ico;
}

/** The frames of an ICO file encodeIco wrote. */
export function readIco(ico: Uint8Array): Array<{ size: number; png: Uint8Array }> {
  const view = new DataView(ico.buffer, ico.byteOffset, ico.byteLength);
  if (view.getUint16(0, true) !== 0 || view.getUint16(2, true) !== 1) {
    throw new Error("not an ICO file");
  }
  const count = view.getUint16(4, true);
  const frames: Array<{ size: number; png: Uint8Array }> = [];
  for (let i = 0; i < count; i++) {
    const entry = ICO_HEADER + ICO_ENTRY * i;
    const side = view.getUint8(entry);
    const length = view.getUint32(entry + 8, true);
    const at = view.getUint32(entry + 12, true);
    frames.push({ size: side === 0 ? 256 : side, png: ico.slice(at, at + length) });
  }
  return frames;
}
