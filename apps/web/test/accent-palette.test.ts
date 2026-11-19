// The twelve accent schemes in the stylesheet (Jon, 2026-11-19). Each scheme
// is a [data-accent="id"] block of --scheme-* colours; the theme palettes map
// them onto the app's tokens (--accent, --accent-text, --accent-soft,
// --brand, --focus, and --chip-active-bg in dark). The same mapping is
// repeated for any element inside the page that carries its own data-accent
// (the swatches in the picker), so a swatch shows its scheme in the current
// theme.
//
// Everything here is read out of studio.css itself, so a colour edited there
// is checked:
// - every scheme block matches SCHEMES in src/shell/accent.ts;
// - for every scheme, in dark, light and System's light copy, text pairs are
//   at least 4.5:1 and focus rings and meaningful graphics (the fill behind
//   button text, progress bars, selected borders) at least 3:1 (WCAG 1.4.3,
//   1.4.11);
// - no accent token is within a CIEDE2000 distance of 10 of the theme's
//   danger colour, so an error never looks like the accent (Coral and
//   Magenta are the schemes this guards);
// - the swatch rules give exactly the tokens the page itself would get.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { ACCENTS, DEFAULT_ACCENT, SCHEMES } from "../src/shell/accent";

const CSS = readFileSync(new URL("../src/styles/studio.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** The lowest distance, in CIEDE2000, allowed between an accent token and danger. */
const DANGER_DISTANCE = 10;

type Decls = Record<string, string>;

interface Rule {
  selectors: string[];
  decls: Decls;
}

/** The body of the @media block whose condition is exactly condition. */
function mediaBody(css: string, condition: string): string {
  const start = css.indexOf(`@media ${condition} {`);
  expect(start, `no @media ${condition}`).not.toBe(-1);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}") depth--;
    if (depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unclosed @media ${condition}`);
}

/** The CSS with every @media block taken out. */
function topLevel(css: string): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    const at = css.indexOf("@media", i);
    if (at === -1) return out + css.slice(i);
    out += css.slice(i, at);
    let depth = 0;
    let j = css.indexOf("{", at);
    for (; j < css.length; j++) {
      if (css[j] === "{") depth++;
      if (css[j] === "}") depth--;
      if (depth === 0) break;
    }
    i = j + 1;
  }
  return out;
}

function rules(css: string): Rule[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => {
    const decls: Decls = {};
    for (const d of (m[2] as string).matchAll(/(--[a-z-]+)\s*:\s*([^;]+);/g)) {
      decls[d[1] as string] = (d[2] as string).trim();
    }
    return {
      selectors: (m[1] as string).split(",").map((s) => s.replace(/\s+/g, " ").trim()),
      decls,
    };
  });
}

/** The one rule in css whose selector list is exactly selectors. */
function rule(css: string, selectors: string[]): Decls {
  const found = rules(css).filter(
    (r) =>
      r.selectors.length === selectors.length && selectors.every((s) => r.selectors.includes(s)),
  );
  expect(found, `rules for ${selectors.join(", ")}`).toHaveLength(1);
  return (found[0] as Rule).decls;
}

/** A hover that only an enabled button gets. */
const ENABLED_HOVER = ':hover:not(:disabled):not([aria-disabled="true"])';

const TOP = topLevel(CSS);
const LIGHT_MEDIA = mediaBody(CSS, "(prefers-color-scheme: light)");

const PALETTES = {
  dark: rule(TOP, [":root", '[data-theme="dark"]']),
  light: rule(TOP, ['[data-theme="light"]']),
  "system light": rule(LIGHT_MEDIA, ['[data-theme="system"]']),
};

const SWATCH_RULES = {
  dark: rule(TOP, ['[data-theme="dark"] [data-accent]', '[data-theme="system"] [data-accent]']),
  light: rule(TOP, ['[data-theme="light"] [data-accent]']),
  "system light": rule(LIGHT_MEDIA, ['[data-theme="system"] [data-accent]']),
};

type ThemeName = keyof typeof PALETTES;
const THEME_NAMES = Object.keys(PALETTES) as ThemeName[];

/** The --scheme-* colours of one scheme's block. */
function schemeVars(id: string): Decls {
  const found = rules(TOP).filter((r) => r.selectors.includes(`[data-accent="${id}"]`));
  expect(found, `blocks for ${id}`).toHaveLength(1);
  return (found[0] as Rule).decls;
}

/** A palette's tokens with each var(--scheme-*) replaced by the scheme's colour. */
function resolve(decls: Decls, vars: Decls): Decls {
  const out: Decls = {};
  for (const [name, value] of Object.entries(decls)) {
    const ref = /^var\((--[a-z-]+)\)$/.exec(value);
    if (ref === null) {
      out[name] = value;
      continue;
    }
    const resolved = vars[ref[1] as string];
    expect(resolved, `${name}: ${value} is not defined by the scheme`).toBeDefined();
    out[name] = resolved as string;
  }
  return out;
}

function tokens(theme: ThemeName, id: string): Decls {
  return resolve(PALETTES[theme], schemeVars(id));
}

function luminance(hex: string): number {
  const [r, g, b] = (hex.slice(1).match(/../g) ?? []).map((pair) => {
    const c = Number.parseInt(pair, 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function lab(hex: string): [number, number, number] {
  const [r, g, b] = (hex.slice(1).match(/../g) ?? []).map((pair) => {
    const c = Number.parseInt(pair, 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 / 116) * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** CIEDE2000 colour difference between two #rrggbb colours. */
function deltaE2000(a: string, b: string): number {
  return deltaE2000Lab(lab(a), lab(b));
}

/** CIEDE2000 colour difference between two CIELAB colours (Sharma, Wu and Dalal). */
function deltaE2000Lab(
  [l1, a1, b1]: [number, number, number],
  [l2, a2, b2]: [number, number, number],
): number {
  const rad = Math.PI / 180;
  const cBar = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)));
  const a1p = (1 + g) * a1;
  const a2p = (1 + g) * a2;
  const c1p = Math.hypot(a1p, b1);
  const c2p = Math.hypot(a2p, b2);
  const h1p = (Math.atan2(b1, a1p) / rad + 360) % 360;
  const h2p = (Math.atan2(b2, a2p) / rad + 360) % 360;
  const dL = l2 - l1;
  const dC = c2p - c1p;
  let dh = h2p - h1p;
  if (c1p * c2p === 0) dh = 0;
  else if (dh > 180) dh -= 360;
  else if (dh < -180) dh += 360;
  const dH = 2 * Math.sqrt(c1p * c2p) * Math.sin((dh / 2) * rad);
  const lBar = (l1 + l2) / 2;
  const cBarP = (c1p + c2p) / 2;
  let hBar = h1p + h2p;
  if (c1p * c2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hBar = (h1p + h2p) / 2;
    else hBar = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
  }
  const t =
    1 -
    0.17 * Math.cos((hBar - 30) * rad) +
    0.24 * Math.cos(2 * hBar * rad) +
    0.32 * Math.cos((3 * hBar + 6) * rad) -
    0.2 * Math.cos((4 * hBar - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hBar - 275) / 25) ** 2));
  const rc = 2 * Math.sqrt(cBarP ** 7 / (cBarP ** 7 + 25 ** 7));
  const sl = 1 + (0.015 * (lBar - 50) ** 2) / Math.sqrt(20 + (lBar - 50) ** 2);
  const sc = 1 + 0.045 * cBarP;
  const sh = 1 + 0.015 * cBarP * t;
  const rt = -Math.sin(2 * dTheta * rad) * rc;
  return Math.sqrt((dL / sl) ** 2 + (dC / sc) ** 2 + (dH / sh) ** 2 + rt * (dC / sc) * (dH / sh));
}

// [foreground, background, minimum ratio] for every accent pairing the
// stylesheet draws.
const PAIRS: Array<[string, string, number]> = [
  // Text: links, labels, the current sidebar item, the current tab.
  ["--accent-text", "--bg", 4.5],
  ["--accent-text", "--surface", 4.5],
  ["--accent-text", "--raised", 4.5],
  ["--accent-text", "--accent-soft", 4.5],
  // Button text on the accent fill (the primary button, the skip link).
  ["--on-accent", "--accent", 4.5],
  // The pressed theme button and the current chip (the accent in dark).
  ["--chip-active-text", "--chip-active-bg", 4.5],
  // The fill itself, progress bars and selected borders: meaningful graphics.
  ["--accent", "--bg", 3],
  ["--accent", "--surface", 3],
  ["--accent", "--raised", 3],
  // Focus rings.
  ["--focus", "--bg", 3],
  ["--focus", "--surface", 3],
  ["--focus", "--raised", 3],
  ["--focus", "--accent-soft", 3],
];

/** The tokens an accent scheme sets; none may look like danger. */
const ACCENT_TOKENS = ["--accent", "--accent-text", "--focus", "--brand", "--chip-active-bg"];

const CASES = THEME_NAMES.flatMap((theme) => ACCENTS.map((id) => [theme, id] as const));

describe("the scheme blocks", () => {
  test.each(SCHEMES.map((s) => [s.id, s] as const))(
    "%s in the stylesheet matches SCHEMES in accent.ts",
    (id, scheme) => {
      expect(schemeVars(id)).toEqual({
        "--scheme-light-accent": scheme.light.accent,
        "--scheme-light-text": scheme.light.accentText,
        "--scheme-light-soft": scheme.light.accentSoft,
        "--scheme-light-brand": scheme.light.brand,
        "--scheme-dark-accent": scheme.dark.accent,
        "--scheme-dark-text": scheme.dark.accentText,
        "--scheme-dark-soft": scheme.dark.accentSoft,
      });
      // The stylesheet draws the dark logo with the dark accent.
      expect(scheme.dark.brand).toBe(scheme.dark.accent);
    },
  );

  test("there is a block for each of the twelve and no other", () => {
    const ids = [...TOP.matchAll(/\[data-accent="([^"]*)"\]/g)].map((m) => m[1]);
    expect(ids).toEqual([...ACCENTS]);
  });

  test("a page with no data-accent still has a complete scheme from :root, the default's", () => {
    const fallback = rules(TOP).filter(
      (r) => r.selectors.includes(":where(:root)") && "--scheme-dark-accent" in r.decls,
    );
    expect(fallback).toHaveLength(1);
    expect(Object.keys((fallback[0] as Rule).decls)).toHaveLength(7);
    expect((fallback[0] as Rule).selectors).toContain(`[data-accent="${DEFAULT_ACCENT}"]`);
  });

  // A plain :root has the same specificity as [data-accent="id"], so on a
  // block after the first it would beat every scheme listed before it (Green,
  // for one). :where(:root) has none, so any data-accent wins wherever it is.
  test("the fallback is :where(:root), never a plain :root that would beat a scheme", () => {
    const plain = rules(TOP).filter(
      (r) => r.selectors.includes(":root") && "--scheme-dark-accent" in r.decls,
    );
    expect(plain).toHaveLength(0);
  });

  test("the default scheme's dark tokens are Blueprint indigo's", () => {
    expect(tokens("dark", DEFAULT_ACCENT)).toMatchObject({
      "--accent": "#596eec",
      "--accent-text": "#9aa2ff",
      "--accent-soft": "#22263c",
      "--chip-active-bg": "#596eec",
      "--focus": "#9aa2ff",
    });
  });
});

describe("the palettes map the scheme onto the tokens", () => {
  test.each(THEME_NAMES)("%s takes every accent token from the scheme", (theme) => {
    const palette = PALETTES[theme];
    const prefix = theme === "dark" ? "--scheme-dark" : "--scheme-light";
    expect(palette["--accent"]).toBe(`var(${prefix}-accent)`);
    expect(palette["--accent-text"]).toBe(`var(${prefix}-text)`);
    expect(palette["--accent-soft"]).toBe(`var(${prefix}-soft)`);
    expect(palette["--focus"]).toBe(`var(${prefix}-text)`);
    expect(palette["--brand"]).toBe(
      theme === "dark" ? "var(--scheme-dark-accent)" : "var(--scheme-light-brand)",
    );
  });

  test("System's light swatch rule comes after the dark one, so it wins when the OS asks for light", () => {
    // Both selectors are [data-theme="system"] [data-accent], so the later
    // one wins; the light one is inside the prefers-color-scheme block.
    const darkRule = CSS.indexOf('[data-theme="system"] [data-accent] {');
    const media = CSS.indexOf("@media (prefers-color-scheme: light) {");
    expect(darkRule).toBeGreaterThan(-1);
    expect(media).toBeGreaterThan(darkRule);
  });

  test("System's light copy is the light palette, exactly", () => {
    expect(PALETTES["system light"]).toEqual(PALETTES.light);
  });

  test.each(THEME_NAMES)("a swatch in %s gets the same accent tokens the page does", (theme) => {
    const swatch = SWATCH_RULES[theme];
    const palette = PALETTES[theme];
    expect(Object.keys(swatch).length).toBeGreaterThan(0);
    for (const [name, value] of Object.entries(swatch)) expect(palette[name], name).toBe(value);
    for (const name of ["--accent", "--accent-text", "--accent-soft", "--focus", "--brand"]) {
      expect(swatch[name], name).toBe(palette[name]);
    }
  });

  test("in light the primary button darkens on hover, so its white text keeps its contrast", () => {
    const darkens = (selector: string) =>
      new RegExp(
        `${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{[^}]*filter:\\s*brightness\\(0\\.\\d+\\)`,
      );
    expect(TOP).toMatch(darkens(`[data-theme="light"] .studio-button-primary${ENABLED_HOVER}`));
    expect(LIGHT_MEDIA).toMatch(
      darkens(`[data-theme="system"] .studio-button-primary${ENABLED_HOVER}`),
    );
  });

  test("a disabled primary button keeps its fill on hover in light, as in dark", () => {
    // [data-theme] .studio-button-primary:hover is (0,3,0), more specific than
    // .studio-button:disabled and organise.css's
    // .studio-button[aria-disabled="true"] (both (0,2,0)), so their
    // filter: none would lose to it. Every themed hover filter on the primary
    // button is limited to enabled buttons instead.
    const themed = [TOP, LIGHT_MEDIA].flatMap((css) =>
      [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .filter((m) => /(^|;)\s*filter\s*:/.test(m[2] as string))
        .flatMap((m) => (m[1] as string).split(",").map((s) => s.replace(/\s+/g, " ").trim()))
        .filter((s) => s.includes("[data-theme=") && s.includes(".studio-button-primary:hover")),
    );
    expect(themed.length, "themed primary hover rules").toBeGreaterThanOrEqual(2);
    for (const selector of themed) expect(selector).toContain(ENABLED_HOVER);
  });

  test("the logo is drawn with --brand", () => {
    expect(TOP).toMatch(/\.studio-brand-dot\s*\{[^}]*background:\s*var\(--brand\)/);
  });

  test("danger is unchanged in both themes", () => {
    expect(PALETTES.dark["--danger"]).toBe("#ff7b72");
    expect(PALETTES.light["--danger"]).toBe("#c62828");
  });
});

describe("contrast", () => {
  test.each(CASES)("%s, %s: every accent pairing meets WCAG", (theme, id) => {
    const t = tokens(theme, id);
    for (const [fg, bg, min] of PAIRS) {
      const a = t[fg];
      const b = t[bg];
      expect(a, `${fg} is not defined`).toMatch(/^#[0-9a-f]{6}$/);
      expect(b, `${bg} is not defined`).toMatch(/^#[0-9a-f]{6}$/);
      const ratio = contrast(a as string, b as string);
      expect(
        ratio,
        `${id} ${theme}: ${fg} ${a} on ${bg} ${b} is ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(min);
    }
  });

  test("the contrast check fails a pairing below the bar", () => {
    // The check itself, on a pair known to fail: Green's #00ae42 on white is
    // 2.94:1, which is why the light theme fills with Jon's button colour.
    expect(contrast("#00ae42", "#ffffff")).toBeLessThan(3);
    expect(contrast("#ffffff", "#00873a")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
  });
});

describe("the accent never looks like danger", () => {
  test.each(CASES)("%s, %s", (theme, id) => {
    const t = tokens(theme, id);
    const danger = t["--danger"] as string;
    for (const name of ACCENT_TOKENS) {
      const value = t[name] as string;
      if (theme !== "dark" && name === "--chip-active-bg") continue; // #111111 in light
      const distance = deltaE2000(value, danger);
      expect(
        distance,
        `${id} ${theme}: ${name} ${value} vs danger ${danger} is ${distance.toFixed(1)}`,
      ).toBeGreaterThanOrEqual(DANGER_DISTANCE);
    }
  });

  test("the distance check sees a near match", () => {
    // Jon's original Coral label colour, #b83a25, beside light danger.
    expect(deltaE2000("#b83a25", "#c62828")).toBeLessThan(DANGER_DISTANCE);
    // Sharma, Wu and Dalal's test pair 1.
    expect(deltaE2000Lab([50, 2.6772, -79.7751], [50, 0, -82.7485])).toBeCloseTo(2.0425, 3);
  });
});
