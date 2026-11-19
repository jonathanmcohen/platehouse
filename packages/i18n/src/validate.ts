// Checks a translation against the English catalog, the source of truth
// (Jon, 2026-11-19). The same check runs in three places: the CI test over
// the built-in catalogs (strict: every key, the same placeholders, tags and
// plural cases), the server over a file a self-hoster drops into
// LOCALES_DIR (lenient: missing keys fall back to English, unknown keys are
// dropped), and pnpm i18n:format.
//
// A value is refused when it is not a string, is longer than MAX_MESSAGE,
// holds a control or bidi-override character, does not parse, uses a
// placeholder, tag or plural argument the English message does not, or names
// a plural case the locale does not have. Markup cannot get through: the
// parser refuses any < that is not one of the message's own tags.
import { type MessageNode, MessageSyntaxError, messageShape, parseMessage } from "./message.js";

/** The longest message taken, in characters. */
export const MAX_MESSAGE = 2000;

/** The key of the metadata object in a catalog file. */
export const META_KEY = "$meta";

/** A catalog's metadata. Every field is optional in a LOCALES_DIR file. */
export interface CatalogMeta {
  /** The locale code, as the file is named. */
  locale?: string;
  /** The language's name in itself, for the language menu. */
  name?: string;
  /** "machine-draft" for a machine translation nobody has reviewed yet. */
  status?: string;
  review?: { needed?: boolean; reviewedBy?: string | null; reviewedOn?: string | null };
  catalogVersion?: number;
}

/** A catalog's messages by key, without the metadata. */
export type Messages = Readonly<Record<string, string>>;

export interface CatalogProblem {
  key: string;
  problem: string;
}

export interface CheckedCatalog {
  meta: CatalogMeta;
  /** The messages that passed, ready to use. */
  messages: Record<string, string>;
  /** English keys the catalog has no message for. */
  missing: string[];
  /** Keys that are not English keys. */
  unknown: string[];
  /** Messages refused, with why; strict mode also lists missing and unknown keys here. */
  problems: CatalogProblem[];
}

// C0 and C1 controls (a tab or newline has no place in a UI string either),
// and the bidi embedding, override and isolate characters, which can make a
// string display differently from what it holds.
// biome-ignore lint/suspicious/noControlCharactersInRegex: this pattern exists to find control characters and refuse them.
const FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

/** Whether text holds no control or bidi-override character (a name a catalog gives itself). */
export function isCleanText(text: string): boolean {
  return !FORBIDDEN.test(text);
}

/** The plural categories a locale's numbers fall into, from Intl.PluralRules. */
export function pluralCategories(locale: string): Set<string> {
  return new Set(new Intl.PluralRules(locale).resolvedOptions().pluralCategories);
}

/** English messages parsed once per catalog object. */
const englishShapes = new WeakMap<Messages, Map<string, ReturnType<typeof messageShape>>>();

function shapesOf(english: Messages) {
  let shapes = englishShapes.get(english);
  if (shapes === undefined) {
    shapes = new Map();
    for (const [key, value] of Object.entries(english)) {
      shapes.set(key, messageShape(parseMessage(value)));
    }
    englishShapes.set(english, shapes);
  }
  return shapes;
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

/** Why one message is refused, or null when it passes. */
function messageProblem(
  locale: string,
  value: unknown,
  english: ReturnType<typeof messageShape>,
  strict: boolean,
  categories: ReadonlySet<string>,
): string | null {
  if (typeof value !== "string") return "is not a string";
  if (value.length > MAX_MESSAGE) return `is longer than ${MAX_MESSAGE} characters`;
  if (FORBIDDEN.test(value)) return "holds a control or bidi character";
  let nodes: MessageNode[];
  try {
    nodes = parseMessage(value);
  } catch (error) {
    if (error instanceof MessageSyntaxError) return `does not parse: ${error.message}`;
    throw error;
  }
  const shape = messageShape(nodes);
  for (const arg of shape.args) {
    if (!english.args.has(arg)) return `uses {${arg}}, which the English message does not`;
  }
  for (const tag of shape.tags) {
    if (!english.tags.has(tag)) return `uses <${tag}>, which the English message does not`;
  }
  for (const [arg, cases] of shape.plurals) {
    if (!english.plurals.has(arg))
      return `makes {${arg}} a plural, which the English message does not`;
    for (const c of cases) {
      if (!c.startsWith("=") && !categories.has(c)) {
        return `names the plural case ${c}, which ${locale} does not have`;
      }
    }
    if (strict) {
      for (const c of categories) {
        if (!cases.has(c)) return `lacks the plural case ${c} for {${arg}}`;
      }
    }
  }
  if (strict) {
    if (!sameSet(shape.args, english.args))
      return "does not use every placeholder the English message does";
    if (!sameSet(shape.tags, english.tags))
      return "does not use every tag the English message does";
  }
  return null;
}

/**
 * Checks a parsed catalog file against English. strict is the built-in
 * catalogs' rule (CI): every English key, the same placeholders and tags,
 * every plural case the locale has. Lenient is a LOCALES_DIR file's: what
 * passes is used and the rest falls back to English.
 */
export function checkCatalog(
  locale: string,
  data: unknown,
  english: Messages,
  options: { strict: boolean },
): CheckedCatalog {
  const result: CheckedCatalog = { meta: {}, messages: {}, missing: [], unknown: [], problems: [] };
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    result.problems.push({ key: "", problem: "the file is not a JSON object" });
    result.missing = Object.keys(english);
    return result;
  }
  const shapes = shapesOf(english);
  const categories = pluralCategories(locale);
  const record = data as Record<string, unknown>;
  const meta = record[META_KEY];
  if (meta !== undefined) {
    if (typeof meta === "object" && meta !== null && !Array.isArray(meta)) {
      result.meta = meta as CatalogMeta;
    } else {
      result.problems.push({ key: META_KEY, problem: "is not an object" });
    }
  } else if (options.strict) {
    result.problems.push({ key: META_KEY, problem: "is missing" });
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === META_KEY) continue;
    const shape = shapes.get(key);
    if (shape === undefined) {
      result.unknown.push(key);
      if (options.strict) result.problems.push({ key, problem: "is not an English key" });
      continue;
    }
    const problem = messageProblem(locale, value, shape, options.strict, categories);
    if (problem === null) result.messages[key] = value as string;
    else result.problems.push({ key, problem });
  }
  for (const key of Object.keys(english)) {
    if (!Object.hasOwn(record, key)) {
      result.missing.push(key);
      if (options.strict) result.problems.push({ key, problem: "is missing" });
    }
  }
  return result;
}

/** Checks the English catalog itself: every message parses, and $meta names en. */
export function checkEnglish(data: unknown): CatalogProblem[] {
  const problems: CatalogProblem[] = [];
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return [{ key: "", problem: "the file is not a JSON object" }];
  }
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (key === META_KEY) continue;
    if (typeof value !== "string") {
      problems.push({ key, problem: "is not a string" });
      continue;
    }
    if (FORBIDDEN.test(value)) problems.push({ key, problem: "holds a control or bidi character" });
    try {
      parseMessage(value);
    } catch (error) {
      if (!(error instanceof MessageSyntaxError)) throw error;
      problems.push({ key, problem: `does not parse: ${error.message}` });
    }
  }
  return problems;
}

/** The messages of a catalog file, without $meta. */
export function messagesOf(data: Readonly<Record<string, unknown>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key !== META_KEY && typeof value === "string") out[key] = value;
  }
  return out;
}
