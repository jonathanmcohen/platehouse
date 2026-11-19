// The accent colour scheme (Jon, 2026-11-19): twelve schemes, a second
// per-browser choice beside the Dark / Light / System theme. It works the way
// the theme does (theme.ts). The choice lives in this browser, in the
// ph_accent cookie; nothing is stored on the server. The server writes it
// into the html element's data-accent before the page is sent
// (apps/server/src/web/shell.ts), so the first paint already has the right
// colour, and the app only reads it back. Picking writes the cookie and the
// attribute together, with no reload; the stylesheet maps the scheme's
// colours onto the accent tokens from data-accent.
//
// The ids, the default and the cookie name are repeated in the server's
// shell.ts, and a server test checks they match these.
//
// SCHEMES holds the colours each scheme gives the accent tokens; the
// stylesheet's [data-accent] blocks must match it (test/accent-palette.test.ts
// checks they do, and checks every pairing for WCAG contrast). Where they
// come from:
// - light: accent is Jon's "button" colour, the fill behind white button
//   text, which is also what progress bars and selected borders draw with
//   (the raw accent is under 3:1 on white for seven of the twelve, Green
//   included); accentText and accentSoft are Jon's; brand, the logo, is
//   Jon's accent.
// - dark: accent is Jon's accent, the fill behind the dark palette's
//   near-black button text; accentText is Jon's dark value; accentSoft is the
//   accent laid 13% over the dark surface (#1a1d23), which is how the studio
//   palette's dark green soft was made; brand is the dark accent.
// - A colour that missed a bar was moved to the nearest colour (CIEDE2000)
//   that meets them all: 4.5:1 for text, 3:1 for fills and focus rings, at
//   least 10 from the theme's danger colour, and no closer to another
//   scheme's colour than Jon's was. Six moved: Blueprint indigo dark accent
//   (was #5560e0, 3.83:1 under button text), Graphite dark accent (was
//   #6b7380, 4.07:1), and Coral's light fill (was #c2412b), light text (was
//   #b83a25), dark accent (was #f0644a) and dark text (was #ff9580), which
//   were 4.3 to 8.2 from the danger red.
// Change the default with DEFAULT_ACCENT here and its copy in the server's
// shell.ts; the server test fails until both say the same.

export const ACCENTS = [
  "bambu-green",
  "workshop-green",
  "filament-orange",
  "spool-teal",
  "blueprint-indigo",
  "pla-violet",
  "coral",
  "amber",
  "sky-blue",
  "magenta",
  "graphite",
  "lime",
] as const;

export type AccentId = (typeof ACCENTS)[number];

/** The scheme a browser with no choice gets: Blueprint indigo (Jon, 2026-11-19). */
export const DEFAULT_ACCENT: AccentId = "blueprint-indigo";

export const ACCENT_COOKIE = "ph_accent";

/** A year, in seconds: how long the browser remembers the choice. */
const COOKIE_MAX_AGE = 31_536_000;

/** The colours a scheme gives the accent tokens in one theme. */
export interface AccentTokens {
  /** --accent: button fills, progress bars, selected borders. */
  accent: string;
  /** --accent-text and --focus: links, labels, the current item, focus rings. */
  accentText: string;
  /** --accent-soft: the current sidebar item's background. */
  accentSoft: string;
  /** --brand: the logo. */
  brand: string;
}

export interface AccentScheme {
  id: AccentId;
  light: AccentTokens;
  dark: AccentTokens;
}

function scheme(
  id: AccentId,
  light: [accent: string, accentText: string, accentSoft: string, brand: string],
  dark: [accent: string, accentText: string, accentSoft: string],
): AccentScheme {
  return {
    id,
    light: { accent: light[0], accentText: light[1], accentSoft: light[2], brand: light[3] },
    dark: { accent: dark[0], accentText: dark[1], accentSoft: dark[2], brand: dark[0] },
  };
}

export const SCHEMES: readonly AccentScheme[] = [
  scheme(
    "bambu-green",
    ["#00873a", "#007a2f", "#e7f7ed", "#00ae42"],
    ["#00ae42", "#33d17a", "#173027"],
  ),
  scheme(
    "workshop-green",
    ["#1f7a52", "#1f7a52", "#e6f5ee", "#2f9e6e"],
    ["#2f9e6e", "#5fd3a0", "#1d2e2d"],
  ),
  scheme(
    "filament-orange",
    ["#c4510e", "#b2490c", "#fdeee4", "#f26b1d"],
    ["#f26b1d", "#ff8f4f", "#362722"],
  ),
  scheme(
    "spool-teal",
    ["#0b7f7f", "#0a7272", "#e3f5f5", "#11a3a3"],
    ["#11a3a3", "#3fd0cf", "#192e34"],
  ),
  scheme(
    "blueprint-indigo",
    ["#3d47c4", "#3d47c4", "#eceefe", "#5560e0"],
    ["#596eec", "#9aa2ff", "#22263c"],
  ),
  scheme(
    "pla-violet",
    ["#6d3fe0", "#6d3fe0", "#f1ecfe", "#8b5cf6"],
    ["#8b5cf6", "#b69cff", "#29253e"],
  ),
  scheme("coral", ["#b25b46", "#973d23", "#fdebe7", "#f0644a"], ["#f15b3f", "#ffa38a", "#362628"]),
  scheme("amber", ["#8f6200", "#875c00", "#fdf3dc", "#e6a100"], ["#e6a100", "#f5c04a", "#352e1e"]),
  scheme(
    "sky-blue",
    ["#1170a8", "#0f66a0", "#e4f2fb", "#1e93d6"],
    ["#1e93d6", "#5cbcf2", "#1b2c3a"],
  ),
  scheme(
    "magenta",
    ["#b02a82", "#a8287c", "#fbe8f4", "#d6409f"],
    ["#d6409f", "#f07cc6", "#322233"],
  ),
  scheme(
    "graphite",
    ["#4b5260", "#4b5260", "#eef0f3", "#6b7380"],
    ["#747a86", "#aab1bd", "#25282f"],
  ),
  scheme("lime", ["#4a7d0c", "#457509", "#eef8e0", "#7cc51a"], ["#7cc51a", "#a6e255", "#273322"]),
];

/** The parts of a document the accent reads and writes; a Document has them all. */
export interface AccentDocument {
  documentElement: {
    getAttribute(name: string): string | null;
    setAttribute(name: string, value: string): void;
  };
  cookie: string;
  location?: { readonly protocol: string } | null;
}

/** One of ACCENTS; DEFAULT_ACCENT for anything else, a wrong case included. */
export function resolveAccent(value: unknown): AccentId {
  return (ACCENTS as readonly unknown[]).includes(value) ? (value as AccentId) : DEFAULT_ACCENT;
}

/** The accent the server wrote into the html element. */
export function readAccent(doc: AccentDocument): AccentId {
  return resolveAccent(doc.documentElement.getAttribute("data-accent"));
}

/** The Set-Cookie text for the choice: the whole site, a year, Lax, Secure on https. */
export function accentCookie(accent: AccentId, secure: boolean): string {
  const cookie = `${ACCENT_COOKIE}=${resolveAccent(accent)}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax`;
  return secure ? `${cookie}; Secure` : cookie;
}

/**
 * Switches to accent at once: data-accent, and the cookie for the next page
 * load. Never reloads. Anything that is not an accent id is written as the
 * default, so no other text reaches the cookie or the page.
 */
export function applyAccent(accent: AccentId, doc: AccentDocument): void {
  const resolved = resolveAccent(accent);
  doc.documentElement.setAttribute("data-accent", resolved);
  doc.cookie = accentCookie(resolved, doc.location?.protocol === "https:");
}
