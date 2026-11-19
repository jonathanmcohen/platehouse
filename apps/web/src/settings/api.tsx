// The web app's calls to its own JSON API under /app/api (build plan Task
// 21), shared by the settings, trash and organising pages. Plain fetch: the
// browser sends the session cookie and, on every POST, PUT, PATCH and
// DELETE, the Origin header the server's gate checks, so nothing here adds
// a credential. An answer that is not a success becomes an AppApiError
// carrying one plain sentence for the page to show; no server detail is
// shown beyond the message the server wrote for the page. A .tsx module
// like the pages that use it: useAppApi is a React hook.
import { useCallback, useEffect, useRef, useState } from "react";
import { formatDateTime, SOURCE_LOCALE } from "@platehouse/i18n";
import { ENGLISH_I18N, type I18n, type MessageKey, useI18n } from "../i18n/I18n";

/** Builds the sentences in a language; English when left out. */
type Words = Pick<I18n, "t" | "locale">;

export class AppApiError extends Error {
  readonly status: number;
  /** The answer's JSON body, or null; a page reads a route's own fields from it. */
  readonly body: unknown;

  /**
   * Whether message is appApi's own sentence for status and body, which
   * errorText says again in the shown language; false for an error a page
   * built with its own, already translated, words.
   */
  readonly fromServer: boolean;

  constructor(status: number, message: string, body: unknown = null, fromServer = false) {
    super(message);
    this.name = "AppApiError";
    this.status = status;
    this.body = body;
    this.fromServer = fromServer;
  }
}

/**
 * The words for each refusal the app API names by code (its error, or a finer
 * code beside it). The English words are the server's own sentences, so an
 * English page reads exactly what the server wrote.
 */
const CODE_KEYS: Readonly<Record<string, MessageKey>> = {
  unknown_printer: "api.unknownPrinter",
  printers_changed: "api.printersChanged",
  slicer_unavailable: "api.slicerUnavailable",
  purge_started: "api.purgeStarted",
  stale_trash: "api.staleTrash",
  token_name_length: "api.tokenNameLength",
  titles_not_previewed: "api.titlesNotPreviewed",
  plan_changed: "api.planChanged",
};

/**
 * The sentence for a refused call, in a language. An English page shows the
 * server's own sentence for the page, word for word. Another language shows a
 * known code's words, else a line for the status: a server sentence is
 * English, so it never reaches a page in another language.
 */
export function sentenceFor(status: number, body: unknown, i18n: Words = ENGLISH_I18N): string {
  const { t } = i18n;
  if (status === 0) return t("api.unreachable");
  if (status === 401) return t("common.signedOut");
  const fields = (body ?? {}) as { error?: unknown; code?: unknown; message?: unknown; max?: unknown };
  const message = fields.message;
  const said = status < 500 && typeof message === "string" && message !== "";
  if (said && i18n.locale === SOURCE_LOCALE) return message;
  const key =
    (typeof fields.code === "string" ? CODE_KEYS[fields.code] : undefined) ??
    (typeof fields.error === "string" ? CODE_KEYS[fields.error] : undefined);
  if (key !== undefined && status < 500) {
    return t(key, typeof fields.max === "number" ? { max: fields.max } : {});
  }
  if (said) return t("api.refused");
  if (status === 503) return t("api.unavailable");
  if (status === 404) return t("api.gone");
  return t("api.failed");
}

/** One call to /app/api; resolves with the JSON answer, or undefined for 204. */
export async function appApi<T = undefined>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  const init: RequestInit = { method, headers, credentials: "same-origin" };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(`/app/api${path}`, init);
  } catch {
    throw new AppApiError(0, sentenceFor(0, null), null, true);
  }
  if (res.status === 204) return undefined as T;
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) throw new AppApiError(res.status, sentenceFor(res.status, data), data, true);
  return data as T;
}

/**
 * A path segment: an id, encoded. Never a tag or collection name: the URL
 * parser treats a segment of "." or ".." (and %2E or %2e) as a dot segment
 * and rewrites the path before the request goes out, and such names can be
 * stored through the public API v1. Those go in nameQuery instead.
 */
export function segment(value: string): string {
  return encodeURIComponent(value);
}

/** A tag or collection name as the query string ?name=<name>, encoded. */
export function nameQuery(name: string): string {
  return `?name=${encodeURIComponent(name)}`;
}

/** The sentence to show for a failed call, in a language; English when left out. */
export function errorText(error: unknown, i18n: Words = ENGLISH_I18N): string {
  if (!(error instanceof AppApiError)) return i18n.t("api.failed");
  return error.fromServer ? sentenceFor(error.status, error.body, i18n) : error.message;
}

/** errorText in the shown language, for a component. */
export function useErrorText(): (error: unknown) => string {
  const i18n = useI18n();
  return (error) => errorText(error, i18n);
}

export interface Loaded<T> {
  data: T | undefined;
  error: string | undefined;
  /**
   * Changes the data the page shows, after a change it made. Give it an
   * updater (prev => next) whenever the next value is built from the current
   * one: it gets the data as it is when the change lands, so two changes in
   * flight never undo each other. An updater does nothing while nothing is
   * loaded.
   */
  set(next: T | ((prev: T) => T)): void;
  /**
   * GETs path again and shows the answer, keeping the current data meanwhile.
   * Resolves true once that answer, or a newer one, is shown, and false when
   * the read failed or the path changed; it never rejects. An answer older
   * than the one on screen is dropped (#254): two reads of one path can
   * answer out of order, such as a poll sent before a save answering after
   * the read that follows the save.
   */
  reload(): Promise<boolean>;
}

/** GETs path when the component mounts (and when path changes). */
export function useAppApi<T>(path: string | null): Loaded<T> {
  const i18n = useI18n();
  const words = useRef<Words>(i18n);
  words.current = i18n;
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  /** The path now shown, so a reload's answer for an earlier path is dropped. */
  const current = useRef(path);
  /** Each GET's number, in the order sent. */
  const sent = useRef(0);
  /** The number of the GET whose answer is on screen. */
  const shown = useRef(0);

  useEffect(() => {
    current.current = path;
    if (path === null) return;
    let live = true;
    const mine = ++sent.current;
    setData(undefined);
    setError(undefined);
    appApi<T>("GET", path).then(
      (value) => {
        if (!live || mine < shown.current) return;
        shown.current = mine;
        setData(value);
      },
      (failure: unknown) => {
        if (live) setError(errorText(failure, words.current));
      },
    );
    return () => {
      live = false;
    };
  }, [path]);

  const set = useCallback((next: T | ((prev: T) => T)) => {
    if (typeof next !== "function") {
      setData(next);
      return;
    }
    const update = next as (prev: T) => T;
    setData((prev) => (prev === undefined ? prev : update(prev)));
  }, []);

  const reload = useCallback(async (): Promise<boolean> => {
    if (path === null) return false;
    const mine = ++sent.current;
    try {
      const value = await appApi<T>("GET", path);
      if (current.current !== path) return false;
      // A newer answer is already on screen: it holds at least what this one would.
      if (mine < shown.current) return true;
      shown.current = mine;
      setData(value);
      setError(undefined);
      return true;
    } catch (failure) {
      if (current.current === path) setError(errorText(failure, words.current));
      return false;
    }
  }, [path]);

  return { data, error, set, reload };
}

/** A date for display, in a language (the shown one, through useI18n's fmt.date). */
export function formatDate(iso: string, withTime = false, locale?: string): string {
  return formatDateTime(locale ?? ENGLISH_I18N.locale, iso, withTime);
}
