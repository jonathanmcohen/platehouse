// Build plan Task 18, AC-070, AC-074 and AC-075: the studio stylesheet,
// ported from manyfold-studio's test/stylesheet_test.rb at 4076a67. The
// palettes are read out of studio.css itself, so a colour edited there is
// checked here: every text and background pair meets WCAG AA (4.5:1) in both
// palettes, the alert edges meet 3:1, System's light copy equals Light, the
// default accent is Blueprint indigo, and the palettes, radii and breakpoints
// are the ones manyfold-studio shipped at 4076a67. The palettes take their
// accent tokens from the accent scheme (Jon, 2026-11-19); here they are read
// with the default scheme filled in, or with Green, the studio's own colour,
// where they are compared with 4076a67. accent-palette.test.ts checks all
// twelve.
//
// Not ported: the picture stacking tests, which pin the restyling of
// Manyfold's PreviewFrame markup (.card-img-top and its blurred backdrop).
// Platehouse draws its own card and viewer pictures (Tasks 19 and 20), so
// that markup and its rules do not exist here.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const CSS = readFileSync(new URL("../src/styles/studio.css", import.meta.url), "utf8");

const DARK = ':root,\n[data-theme="dark"]';
const LIGHT = '[data-theme="light"]';
/** The default accent scheme's block, which :root also carries (accent-palette.test.ts checks all twelve). */
const ROOT_SCHEME = ':where(:root),\n[data-accent="blueprint-indigo"]';
/** Green's block: the accent manyfold-studio shipped at 4076a67. */
const GREEN_SCHEME = '[data-accent="bambu-green"]';

type Palette = Record<string, string>;

function blockFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "m").exec(CSS)?.[1];
  expect(block, `no block for ${selector}`).toBeDefined();
  return block ?? "";
}

/** The plain #rrggbb custom properties in a block. */
function hexColours(block: string): Palette {
  const colours: Palette = {};
  for (const m of block.matchAll(/(--[a-z-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    colours[m[1] as string] = m[2] as string;
  }
  return colours;
}

/**
 * The colours of the block for selector, with a scheme's colours for its
 * var(--scheme-*) tokens. The default scheme gives what the page paints with
 * no accent chosen.
 */
function palette(selector: string, schemeSelector: string = ROOT_SCHEME): Palette {
  return declaredColours(blockFor(selector), schemeSelector);
}

function declaredColours(block: string, schemeSelector: string = ROOT_SCHEME): Palette {
  const scheme = hexColours(blockFor(schemeSelector));
  const colours = hexColours(block);
  for (const m of block.matchAll(/(--[a-z-]+)\s*:\s*var\((--scheme-[a-z-]+)\)\s*;/g)) {
    const value = scheme[m[2] as string];
    expect(value, `${m[1]}: ${m[2]} is not in the scheme`).toBeDefined();
    colours[m[1] as string] = value as string;
  }
  return colours;
}

/** The light copy System uses when the OS asks for light. */
function systemLightBlock(): string | undefined {
  return /@media \(prefers-color-scheme: light\)\s*\{\s*\[data-theme="system"\]\s*\{([^}]*)\}/m.exec(
    CSS,
  )?.[1];
}

function luminance(hex: string): number {
  const [r, g, b] = (hex.slice(1).match(/../g) ?? []).map((pair) => {
    const c = Number.parseInt(pair, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The declarations of every flat rule (media queries aside) whose selector
 * list includes selector, comments removed.
 */
function declarationsFor(selector: string): string {
  const flat = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  let found = "";
  for (const m of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (m[1] as string).split(",").map((s) => s.replace(/\s+/g, " ").trim());
    if (selectors.includes(selector)) found += m[2];
  }
  return found;
}

/** The body of the @media block whose condition is exactly condition. */
function mediaBlock(condition: string): string | undefined {
  const start = CSS.indexOf(`@media ${condition} {`);
  if (start === -1) return undefined;
  let depth = 0;
  for (let i = CSS.indexOf("{", start); i < CSS.length; i++) {
    if (CSS[i] === "{") depth++;
    if (CSS[i] === "}") depth--;
    if (depth === 0) return CSS.slice(CSS.indexOf("{", start) + 1, i);
  }
  return undefined;
}

// [text, background] for every pairing the stylesheet uses for text.
const PAIRS: Array<[string, string]> = [
  ["--text", "--bg"],
  ["--text", "--surface"],
  ["--text", "--raised"],
  ["--muted", "--bg"],
  ["--muted", "--surface"],
  ["--muted", "--raised"],
  ["--accent-text", "--bg"],
  ["--accent-text", "--surface"],
  ["--accent-text", "--accent-soft"],
  ["--on-accent", "--accent"],
  ["--chip-active-text", "--chip-active-bg"],
  ["--chip-text", "--surface"],
];

// The palettes of manyfold-studio's studio.css at 4076a67, with its accent,
// the Green scheme, filled in. --brand, the logo's colour, was
// added with the accent schemes (Jon, 2026-11-19).
const STUDIO_DARK: Palette = {
  "--bg": "#121418",
  "--surface": "#1a1d23",
  "--raised": "#262a32",
  "--border": "#262a32",
  "--text": "#e6e7ea",
  "--muted": "#8f949d",
  "--accent": "#00ae42",
  "--accent-text": "#33d17a",
  "--accent-soft": "#173027",
  "--on-accent": "#0b0d10",
  "--chip-text": "#c7cad1",
  "--chip-active-bg": "#00ae42",
  "--chip-active-text": "#0b0d10",
  "--focus": "#33d17a",
  "--danger": "#ff7b72",
  "--brand": "#00ae42",
};

// Light differs from 4076a67 in the accent fill only, on purpose: #00ae42 is
// 2.94:1 on white, under the 3:1 a button fill and a progress bar need, so
// the light theme fills with Jon's button green, #00873a, behind white text
// (4.64:1). The logo keeps #00ae42.
const STUDIO_LIGHT: Palette = {
  "--bg": "#f6f7f9",
  "--surface": "#ffffff",
  "--raised": "#eceef2",
  "--border": "#eceef2",
  "--text": "#111111",
  "--muted": "#5f6570",
  "--accent": "#00873a",
  "--accent-text": "#007a2f",
  "--accent-soft": "#e7f7ed",
  "--on-accent": "#ffffff",
  "--chip-text": "#3a3f47",
  "--chip-active-bg": "#111111",
  "--chip-active-text": "#ffffff",
  "--focus": "#007a2f",
  "--danger": "#c62828",
  "--brand": "#00ae42",
};

// Every border-radius in studio.css at 4076a67, by selector, less the brand
// dot's 50%: the logo (Logo.tsx) replaced the dot, and its rule is gone.
const STUDIO_RADII: Array<[string, string]> = [
  [":focus-visible", "6px"],
  [".studio-skip", "8px"],
  [".studio-sidebar", "12px"],
  [".studio-nav-list a", "8px"],
  ['.studio-search input[type="search"]', "10px"],
  [".studio-button", "9px"],
  [".studio-theme-switch", "10px"],
  [".studio-theme-switch button", "7px"],
  [".studio-menu-panel", "12px"],
  [".studio-alert", "10px"],
  [".studio-chip", "999px"],
  [".studio-card", "12px"],
  [".studio-empty", "12px"],
  [".studio-viewer-frame", "12px"],
  [".studio-plate-strip a", "8px"],
  [".studio-list-item", "10px"],
  [".studio-swatch", "3px"],
];

describe("palettes", () => {
  test.each([
    ["dark", DARK],
    ["light", LIGHT],
  ])("every text and background pair is at least 4.5:1 in %s", (name, selector) => {
    const colours = palette(selector);
    for (const [text, background] of PAIRS) {
      const fg = colours[text];
      const bg = colours[background];
      expect(fg, `${name}: ${text} is not defined`).toBeDefined();
      expect(bg, `${name}: ${background} is not defined`).toBeDefined();
      const ratio = contrast(fg as string, bg as string);
      expect(
        ratio,
        `${name}: ${text} ${fg} on ${background} ${bg} is ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  test.each([
    ["dark", DARK],
    ["light", LIGHT],
  ])("the alert edges are at least 3:1 against surface and bg in %s", (name, selector) => {
    const colours = palette(selector);
    for (const edge of ["--accent-text", "--danger"]) {
      for (const background of ["--surface", "--bg"]) {
        const fg = colours[edge];
        const bg = colours[background];
        expect(fg, `${name}: ${edge} is not defined`).toBeDefined();
        const ratio = contrast(fg as string, bg as string);
        expect(
          ratio,
          `${name}: ${edge} on ${background} is ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });

  test("dark with Green is the studio dark palette at 4076a67, plus the logo colour", () => {
    expect(palette(DARK, GREEN_SCHEME)).toEqual(STUDIO_DARK);
  });

  test("light with Green is the studio light palette, with Jon's button green as the fill", () => {
    expect(palette(LIGHT, GREEN_SCHEME)).toEqual(STUDIO_LIGHT);
  });

  test("the plan's colours are the ones in use, with Green", () => {
    const dark = palette(DARK, GREEN_SCHEME);
    const light = palette(LIGHT, GREEN_SCHEME);
    expect(dark).toMatchObject({
      "--bg": "#121418",
      "--surface": "#1a1d23",
      "--raised": "#262a32",
      "--text": "#e6e7ea",
      "--muted": "#8f949d",
      "--accent": "#00ae42",
      "--accent-text": "#33d17a",
      "--focus": "#33d17a",
    });
    expect(light).toMatchObject({
      "--bg": "#f6f7f9",
      "--surface": "#ffffff",
      "--text": "#111111",
      "--muted": "#5f6570",
      "--accent-text": "#007a2f",
    });
  });

  // Jon, 2026-11-19: the default is Blueprint indigo. Its dark fill and logo
  // are #596eec, not #5560e0, which is 3.83:1 under the dark button text
  // (src/shell/accent.ts); #5560e0 is the light logo.
  test("the default accent is Blueprint indigo: #596eec in dark and in the dark logo, #3d47c4 as the light fill, #5560e0 as the light logo", () => {
    expect(palette(DARK)["--accent"]).toBe("#596eec");
    expect(palette(DARK)["--brand"]).toBe("#596eec");
    expect(palette(LIGHT)["--accent"]).toBe("#3d47c4");
    expect(palette(LIGHT)["--brand"]).toBe("#5560e0");
  });

  test("dark is the default: it is the :root block", () => {
    expect(CSS).toContain(`${DARK} {`);
    expect(declarationsFor(":root")).toMatch(/color-scheme:\s*dark;/);
  });

  test("System uses an exact copy of the light palette when the OS asks for light", () => {
    const system = systemLightBlock();
    expect(system, "no prefers-color-scheme: light block for system").toBeDefined();
    expect(declaredColours(system ?? "")).toEqual(palette(LIGHT));
    expect(system).toMatch(/color-scheme:\s*light;/);
    expect(declarationsFor(LIGHT)).toMatch(/color-scheme:\s*light;/);
  });

  test("focus outlines use the palette's focus colour", () => {
    expect(declarationsFor(":focus-visible")).toMatch(/outline:\s*2px solid var\(--focus\)/);
  });
});

describe("layout", () => {
  test("the 899.98 px query exists and puts the sidebar behind the menu button", () => {
    const narrow = mediaBlock("(max-width: 899.98px)");
    expect(narrow, "no @media (max-width: 899.98px)").toBeDefined();
    expect(narrow).toMatch(/\.studio-sidebar\s*\{[^}]*display:\s*none/);
    expect(narrow).toMatch(/\.studio-menu\s*\{[^}]*display:\s*block/);
    expect(declarationsFor(".studio-menu")).toMatch(/display:\s*none/);
  });

  test("the 480 px query exists", () => {
    expect(mediaBlock("(max-width: 480px)"), "no @media (max-width: 480px)").toBeDefined();
  });

  test.each(STUDIO_RADII)("%s has the studio radius %s", (selector, radius) => {
    const declarations = declarationsFor(selector);
    expect(declarations, `no rule for ${selector}`).not.toBe("");
    expect(/border-radius:\s*([^;]+);/.exec(declarations)?.[1]).toBe(radius);
  });

  test("Inter falls back to system-ui", () => {
    expect(declarationsFor("html")).toMatch(/font-family:\s*Inter,\s*system-ui,/);
  });

  test("reduced motion is honoured", () => {
    const reduced = mediaBlock("(prefers-reduced-motion: reduce)");
    expect(reduced, "no @media (prefers-reduced-motion: reduce)").toBeDefined();
    expect(reduced).toMatch(/transition:\s*none !important/);
    expect(reduced).toMatch(/animation:\s*none !important/);
    expect(reduced).toMatch(/scroll-behavior:\s*auto !important/);
  });
});

describe("links", () => {
  // WCAG 1.4.1: a link inside running text must not differ from the text
  // around it by colour alone.
  test.each([
    ".studio-prose a",
    ".studio-caption a",
    ".studio-byline a",
    ".studio-dl dd a:not(.studio-chip)",
    ".studio-muted a",
    ".studio-alert a",
  ])("%s is underlined", (selector) => {
    expect(declarationsFor(selector)).toMatch(/text-decoration(-line)?:\s*underline/);
  });

  test("links elsewhere stay plain", () => {
    expect(declarationsFor("a")).toMatch(/text-decoration:\s*none/);
  });

  test("a notice and an alert have distinct edges", () => {
    expect(declarationsFor(".studio-alert-notice")).toMatch(
      /border-left:[^;]*var\(--accent-text\)/,
    );
    expect(declarationsFor(".studio-alert-alert")).toMatch(/border-left:[^;]*var\(--danger\)/);
  });
});

test("the CSS is ASCII only", () => {
  expect(CSS.length).toBeGreaterThan(0);
  const offending = [...CSS].findIndex((c) => (c.codePointAt(0) ?? 0) > 0x7f);
  expect(offending, `a non-ASCII character at offset ${offending}`).toBe(-1);
});
