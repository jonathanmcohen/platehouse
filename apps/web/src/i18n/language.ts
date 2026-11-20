// The language choice (Jon, 2026-11-19): kept in this browser in the ph_lang
// cookie, as the theme is in ph_theme, so no schema change. With no cookie
// the browser's own languages decide. The server reads the cookie (and,
// without it, Accept-Language) and writes the resolved language into the
// html element's lang attribute before the page is sent
// (apps/server/src/web/shell.ts), so the app knows which catalog to load
// before its first render. A change here writes the cookie and the lang
// attribute together, with no reload.
//
// The cookie name is the shared LANG_COOKIE of @platehouse/i18n, which the
// server reads too.
import { canonicalLocale, LANG_COOKIE, SOURCE_LOCALE } from "@platehouse/i18n";

/** A year, in seconds: how long the browser remembers the choice. */
const COOKIE_MAX_AGE = 31_536_000;

/** The parts of a document the language reads and writes; a Document has them all. */
export interface LanguageDocument {
  documentElement: {
    getAttribute(name: string): string | null;
    setAttribute(name: string, value: string): void;
  };
  cookie: string;
  location?: { readonly protocol: string } | null;
}

/** The language the server wrote into the html element; English when there is none. */
export function readLanguage(doc: LanguageDocument): string {
  return canonicalLocale(doc.documentElement.getAttribute("lang") ?? "") ?? SOURCE_LOCALE;
}

/** The saved choice, or null when the browser's languages decide. */
export function savedLanguage(doc: Pick<LanguageDocument, "cookie">): string | null {
  for (const part of doc.cookie.split(";")) {
    const [name, value] = part.trim().split("=");
    if (name === LANG_COOKIE && value !== undefined) return canonicalLocale(value) ?? null;
  }
  return null;
}

/**
 * The Set-Cookie text for a choice: the whole site, a year, Lax, Secure on
 * https. null (follow the browser) clears the cookie.
 */
export function languageCookie(choice: string | null, secure: boolean): string {
  const code = choice === null ? undefined : canonicalLocale(choice);
  const cookie =
    code === undefined
      ? `${LANG_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`
      : `${LANG_COOKIE}=${code}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax`;
  return secure ? `${cookie}; Secure` : cookie;
}

/** Writes the choice and the shown language into the document, with no reload. */
export function applyLanguage(choice: string | null, shown: string, doc: LanguageDocument): void {
  doc.documentElement.setAttribute("lang", shown);
  doc.cookie = languageCookie(choice, doc.location?.protocol === "https:");
}
