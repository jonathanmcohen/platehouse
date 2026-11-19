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

/**
 * A language's messages: English at once, a built-in from its chunk,
 * anything else from the server. Rejects when it cannot be had; the caller
 * then stays in English.
 */
export async function loadMessages(code: string, fetcher: typeof fetch = fetch): Promise<Messages> {
  if (code === SOURCE_LOCALE) return ENGLISH;
  const builtin = builtinLoaders.get(code);
  if (builtin !== undefined) return messagesOf(await builtin());
  const res = await fetcher(`/app/api/locales/${encodeURIComponent(code)}`, {
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`the language ${code} answered ${res.status}`);
  const answer = (await res.json()) as LocaleAnswer;
  return messagesOf(answer.messages);
}
