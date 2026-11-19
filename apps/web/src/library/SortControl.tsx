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
import { useI18n } from "../i18n/I18n";
import { type LibrarySort, SORT_OPTIONS, sortFrom, sortHref } from "./paging";

export interface SortControlProps {
  /** The active search, which decides whether best match is offered. */
  q: string;
  /** The selected printer the times and weights are for; empty while unknown. */
  printer: string;
}

export function SortControl({ q, printer }: SortControlProps) {
  const { t } = useI18n();
  const id = useId();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const sort = sortFrom(params, q);
  const options = SORT_OPTIONS.filter((o) => o.value !== "relevance" || q !== "");
  const measure = sort.startsWith("time-") ? "time" : sort.startsWith("weight-") ? "weight" : null;
  const note =
    measure === null
      ? null
      : printer === ""
        ? t(measure === "time" ? "library.sort.noteTimeSelected" : "library.sort.noteWeightSelected")
        : t(measure === "time" ? "library.sort.noteTime" : "library.sort.noteWeight", { printer });
  return (
    <div className="ph-sort">
      <label htmlFor={id}>{t("library.sort.label")}</label>
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
            {t(o.labelKey)}
          </option>
        ))}
      </select>
      {note === null ? null : (
        <p id={`${id}-note`} className="studio-muted">
          {note}
        </p>
      )}
    </div>
  );
}
