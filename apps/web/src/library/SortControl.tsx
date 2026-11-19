// The library's sort menu (Jon, 2026-11-19): a labelled select of the
// library's orders (SORT_OPTIONS). Best match is offered only while a search
// is active, and is then the default; newest is the default otherwise. A
// choice is a new address (sortHref): the sort in ?sort= (left out for the
// default), back to page 1, the search, filters and View all kept, so the
// order works with Back and Forward and a shared link. The server orders the
// models. Print time and filament weight are totals for the selected
// printer, and models without them come last either way, which the note
// under the menu says.
import { useId } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { type LibrarySort, SORT_OPTIONS, sortFrom, sortHref } from "./paging";

export interface SortControlProps {
  /** The active search, which decides whether best match is offered. */
  q: string;
  /** The selected printer the times and weights are for; empty while unknown. */
  printer: string;
}

export function SortControl({ q, printer }: SortControlProps) {
  const id = useId();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const sort = sortFrom(params, q);
  const options = SORT_OPTIONS.filter((o) => o.value !== "relevance" || q !== "");
  const measure = sort.startsWith("time-")
    ? "a print time"
    : sort.startsWith("weight-")
      ? "a filament weight"
      : null;
  const forPrinter = printer === "" ? "the selected printer" : printer;
  return (
    <div className="ph-sort">
      <label htmlFor={id}>Sort</label>
      <select
        id={id}
        className="ph-select ph-small"
        value={sort}
        {...(measure === null ? {} : { "aria-describedby": `${id}-note` })}
        onChange={(event) =>
          navigate(sortHref(params, event.currentTarget.value as LibrarySort, q))
        }
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {measure === null ? null : (
        <p id={`${id}-note`} className="studio-muted">
          Models without {measure} for {forPrinter} are listed last.
        </p>
      )}
    </div>
  );
}
