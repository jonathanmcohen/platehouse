// The library's numbered pages and View all, as they live in the URL (Jon,
// 2026-11-19): ?page=<n> beside ?q, ?tag, ?creator and ?collection, and
// ?view=all for every match on one page. Page 1 has no ?page=, so the
// library's plain address stays /.

/** Models on one numbered page; the server's LIBRARY_PAGE_SIZE. */
export const PAGE_SIZE = 48;

/** Models View all asks for per request: the most the server computes in one. */
export const VIEW_ALL_CHUNK = 200;

/**
 * Most models View all shows: the server's paged match cap (PAGED_MATCH_CAP
 * in apps/server/src/app-api/library.ts), past which it counts no further.
 */
export const VIEW_ALL_MAX = 1000;

/**
 * Highest page the server accepts: its querystring schema's maximum for page
 * in apps/server/src/app-api/library.ts (MAX_PAGE_NUMBER), past which it
 * answers 400. A higher ?page= asks for this one, which the server serves as
 * its last page.
 */
export const PAGE_MAX = 1_000_000;

/**
 * ?page= as a page number: a whole number from 1, at most PAGE_MAX (so a
 * page past the end, however far, shows the last page), else page 1.
 */
export function pageFrom(value: string | null): number {
  if (value === null || !/^[0-9]+$/.test(value)) return 1;
  const page = Number(value);
  return page >= 1 ? Math.min(page, PAGE_MAX) : 1;
}

/** True when the URL asks for View all. */
export function isViewAll(params: URLSearchParams): boolean {
  return params.get("view") === "all";
}

/** The library's address with edit applied to a copy of params. */
export function libraryHref(
  params: URLSearchParams,
  edit: (next: URLSearchParams) => void,
): string {
  const next = new URLSearchParams(params);
  edit(next);
  const text = next.toString();
  return text === "" ? "/" : `/?${text}`;
}

/** The address of numbered page n, keeping the search and filters. */
export function pageHref(params: URLSearchParams, page: number): string {
  return libraryHref(params, (next) => {
    next.delete("view");
    if (page <= 1) next.delete("page");
    else next.set("page", String(page));
  });
}
