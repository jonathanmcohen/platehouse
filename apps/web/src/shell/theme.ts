// The Dark / Light / System theme (build plan Task 18, AC-070). The choice
// lives in this browser, in the ph_theme cookie; nothing is stored on the
// server. The server writes it into the html element's data-theme and the
// color-scheme meta before the page is sent (apps/server/src/web/shell.ts),
// so the first paint is already right and the app only reads it back. The
// switch writes the cookie, the attribute and the meta together, with no
// reload: the stylesheet picks the palette from data-theme, and System
// resolves in CSS with prefers-color-scheme.
//
// The cookie name and the color-scheme values are repeated in the server's
// shell.ts, and a server test checks the name here matches.

export const THEMES = ["dark", "light", "system"] as const;

export type Theme = (typeof THEMES)[number];

export const DEFAULT_THEME: Theme = "dark";

export const THEME_COOKIE = "ph_theme";

/** A year, in seconds: how long the browser remembers the choice. */
const COOKIE_MAX_AGE = 31_536_000;

/** The parts of a document the theme reads and writes; a Document has them all. */
export interface ThemeDocument {
  documentElement: {
    getAttribute(name: string): string | null;
    setAttribute(name: string, value: string): void;
  };
  querySelector(selector: string): { setAttribute(name: string, value: string): void } | null;
  cookie: string;
  location?: { readonly protocol: string } | null;
}

/** One of THEMES; DEFAULT_THEME for anything else, a wrong case included. */
export function resolveTheme(value: unknown): Theme {
  return (THEMES as readonly unknown[]).includes(value) ? (value as Theme) : DEFAULT_THEME;
}

/** The color-scheme meta's content: the browser's own colours before the CSS loads. */
export function colorSchemeFor(theme: Theme): "dark" | "light" | "light dark" {
  if (theme === "dark") return "dark";
  if (theme === "light") return "light";
  return "light dark";
}

/** The theme the server wrote into the html element. */
export function readTheme(doc: ThemeDocument): Theme {
  return resolveTheme(doc.documentElement.getAttribute("data-theme"));
}

/** The Set-Cookie text for the choice: the whole site, a year, Lax, Secure on https. */
export function themeCookie(theme: Theme, secure: boolean): string {
  const cookie = `${THEME_COOKIE}=${resolveTheme(theme)}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax`;
  return secure ? `${cookie}; Secure` : cookie;
}

/**
 * Switches to theme at once: data-theme, the color-scheme meta and the
 * cookie for the next page load. Never reloads. Anything that is not a
 * theme is written as the default, so no other text reaches the cookie.
 */
export function applyTheme(theme: Theme, doc: ThemeDocument): void {
  const resolved = resolveTheme(theme);
  doc.documentElement.setAttribute("data-theme", resolved);
  doc.querySelector('meta[name="color-scheme"]')?.setAttribute("content", colorSchemeFor(resolved));
  doc.cookie = themeCookie(resolved, doc.location?.protocol === "https:");
}
