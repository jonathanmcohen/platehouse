// The languages the server knows (Jon, 2026-11-19): the built-in catalogs in
// packages/i18n/locales (English, the source of truth, and every language a
// contributor added there), and any a self-hoster drops into LOCALES_DIR.
//
// A LOCALES_DIR file is read without a rebuild or a restart, and a page never
// waits on the folder (PR 287 review, issue 297): the folder is read once at
// startup, then again in the background every refreshMs (LOCALES_REFRESH_MS),
// one read at a time. Every request (the shell pages, the login pages and
// GET /app/api/locales) reads only the languages last read, in memory, and
// never touches the filesystem, so a hung network mount cannot hold a page.
// A folder that cannot be read (missing, unreadable) offers the built-in
// languages only; a read slower than readLimitMs keeps the languages last
// read (before any read has worked, the built-in languages only, said as
// such; issue 299). There is never more than one read of the folder at a
// time, even past the limit: a filesystem call cannot be cancelled, and on a
// hard network mount whose server has gone a stat holds one of libuv's few
// threadpool threads (4 by default) in the kernel for as long as the mount
// hangs, so a second read beside it would hang too and hold another, until
// static files, uploads and DNS lookups had no thread left (PR 287 review).
// A background read that comes due while a read is still out is skipped; the
// folder is read again on the first tick after that read settles. Each
// state is its own log line, said once when the folder goes bad, and
// once more when it can be read again, never once per read. Each file must
// be named <code>.json for a locale code (es, pt-BR), be a regular file (a symlink is refused, as the inbox does),
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

/** How often LOCALES_DIR is read again in the background. */
export const LOCALES_REFRESH_MS = 15_000;

/**
 * How long one read of LOCALES_DIR may take before the folder counts as one
 * that cannot be read (a hung or very slow mount), and how long startup waits
 * for the first read before it goes on with the built-in languages.
 */
export const LOCALES_READ_LIMIT_MS = 5_000;

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
  /**
   * Resolves once the first read of LOCALES_DIR has finished, or after
   * readLimitMs if it has not (startup goes on with the built-in languages
   * and the read lands when it can). Resolves at once without LOCALES_DIR.
   */
  ready(): Promise<void>;
  /** Reads LOCALES_DIR now, or joins the read already in flight. */
  refresh(): Promise<void>;
  /** Stops the background reads (the server closing). */
  close(): void;
}

/** The filesystem calls a read of LOCALES_DIR makes; node:fs/promises unless a test gives its own. */
export interface LocalesFs {
  stat(path: string): Promise<{ mtimeMs: number }>;
  readdir(path: string): Promise<string[]>;
  lstat(path: string): Promise<{ mtimeMs: number; size: number; isFile(): boolean }>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
}

const NODE_FS: LocalesFs = {
  stat: (path) => stat(path),
  readdir: (path) => readdir(path),
  lstat: (path) => lstat(path),
  readFile: (path, encoding) => readFile(path, encoding),
};

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
  /** How often the folder is read again; LOCALES_REFRESH_MS when left out. */
  refreshMs?: number;
  /** How long a read may take before the folder counts as unreadable; LOCALES_READ_LIMIT_MS when left out. */
  readLimitMs?: number;
  /** The filesystem; node:fs/promises when left out (a test holds or counts calls with its own). */
  fs?: LocalesFs;
}

/** A timer that does not keep the process alive. */
function unrefTimer(handle: ReturnType<typeof setTimeout>): void {
  (handle as { unref?: () => void }).unref?.();
}

/** The folder could not be read; code is the filesystem's error code. */
class FolderUnreadable extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`LOCALES_DIR cannot be read (${code})`);
    this.name = "FolderUnreadable";
    this.code = code;
  }
}

export function createLocales(options: LocalesOptions = {}): Locales {
  const english = englishMessages();
  const log = options.log;
  const fs = options.fs ?? NODE_FS;
  const dir = options.dir;
  const refreshMs = options.refreshMs ?? LOCALES_REFRESH_MS;
  const readLimitMs = options.readLimitMs ?? LOCALES_READ_LIMIT_MS;
  /** The local languages last read, and what the folder held then. */
  let local: { signature: string; byCode: Map<string, Loaded> } = {
    signature: "",
    byCode: new Map(),
  };
  /**
   * The read of the folder still out, if any. Every call joins it, however
   * long it has run: a read that has outlasted readLimitMs is still holding a
   * threadpool thread, and a new read on the same mount would hold another.
   */
  let inFlight: Promise<void> | undefined;
  /** Whether any read of the folder has ever worked; until then only the built-in languages exist. */
  let everRead = false;
  /**
   * The folder's bad state, logged once until it recovers: slow (a read
   * outlasted readLimitMs, the languages last read are kept), slowFirst (the
   * same before any read has worked, so only the built-in languages are
   * offered) or unreadable (the read failed, the built-in languages only are
   * offered). A slow read that then fails is logged again, as unreadable; a
   * slow read that works while unreadable is logged again, as slow; a first
   * read that lands late is logged once, as read at last; nothing else is.
   */
  let bad: "slow" | "slowFirst" | "unreadable" | undefined;
  let closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  function goneSlow(details: Record<string, unknown>): void {
    if (bad !== undefined) return;
    if (!everRead) {
      // Nothing was ever read (a mount unreachable at startup): there are no
      // languages "last read", only the built-in ones.
      bad = "slowFirst";
      log?.warn(
        details,
        "locales: nothing has been read from LOCALES_DIR yet, so only the built-in languages are offered",
      );
      return;
    }
    bad = "slow";
    log?.warn(
      details,
      "locales: LOCALES_DIR is slow to read, so the languages last read from it are offered",
    );
  }

  /** The first read that worked came after the read limit: its languages are offered now. */
  function readAtLast(details: Record<string, unknown>): void {
    if (bad !== "slowFirst") return;
    bad = "slow";
    log?.warn(
      details,
      "locales: LOCALES_DIR was read at last, so its languages are offered; it is still slow to read",
    );
  }

  function goneUnreadable(details: Record<string, unknown>): void {
    if (bad === "unreadable") return;
    bad = "unreadable";
    log?.warn(
      details,
      "locales: LOCALES_DIR cannot be read, so only the built-in languages are offered",
    );
  }

  /** A slow read worked while the folder was unreadable: its languages are offered again. */
  function backSlow(details: Record<string, unknown>): void {
    if (bad !== "unreadable") return;
    bad = undefined;
    goneSlow(details);
  }

  function recovered(): void {
    if (bad === undefined) return;
    bad = undefined;
    log?.warn({}, "locales: LOCALES_DIR can be read again");
  }

  /**
   * What the folder holds now, as one string: the folder's modification
   * time, and each JSON entry's name, modification time and size. An entry
   * added, removed or renamed changes the folder's time; a file rewritten in
   * place (an editor, or cp onto an existing name) changes only its own, so
   * each file's time and size are part of it too. Throws FolderUnreadable
   * for a folder that cannot be read.
   */
  async function signatureOf(folder: string): Promise<string> {
    let parts: string[];
    let names: string[];
    try {
      parts = [String((await fs.stat(folder)).mtimeMs)];
      names = (await fs.readdir(folder)).filter((n) => n.endsWith(".json")).sort();
    } catch (error) {
      throw new FolderUnreadable(String((error as NodeJS.ErrnoException).code ?? "unknown"));
    }
    for (const name of names.slice(0, MAX_LOCALE_FILES)) {
      try {
        const info = await fs.lstat(join(folder, name));
        parts.push(`${name}:${info.mtimeMs}:${info.size}`);
      } catch {
        parts.push(`${name}:gone`);
      }
    }
    return parts.join("|");
  }

  async function readLocal(folder: string): Promise<Map<string, Loaded>> {
    const byCode = new Map<string, Loaded>();
    let names: string[];
    try {
      names = (await fs.readdir(folder)).sort();
    } catch (error) {
      throw new FolderUnreadable(String((error as NodeJS.ErrnoException).code ?? "unknown"));
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
      const path = join(folder, name);
      let data: unknown;
      try {
        const info = await fs.lstat(path);
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
        data = JSON.parse(await fs.readFile(path, "utf8")) as unknown;
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

  /**
   * One read of the folder, or the read already out. A read that outlasts
   * readLimitMs puts the folder in the slow state (logged once; before any
   * read has worked, as nothing read yet) and is left to finish in the
   * background; until it settles every call joins it and no new read starts,
   * so a hung mount holds one threadpool thread, never more. Its result is
   * used when it lands, however late. Only a read that finishes within the
   * limit counts as the folder recovering, so a mount that is always slow
   * logs once, not once per read.
   * A folder that cannot be read offers no local languages until it can be
   * again, and is logged as unreadable, even after a slow line; a slow read
   * that then works is logged as slow, since its languages are offered again.
   */
  function readFolder(folder: string): Promise<void> {
    if (inFlight !== undefined) return inFlight;
    let slow = false;
    const limit = setTimeout(() => {
      slow = true;
      goneSlow({ readLimitMs });
    }, readLimitMs);
    unrefTimer(limit);
    const promise = (async () => {
      try {
        const signature = await signatureOf(folder);
        const byCode = signature === local.signature ? local.byCode : await readLocal(folder);
        local = { signature, byCode };
        everRead = true;
        if (!slow) recovered();
        else if (bad === "slowFirst") readAtLast({ readLimitMs });
        else backSlow({ readLimitMs });
      } catch (error) {
        local = { signature: "", byCode: new Map() };
        goneUnreadable({
          code: error instanceof FolderUnreadable ? error.code : (error as Error).name,
        });
      }
    })().finally(() => {
      clearTimeout(limit);
      inFlight = undefined;
    });
    inFlight = promise;
    return promise;
  }

  /** Every language as last read: the built-in ones and LOCALES_DIR's. Never reads the filesystem. */
  function all(): Map<string, Loaded> {
    const out = new Map(builtinLocales());
    for (const [code, loaded] of local.byCode) out.set(code, loaded);
    return out;
  }

  /** The first read, started now; the background reads follow on a timer. */
  const first: Promise<void> = dir === undefined ? Promise.resolve() : readFolder(dir);
  if (dir !== undefined) {
    timer = setInterval(() => {
      if (!closed) void readFolder(dir);
    }, refreshMs);
    unrefTimer(timer);
  }

  return {
    english,
    async list() {
      const byCode = all();
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
      return all().get(code)?.messages;
    },
    async available() {
      return [...all().keys()];
    },
    async resolve(saved, acceptLanguage) {
      return resolveLocale({
        saved,
        wanted: parseAcceptLanguage(acceptLanguage),
        available: [...all().keys()],
      });
    },
    async translator(code) {
      const messages = all().get(code)?.messages;
      return messages === undefined
        ? createTranslator(SOURCE_LOCALE, english, english)
        : createTranslator(code, messages, english);
    },
    ready() {
      return new Promise((resolve) => {
        const limit = setTimeout(resolve, readLimitMs);
        unrefTimer(limit);
        void first.then(() => {
          clearTimeout(limit);
          resolve();
        });
      });
    },
    refresh() {
      return dir === undefined || closed ? Promise.resolve() : readFolder(dir);
    },
    close() {
      closed = true;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}
