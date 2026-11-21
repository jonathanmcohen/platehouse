// The library's numbered pages, View all and sort, as they live in the URL
// (the maintainer, 2026-11-19): ?page=<n> beside ?q, ?tag, ?creator and ?collection,
// ?view=all for every match on one page, and ?sort= for the order. Page 1
// has no ?page= and the default sort no ?sort=, so the library's plain
// address stays /.

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

/**
 * The library's orders (the maintainer, 2026-11-19), as the server names them
 * (LIBRARY_SORTS in apps/server/src/repos/models.ts), with their labels.
 * Best match is offered only while a search is active.
 */
export const SORT_OPTIONS = [
  { value: "relevance", labelKey: "library.sort.relevance" },
  { value: "newest", labelKey: "library.sort.newest" },
  { value: "oldest", labelKey: "library.sort.oldest" },
  { value: "name-asc", labelKey: "library.sort.nameAsc" },
  { value: "name-desc", labelKey: "library.sort.nameDesc" },
  { value: "time-asc", labelKey: "library.sort.timeAsc" },
  { value: "time-desc", labelKey: "library.sort.timeDesc" },
  { value: "weight-asc", labelKey: "library.sort.weightAsc" },
  { value: "weight-desc", labelKey: "library.sort.weightDesc" },
  { value: "plates-desc", labelKey: "library.sort.platesDesc" },
  { value: "plates-asc", labelKey: "library.sort.platesAsc" },
] as const;

export type LibrarySort = (typeof SORT_OPTIONS)[number]["value"];

/** The sort when the URL names none: best match while searching, else newest (the server's rule). */
export function defaultSort(q: string): LibrarySort {
  return q.trim() === "" ? "newest" : "relevance";
}

function isSort(value: string | null): value is LibrarySort {
  return SORT_OPTIONS.some((o) => o.value === value);
}

/**
 * The sort the URL asks for: ?sort= when it is one the library knows (and
 * best match only while a search is active), else the default for q.
 */
export function sortFrom(params: URLSearchParams, q: string): LibrarySort {
  const asked = params.get("sort");
  if (!isSort(asked)) return defaultSort(q);
  if (asked === "relevance" && q.trim() === "") return defaultSort(q);
  return asked;
}

/**
 * The address for a new sort: back to page 1, keeping the search, filters
 * and View all. The default sort for q is left out of the URL.
 */
export function sortHref(params: URLSearchParams, sort: LibrarySort, q: string): string {
  return libraryHref(params, (next) => {
    next.delete("page");
    if (sort === defaultSort(q)) next.delete("sort");
    else next.set("sort", sort);
  });
}

/** The address of numbered page n, keeping the search and filters. */
export function pageHref(params: URLSearchParams, page: number): string {
  return libraryHref(params, (next) => {
    next.delete("view");
    if (page <= 1) next.delete("page");
    else next.set("page", String(page));
  });
}
