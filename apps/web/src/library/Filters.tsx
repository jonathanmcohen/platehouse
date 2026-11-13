// The library's tag filter (build plan Task 19, AC-061): a chip per tag that
// live models carry, and All. A chip is a link that sets ?tag= and keeps the
// search (?q=), so the filter is in the URL, works with Back and Forward,
// and is reachable by keyboard. The current choice is marked
// aria-current="true", which studio.css draws as the active chip.
import { Link, useSearchParams } from "react-router";

export interface FiltersProps {
  /** The tags to offer, in the order to show them. */
  tags: string[];
}

export function Filters({ tags }: FiltersProps) {
  const [params] = useSearchParams();
  const active = params.get("tag");
  if (tags.length === 0) return null;

  function hrefFor(tag: string | null): string {
    const next = new URLSearchParams();
    const q = params.get("q");
    if (q !== null && q !== "") next.set("q", q);
    if (tag !== null) next.set("tag", tag);
    const query = next.toString();
    return query === "" ? "/" : `/?${query}`;
  }

  const isActive = (tag: string | null) =>
    tag === null ? active === null || active === "" : active?.toLowerCase() === tag.toLowerCase();

  return (
    <nav aria-label="Filter by tag">
      <ul className="studio-chips">
        {[null, ...tags].map((tag) => (
          <li key={tag ?? ""}>
            <Link
              to={hrefFor(tag)}
              className="studio-chip"
              {...(isActive(tag) ? { "aria-current": "true" as const } : {})}
            >
              {tag ?? "All"}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
