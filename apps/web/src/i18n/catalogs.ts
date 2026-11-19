// Where the web app gets each language's messages (Jon, 2026-11-19).
// English is bundled into every page: it is the source of truth and the
// fallback for any missing key. Every other built-in language is its own
// chunk, loaded only when it is chosen; a contributor adds one by adding its
// JSON file to packages/i18n/locales, and the glob below picks it up with no
// list to edit. A language a self-hoster dropped into LOCALES_DIR comes from
// the server, already checked (GET /app/api/locales/:code).
import { canonicalLocale, type Messages, messagesOf, SOURCE_LOCALE } from "@platehouse/i18n";
import en from "@platehouse/i18n/locales/en.json";

/** English's messages, without $meta. */
export const ENGLISH: Messages = messagesOf(en);

/** A message key: every key of the English catalog. */
export type MessageKey = Exclude<keyof typeof en, "$meta">;

const BUILTIN = import.meta.glob<Record<string, unknown>>(
  "../../../../packages/i18n/locales/*.json",
  { import: "default" },
);

const builtinLoaders = new Map<string, () => Promise<Record<string, unknown>>>();
for (const [path, load] of Object.entries(BUILTIN)) {
  const code = canonicalLocale(path.slice(path.lastIndexOf("/") + 1, -".json".length));
  if (code !== undefined) builtinLoaders.set(code, load);
}

/** The built-in languages' codes, English included. */
export function builtinLocales(): string[] {
  return [...builtinLoaders.keys()].sort();
}

/** What GET /app/api/locales/:code answers. */
interface LocaleAnswer {
  code: string;
  messages: Record<string, string>;
}

const JSON_GET: RequestInit = {
  credentials: "same-origin",
  headers: { accept: "application/json" },
};

/** A language's checked messages from the server (GET /app/api/locales/:code). */
async function fetchMessages(code: string, fetcher: typeof fetch): Promise<Messages> {
  const res = await fetcher(`/app/api/locales/${encodeURIComponent(code)}`, JSON_GET);
  if (!res.ok) throw new Error(`the language ${code} answered ${res.status}`);
  return messagesOf(((await res.json()) as LocaleAnswer).messages);
}

/** Whether the server's language list marks a built-in language as changed by a LOCALES_DIR file. */
async function hasOverlay(code: string, fetcher: typeof fetch): Promise<boolean> {
  try {
    const res = await fetcher("/app/api/locales", JSON_GET);
    if (!res.ok) return false;
    const { locales } = (await res.json()) as {
      locales: Array<{ code: string; overlay?: boolean }>;
    };
    return locales.some((l) => l.code === code && l.overlay === true);
  } catch {
    return false;
  }
}

/**
 * A language's messages: English at once; a built-in one from its chunk,
 * with a self-hoster's LOCALES_DIR changes merged over it when the server
 * lists them (the chunk alone if that cannot be read); anything else from
 * the server. Rejects when a language cannot be had at all; the caller then
 * stays in English.
 */
export async function loadMessages(code: string, fetcher: typeof fetch = fetch): Promise<Messages> {
  if (code === SOURCE_LOCALE) return ENGLISH;
  const builtin = builtinLoaders.get(code);
  if (builtin === undefined) return fetchMessages(code, fetcher);
  const [bundled, overlay] = await Promise.all([
    builtin().then(messagesOf),
    hasOverlay(code, fetcher),
  ]);
  if (!overlay) return bundled;
  try {
    return { ...bundled, ...(await fetchMessages(code, fetcher)) };
  } catch {
    return bundled;
  }
}
