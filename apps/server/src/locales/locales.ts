// The languages the server knows (Jon, 2026-11-19): the built-in catalogs in
// packages/i18n/locales (English, the source of truth, and every language a
// contributor added there), and any a self-hoster drops into LOCALES_DIR.
//
// A LOCALES_DIR file is read without a rebuild or a restart: the folder is
// listed at startup and again whenever it is asked for and its modification
// time has changed. Each file must be named <code>.json for a locale code
// (es, pt-BR), be a regular file (a symlink is refused, as the inbox does),
// be at most MAX_LOCALE_BYTES, and hold a JSON object. Its messages are
// checked against English with @platehouse/i18n's checkCatalog, lenient: a
// message that passes is used, one that does not (markup, a placeholder
// English does not have, a control or bidi character, a bad plural) is
// dropped, an unknown key is dropped, and a missing key falls back to English
// in the browser. What was dropped is logged by key, never by value. A file
// for a built-in language overlays it key by key; en cannot be overridden.
//
// Messages are always rendered as text by the web app, never as markup, and
// the check refuses any < that is not one of the English message's own tags.
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type CatalogMeta,
  checkCatalog,
  createTranslator,
  isCleanText,
  languageName,
  type Messages,
  messagesOf,
  parseAcceptLanguage,
  resolveLocale,
  SOURCE_LOCALE,
  type Translator,
} from "@platehouse/i18n";
import { localeOfFileName, readBuiltinCatalogs } from "@platehouse/i18n/node";

/** The largest LOCALES_DIR file read. */
export const MAX_LOCALE_BYTES = 256 * 1024;

/** The most LOCALES_DIR files read. */
export const MAX_LOCALE_FILES = 50;

/** One language as GET /app/api/locales lists it. */
export interface ListedLocale {
  code: string;
  /** The language's name in itself. */
  name: string;
  source: "built-in" | "local";
  /** A machine translation nobody has reviewed yet ($meta.status "machine-draft"). */
  machineDraft: boolean;
  /**
   * A built-in language a LOCALES_DIR file changes: the web app, which
   * bundles the built-in catalogs, then asks GET /app/api/locales/:code for
   * the merged messages. False for every other language.
   */
  overlay: boolean;
  /** Whether it has a message for every English key. */
  complete: boolean;
}

interface Loaded {
  listed: ListedLocale;
  messages: Record<string, string>;
}

export interface LocalesLog {
  warn(details: Record<string, unknown>, message: string): void;
}

export interface Locales {
  /** English's messages. */
  readonly english: Messages;
  /** Every language, English first, then by code. */
  list(): Promise<ListedLocale[]>;
  /** A language's messages, or undefined when there is no such language. */
  messages(code: string): Promise<Messages | undefined>;
  /** The codes of every language. */
  available(): Promise<string[]>;
  /** The language a request is shown in: the ph_lang cookie, else Accept-Language, else English. */
  resolve(saved: string | undefined, acceptLanguage: string | undefined): Promise<string>;
  /** A translator for a language, English for anything unknown. */
  translator(code: string): Promise<Translator>;
}

/** A name a catalog gives itself, when it is plain text of a sensible length. */
function nameOf(meta: { name?: unknown }, code: string): string {
  const name = meta.name;
  return typeof name === "string" && name.length > 0 && name.length <= 40 && isCleanText(name)
    ? name
    : languageName(code);
}

let builtins: Map<string, Loaded> | undefined;

/** The built-in catalogs, read once. */
function builtinLocales(): Map<string, Loaded> {
  if (builtins !== undefined) return builtins;
  const files = readBuiltinCatalogs();
  const english = messagesOf(files.get(SOURCE_LOCALE) as Record<string, unknown>);
  const out = new Map<string, Loaded>();
  for (const [code, data] of files) {
    const checked: { meta: CatalogMeta; messages: Record<string, string>; missing: string[] } =
      code === SOURCE_LOCALE
        ? { meta: {}, messages: english, missing: [] }
        : checkCatalog(code, data, english, { strict: false });
    out.set(code, {
      listed: {
        code,
        name: nameOf(checked.meta, code),
        source: "built-in",
        machineDraft: checked.meta.status === "machine-draft",
        overlay: false,
        complete: checked.missing.length === 0,
      },
      messages: checked.messages,
    });
  }
  builtins = out;
  return out;
}

/** English's messages, from the built-in catalog. */
export function englishMessages(): Messages {
  return (builtinLocales().get(SOURCE_LOCALE) as Loaded).messages;
}

export interface LocalesOptions {
  /** LOCALES_DIR; only the built-in languages when left out. */
  dir?: string | undefined;
  log?: LocalesLog;
}

export function createLocales(options: LocalesOptions = {}): Locales {
  const english = englishMessages();
  const log = options.log;
  /** The local languages and the folder's modification time when they were read. */
  let local: { signature: string; byCode: Map<string, Loaded> } | undefined;

  /**
   * What the folder holds now, as one string: the folder's modification
   * time, and each JSON entry's name, modification time and size. An entry
   * added, removed or renamed changes the folder's time; a file rewritten in
   * place (an editor, or cp onto an existing name) changes only its own, so
   * each file's time and size are part of it too. "" for a folder that
   * cannot be read.
   */
  async function signatureOf(dir: string): Promise<string> {
    try {
      const parts = [String((await stat(dir)).mtimeMs)];
      const names = (await readdir(dir)).filter((n) => n.endsWith(".json")).sort();
      for (const name of names.slice(0, MAX_LOCALE_FILES)) {
        try {
          const info = await lstat(join(dir, name));
          parts.push(`${name}:${info.mtimeMs}:${info.size}`);
        } catch {
          parts.push(`${name}:gone`);
        }
      }
      return parts.join("|");
    } catch {
      return "";
    }
  }

  async function readLocal(dir: string): Promise<Map<string, Loaded>> {
    const byCode = new Map<string, Loaded>();
    let names: string[];
    try {
      names = (await readdir(dir)).sort();
    } catch (error) {
      log?.warn(
        { code: (error as NodeJS.ErrnoException).code },
        "locales: LOCALES_DIR cannot be listed",
      );
      return byCode;
    }
    const files = names.filter((name) => name.endsWith(".json"));
    if (files.length > MAX_LOCALE_FILES) {
      log?.warn(
        { files: files.length, read: MAX_LOCALE_FILES },
        "locales: too many files in LOCALES_DIR",
      );
    }
    for (const name of files.slice(0, MAX_LOCALE_FILES)) {
      const code = localeOfFileName(name);
      if (code === undefined || code === SOURCE_LOCALE) {
        log?.warn(
          { file: name },
          "locales: a file in LOCALES_DIR is not named <code>.json for a language",
        );
        continue;
      }
      const path = join(dir, name);
      let data: unknown;
      try {
        const info = await lstat(path);
        if (!info.isFile()) {
          log?.warn({ file: name }, "locales: a LOCALES_DIR entry is not a regular file");
          continue;
        }
        if (info.size > MAX_LOCALE_BYTES) {
          log?.warn(
            { file: name, bytes: info.size, limit: MAX_LOCALE_BYTES },
            "locales: a LOCALES_DIR file is too large",
          );
          continue;
        }
        data = JSON.parse(await readFile(path, "utf8")) as unknown;
      } catch {
        log?.warn({ file: name }, "locales: a LOCALES_DIR file could not be read as JSON");
        continue;
      }
      const checked = checkCatalog(code, data, english, { strict: false });
      if (checked.unknown.length > 0 || checked.problems.length > 0) {
        log?.warn(
          {
            file: name,
            unknownKeys: checked.unknown.slice(0, 20),
            refusedKeys: checked.problems.map((p) => p.key).slice(0, 20),
          },
          "locales: messages in a LOCALES_DIR file were dropped",
        );
      }
      const builtin = builtinLocales().get(code);
      const messages = { ...(builtin?.messages ?? {}), ...checked.messages };
      if (Object.keys(messages).length === 0) continue;
      byCode.set(code, {
        listed: {
          code,
          name: nameOf(checked.meta, code),
          source: builtin === undefined ? "local" : "built-in",
          overlay: builtin !== undefined,
          machineDraft:
            checked.meta.status === "machine-draft" ||
            (builtin?.listed.machineDraft === true && checked.meta.status === undefined),
          complete: Object.keys(english).every((key) => Object.hasOwn(messages, key)),
        },
        messages,
      });
    }
    return byCode;
  }

  async function all(): Promise<Map<string, Loaded>> {
    const out = new Map(builtinLocales());
    const dir = options.dir;
    if (dir !== undefined) {
      const signature = await signatureOf(dir);
      if (local === undefined || local.signature !== signature) {
        local = { signature, byCode: signature === "" ? new Map() : await readLocal(dir) };
      }
      for (const [code, loaded] of local.byCode) out.set(code, loaded);
    }
    return out;
  }

  return {
    english,
    async list() {
      const byCode = await all();
      return [...byCode.values()]
        .map((l) => l.listed)
        .sort((a, b) =>
          a.code === SOURCE_LOCALE
            ? -1
            : b.code === SOURCE_LOCALE
              ? 1
              : a.code.localeCompare(b.code),
        );
    },
    async messages(code) {
      return (await all()).get(code)?.messages;
    },
    async available() {
      return [...(await all()).keys()];
    },
    async resolve(saved, acceptLanguage) {
      return resolveLocale({
        saved,
        wanted: parseAcceptLanguage(acceptLanguage),
        available: [...(await all()).keys()],
      });
    },
    async translator(code) {
      const messages = (await all()).get(code)?.messages;
      return messages === undefined
        ? createTranslator(SOURCE_LOCALE, english, english)
        : createTranslator(code, messages, english);
    },
  };
}
