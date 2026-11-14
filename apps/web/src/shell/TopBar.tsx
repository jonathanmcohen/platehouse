// The bar above every page (build plan Task 18, AC-071 and AC-064): the
// narrow-screen menu button, the search box, Add and the theme switch.
// A search goes to the library with ?q=, which the library page (Task 19)
// reads. Add opens the upload dialog, which Task 19 passes in as onAdd;
// until then the button is shown disabled.
// The box follows the URL: the shell stays mounted across routes, so on every
// navigation (a search, Back, Forward, a sidebar link) the box is reset to
// the new ?q=, and typing between navigations is kept as a draft. It is a
// controlled input rather than one keyed on ?q=, because a new key would
// remount it and drop focus out of the box after a search.
// The bar is a header outside main, so it is the page's banner landmark and
// everything in it, the theme switch included, is inside a landmark (#205).
import { type FormEvent, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { MenuButton } from "./MenuButton";
import { ThemeSwitch } from "./ThemeSwitch";
import type { Theme } from "./theme";

/** The longest search the box takes, as in manyfold-studio's top bar. */
export const MAX_QUERY = 200;

export interface TopBarProps {
  theme: Theme;
  onThemeChange(theme: Theme): void;
  onAdd?: () => void;
  /** Runs after a link in the narrow-screen menu is followed (MenuButton). */
  onMenuNavigate?: () => void;
}

export function TopBar({ theme, onThemeChange, onAdd, onMenuNavigate }: TopBarProps) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const location = useLocation();
  const urlQuery = params.get("q") ?? "";
  const [query, setQuery] = useState(urlQuery);
  const [shownFor, setShownFor] = useState(location.key);
  if (shownFor !== location.key) {
    // State adjusted during render, as React's docs recommend for state
    // derived from a changing value; React re-renders before painting.
    setShownFor(location.key);
    setQuery(urlQuery);
  }

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const q = String(new FormData(event.currentTarget).get("q") ?? "").trim();
    navigate(q === "" ? "/" : `/?${new URLSearchParams({ q })}`);
  }

  return (
    <header className="studio-topbar">
      <MenuButton {...(onMenuNavigate === undefined ? {} : { onNavigate: onMenuNavigate })} />
      <search className="studio-search">
        <form action="/" method="get" onSubmit={search}>
          <label htmlFor="ph-q" className="studio-visually-hidden">
            Search the library
          </label>
          <input
            type="search"
            id="ph-q"
            name="q"
            maxLength={MAX_QUERY}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search names, creators and tags"
            autoComplete="off"
          />
        </form>
      </search>
      <button
        type="button"
        className="studio-button studio-button-primary"
        onClick={onAdd}
        disabled={onAdd === undefined}
      >
        <span aria-hidden="true">+</span> Add
      </button>
      <ThemeSwitch theme={theme} onChange={onThemeChange} />
    </header>
  );
}
