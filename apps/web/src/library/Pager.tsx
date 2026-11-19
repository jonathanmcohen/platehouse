// The library's page numbers (Jon, 2026-11-19): Previous, the page numbers
// and Next, in a nav landmark named "Library pages". Each is a link to the
// page's own address, so it works with Back and Forward, a middle click and
// a shared link. The current page is marked aria-current="page", which
// library.css draws like the active chip. Long ranges are shortened to seven
// slots with gaps (pagerItems), so the control keeps one width as the page
// changes; at phone width library.css hides the words Previous and Next
// behind their arrows (the words stay the links' names) so it fits at 375 px.
// The first page has no Previous and the last no Next.
//
// onNavigate is called when a link to another page is followed in this tab,
// before the new page loads, so the library can move focus once it has. A
// click that opens the link elsewhere (a modifier key, another button) or
// that something else prevented leaves this tab where it is, so it does not
// call it, and neither does the current page's own link, which loads nothing.
import type { MouseEvent } from "react";
import { Link } from "react-router";
import { useI18n } from "../i18n/I18n";

export type PagerItem = number | "gap";

/** Most slots the pager shows, numbers and gaps together. */
const SLOTS = 7;

/**
 * The page numbers to show for page of pageCount: every page up to seven,
 * else the first and last pages, the current page and its neighbours, and a
 * gap for each run of pages left out, always seven slots.
 */
export function pagerItems(page: number, pageCount: number): PagerItem[] {
  const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => from + i);
  if (pageCount <= SLOTS) return range(1, pageCount);
  if (page <= 4) return [...range(1, 5), "gap", pageCount];
  if (page >= pageCount - 3) return [1, "gap", ...range(pageCount - 4, pageCount)];
  return [1, "gap", page - 1, page, page + 1, "gap", pageCount];
}

export interface PagerProps {
  page: number;
  pageCount: number;
  /** The address of page n. */
  hrefFor: (page: number) => string;
  onNavigate?: () => void;
}

function Chevron({ direction }: { direction: "left" | "right" }) {
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={direction === "left" ? "M15 6l-6 6 6 6" : "M9 6l6 6-6 6"} />
    </svg>
  );
}

export function Pager({ page, pageCount, hrefFor, onNavigate }: PagerProps) {
  const { t } = useI18n();
  const followed = (event: MouseEvent<HTMLAnchorElement>) => {
    const inThisTab =
      !event.defaultPrevented &&
      event.button === 0 &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey;
    if (inThisTab) onNavigate?.();
  };
  return (
    <nav className="ph-pager" aria-label={t("library.pager.label")}>
      {page > 1 ? (
        <Link
          to={hrefFor(page - 1)}
          rel="prev"
          className="studio-chip ph-pager-step"
          onClick={followed}
        >
          <Chevron direction="left" />
          <span className="ph-pager-word">{t("library.pager.previous")}</span>
        </Link>
      ) : null}
      <ul className="studio-chips ph-pager-pages">
        {pagerItems(page, pageCount).map((item, i) =>
          item === "gap" ? (
            // At most two gaps: one before the current page, one after.
            <li key={i < 3 ? "gap-start" : "gap-end"} className="ph-pager-gap" aria-hidden="true">
              ...
            </li>
          ) : (
            <li key={item}>
              <Link
                to={hrefFor(item)}
                className="studio-chip"
                aria-label={t("library.pager.page", { page: item })}
                {...(item === page ? { "aria-current": "page" as const } : { onClick: followed })}
              >
                {item}
              </Link>
            </li>
          ),
        )}
      </ul>
      {page < pageCount ? (
        <Link
          to={hrefFor(page + 1)}
          rel="next"
          className="studio-chip ph-pager-step"
          onClick={followed}
        >
          <span className="ph-pager-word">{t("library.pager.next")}</span>
          <Chevron direction="right" />
        </Link>
      ) : null}
    </nav>
  );
}
