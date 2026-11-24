// The library's tag filter: a chip per tag that
// live models carry, and All. A chip is a link that sets ?tag= and keeps the
// search (?q=) and an active creator or collection filter (?creator=,
// ?collection=; issue #194), so the filter is in the URL, works with Back
// and Forward, and is reachable by keyboard. All drops only the tag. A chip
// also keeps View all (?view=all) and the sort (?sort=) and drops the page
// number (?page=), so a new tag starts again at page 1. The current choice is marked
// aria-current="true", which studio.css draws as the active chip.
//
// A tag filter always has its chip and All (issue #317): when ?tag= names a
// tag no live model carries any more (its last model lost the tag or went to
// the trash), or the library has no tags at all, the filtered tag still gets
// a marked chip right after All, so the filter shows and All clears it.
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useI18n } from "../i18n/I18n";

/** What a tag chip keeps of the library's address: the search, the other filters, View all and the sort. */
const KEPT = ["q", "creator", "collection", "view", "sort"] as const;

/** How many tag chips show before More tags (issue #458). */
export const TAG_CHIPS_SHOWN = 30;

export interface FiltersProps {
  /** The tags to offer, most-used first, each with how many live models carry it. */
  tags: Array<{ name: string; models: number }>;
}

export function Filters({ tags }: FiltersProps) {
  const { t } = useI18n();
  const [params] = useSearchParams();
  const [expanded, setExpanded] = useState(false);
  const active = params.get("tag")?.trim() ?? "";
  const names = tags.map((tag) => tag.name);
  const found = names.findIndex((name) => name.toLowerCase() === active.toLowerCase());
  // The filtered tag, when the list no longer offers it.
  const orphan = active !== "" && found === -1 ? active : null;
  const collapsible = names.length > TAG_CHIPS_SHOWN;
  const showAll = expanded || !collapsible;
  const visible = showAll ? names : names.slice(0, TAG_CHIPS_SHOWN);
  // The filtered tag stays visible next to All, even beyond the first 30.
  const promoted = !showAll && found >= TAG_CHIPS_SHOWN ? [names[found] as string] : [];
  const shown = orphan === null ? [...promoted, ...visible] : [orphan, ...visible];
  if (shown.length === 0) return null;
  const hidden = names.length - visible.length - promoted.length;

  function hrefFor(tag: string | null): string {
    const next = new URLSearchParams();
    for (const key of KEPT) {
      const value = params.get(key);
      if (value !== null && value !== "") next.set(key, value);
    }
    if (tag !== null) next.set("tag", tag);
    const query = next.toString();
    return query === "" ? "/" : `/?${query}`;
  }

  const isActive = (tag: string | null) =>
    tag === null ? active === "" : active.toLowerCase() === tag.toLowerCase();

  return (
    <nav aria-label={t("library.tags.label")}>
      <ul className="studio-chips">
        {[null, ...shown].map((tag) => (
          <li key={tag ?? ""}>
            <Link
              to={hrefFor(tag)}
              className="studio-chip"
              {...(isActive(tag) ? { "aria-current": "true" as const } : {})}
            >
              {tag ?? t("library.tags.all")}
            </Link>
          </li>
        ))}
        {collapsible ? (
          <li>
            <button
              type="button"
              className="studio-chip"
              aria-expanded={expanded}
              onClick={() => setExpanded((open) => !open)}
            >
              {expanded ? t("library.tags.fewer") : t("library.tags.more", { count: hidden })}
            </button>
          </li>
        ) : null}
      </ul>
    </nav>
  );
}
