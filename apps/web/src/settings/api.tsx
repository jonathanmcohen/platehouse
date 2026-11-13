// The web app's calls to its own JSON API under /app/api (build plan Task
// 21), shared by the settings, trash and organising pages. Plain fetch: the
// browser sends the session cookie and, on every POST, PUT, PATCH and
// DELETE, the Origin header the server's gate checks, so nothing here adds
// a credential. An answer that is not a success becomes an AppApiError
// carrying one plain sentence for the page to show; no server detail is
// shown beyond the message the server wrote for the page. A .tsx module
// like the pages that use it: useAppApi is a React hook.
import { useCallback, useEffect, useRef, useState } from "react";

export class AppApiError extends Error {
  readonly status: number;
  /** The answer's JSON body, or null; a page reads a route's own fields from it. */
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown = null) {
    super(message);
    this.name = "AppApiError";
    this.status = status;
    this.body = body;
  }
}

function sentenceFor(status: number, body: unknown): string {
  if (status === 401) return "You are signed out. Reload the page to sign in again.";
  const message = (body as { message?: unknown } | null)?.message;
  if (status < 500 && typeof message === "string" && message !== "") return message;
  if (status === 503) return "This is unavailable right now. Try again in a moment.";
  if (status === 404) return "That is no longer there. Reload the page to see the latest.";
  return "Something went wrong. Try again.";
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
    throw new AppApiError(0, "Platehouse cannot be reached. Check the connection and try again.");
  }
  if (res.status === 204) return undefined as T;
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) throw new AppApiError(res.status, sentenceFor(res.status, data), data);
  return data as T;
}

/** A path segment: a tag, collection or id, encoded. */
export function segment(value: string): string {
  return encodeURIComponent(value);
}

/** The sentence to show for a failed call. */
export function errorText(error: unknown): string {
  return error instanceof AppApiError ? error.message : "Something went wrong. Try again.";
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
  /** GETs path again and shows the answer, keeping the current data meanwhile. */
  reload(): void;
}

/** GETs path when the component mounts (and when path changes). */
export function useAppApi<T>(path: string | null): Loaded<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  /** The path now shown, so a reload's answer for an earlier path is dropped. */
  const current = useRef(path);

  useEffect(() => {
    current.current = path;
    if (path === null) return;
    let live = true;
    setData(undefined);
    setError(undefined);
    appApi<T>("GET", path).then(
      (value) => {
        if (live) setData(value);
      },
      (failure: unknown) => {
        if (live) setError(errorText(failure));
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

  const reload = useCallback(() => {
    if (path === null) return;
    appApi<T>("GET", path).then(
      (value) => {
        if (current.current !== path) return;
        setData(value);
        setError(undefined);
      },
      (failure: unknown) => {
        if (current.current === path) setError(errorText(failure));
      },
    );
  }, [path]);

  return { data, error, set, reload };
}

/** A date for display, in the browser's own language. */
export function formatDate(iso: string, withTime = false): string {
  const options: Intl.DateTimeFormatOptions = withTime
    ? { dateStyle: "medium", timeStyle: "short" }
    : { dateStyle: "medium" };
  return new Intl.DateTimeFormat(undefined, options).format(new Date(iso));
}
