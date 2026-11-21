// Where the web app gets each language's messages (the maintainer, 2026-11-19).
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

/**
 * Each built-in catalog's $meta, read at build time so the language menu can
 * mark a machine draft before (or without) the server's list. The query
 * makes each a module of its own that keeps only $meta, so the messages stay
 * in each language's own chunk (without it the build pulls every catalog into
 * the main bundle); its "lang.json" ending keeps the id a JSON module to
 * Vite 8, which rejects a JSON file with any other query.
 */
const BUILTIN_META = import.meta.glob<{ status?: unknown } | undefined>(
  "../../../../packages/i18n/locales/*.json",
  { eager: true, import: "$meta", query: "?meta&lang.json" },
);

const builtinDrafts = new Set<string>();
for (const [path, meta] of Object.entries(BUILTIN_META)) {
  const file = path.slice(path.lastIndexOf("/") + 1).replace(/\?.*$/, "");
  const code = canonicalLocale(file.slice(0, -".json".length));
  if (code !== undefined && meta?.status === "machine-draft") builtinDrafts.add(code);
}

/** The built-in languages' codes, English included. */
export function builtinLocales(): string[] {
  return [...builtinLoaders.keys()].sort();
}

/** Whether a built-in language is a machine translation nobody has reviewed yet ($meta.status "machine-draft"). */
export function isBuiltinMachineDraft(code: string): boolean {
  return builtinDrafts.has(code);
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

/**
 * How long the language list may take before a built-in language is used
 * without a self-hoster's changes (issue 296): a list that hangs, such as a
 * LOCALES_DIR on a hung network mount, counts as no changes.
 */
export const OVERLAY_LIST_TIMEOUT_MS = 4000;

/** Whether the server's language list marks a built-in language as changed by a LOCALES_DIR file. */
async function hasOverlay(
  code: string,
  fetcher: typeof fetch,
  timeoutMs: number,
): Promise<boolean> {
  try {
    const res = await fetcher("/app/api/locales", {
      ...JSON_GET,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    const { locales } = (await res.json()) as {
      locales: Array<{ code: string; overlay?: boolean }>;
    };
    return locales.some((l) => l.code === code && l.overlay === true);
  } catch {
    return false;
  }
}

/** The bundled messages with the server's LOCALES_DIR changes over them; undefined when there are none or they cannot be read. */
async function withOverlay(
  code: string,
  bundled: Messages,
  listed: Promise<boolean>,
  fetcher: typeof fetch,
): Promise<Messages | undefined> {
  if (!(await listed)) return undefined;
  try {
    return { ...bundled, ...(await fetchMessages(code, fetcher)) };
  } catch {
    return undefined;
  }
}

/** What the first paint has: messages to render now, and any to swap in when they arrive. */
export interface InitialMessages {
  messages: Messages;
  /**
   * A built-in language's messages with a self-hoster's LOCALES_DIR changes
   * merged over them, when the server lists some; undefined when it lists
   * none or cannot be read. Never rejects.
   */
  later?: Promise<Messages | undefined>;
}

/**
 * A language's messages for the first paint (PR 287 review): English at
 * once; a built-in one from its chunk alone, with the server's list asked
 * beside it and any overlay handed back as later, so a slow or hanging
 * GET /app/api/locales never holds the page blank; anything else from the
 * server. Rejects when a language cannot be had at all; the caller then
 * stays in English.
 */
export async function loadInitialMessages(
  code: string,
  fetcher: typeof fetch = fetch,
  listTimeoutMs: number = OVERLAY_LIST_TIMEOUT_MS,
): Promise<InitialMessages> {
  if (code === SOURCE_LOCALE) return { messages: ENGLISH };
  const builtin = builtinLoaders.get(code);
  if (builtin === undefined) return { messages: await fetchMessages(code, fetcher) };
  // Asked at once, beside the chunk; hasOverlay never rejects.
  const listed = hasOverlay(code, fetcher, listTimeoutMs);
  const bundled = messagesOf(await builtin());
  return { messages: bundled, later: withOverlay(code, bundled, listed, fetcher) };
}

/**
 * A language's messages, whole: English at once; a built-in one from its
 * chunk, with a self-hoster's LOCALES_DIR changes merged over it when the
 * server lists them in time (the chunk alone if the list cannot be read or
 * hangs past listTimeoutMs); anything else from the server. Rejects when a
 * language cannot be had at all; the caller then stays in English.
 */
export async function loadMessages(
  code: string,
  fetcher: typeof fetch = fetch,
  listTimeoutMs: number = OVERLAY_LIST_TIMEOUT_MS,
): Promise<Messages> {
  const { messages, later } = await loadInitialMessages(code, fetcher, listTimeoutMs);
  return (await later) ?? messages;
}
