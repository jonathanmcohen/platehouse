// Writes Platehouse's static logo files from the logo art
// (apps/web/src/shell/logoArt.ts) and the one ACCENT in icons.ts:
//
//   apps/web/public/favicon.svg, favicon.ico (16 and 32 px),
//   apple-touch-icon.png (180), icon-192.png, icon-512.png,
//   icon-maskable-512.png and site.webmanifest;
//   docs/assets/logo.svg and docs/assets/favicon.svg.
//
// Run from anywhere in the repo, after pnpm install:
//
//   node tools/brand/generate.ts
//
// The PNGs are drawn by Playwright's Chromium, which the repo already has
// for its end-to-end suite (@playwright/test in the root package.json); if
// its browser is not on this machine yet, install it first with
//   pnpm exec playwright install chromium
// favicon.ico is put together here from two of those PNGs, with no other
// tool. Commit what it writes; apps/web/test/logo.test.tsx checks the files
// match ACCENT and the art.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "@playwright/test";
import {
  encodeIco,
  frameSvg,
  ICO_FRAMES,
  ICON_PNGS,
  PUBLIC_DIR,
  TEXT_OUTPUTS,
  tiledSvg,
} from "./icons.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

async function write(path: string, data: string | Uint8Array): Promise<void> {
  const full = join(ROOT, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, data);
  console.log(`wrote ${path}`);
}

/** One SVG drawn at size x size px on a transparent background, as PNG bytes. */
async function rasterise(page: Page, svg: string, size: number): Promise<Uint8Array> {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    "<!doctype html><html><head><style>html,body{margin:0;background:transparent}" +
      `svg{display:block}</style></head><body>${svg}</body></html>`,
  );
  const png = await page.screenshot({
    omitBackground: true,
    clip: { x: 0, y: 0, width: size, height: size },
  });
  return new Uint8Array(png);
}

async function main(): Promise<void> {
  for (const [path, text] of Object.entries(TEXT_OUTPUTS)) await write(path, text);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    for (const icon of ICON_PNGS) {
      await write(`${PUBLIC_DIR}/${icon.file}`, await rasterise(page, tiledSvg(icon), icon.size));
    }
    const frames = [];
    for (const frame of ICO_FRAMES) {
      frames.push({ size: frame.size, png: await rasterise(page, frameSvg(frame), frame.size) });
    }
    await write(`${PUBLIC_DIR}/favicon.ico`, encodeIco(frames));
  } finally {
    await browser.close();
  }
}

await main();
