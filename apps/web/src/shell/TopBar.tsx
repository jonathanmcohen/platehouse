// The bar above every page (build plan Task 18, AC-071 and AC-064): the
// narrow-screen menu button, the search box, Add and the theme switch.
// A search goes to the library with ?q=, which the library page (Task 19)
// reads. Add opens the upload dialog, which Task 19 passes in as onAdd;
// until then the button is shown disabled.
import type { FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { MenuButton } from "./MenuButton";
import { ThemeSwitch } from "./ThemeSwitch";
import type { Theme } from "./theme";

/** The longest search the box takes, as in manyfold-studio's top bar. */
export const MAX_QUERY = 200;

export interface TopBarProps {
  theme: Theme;
  onThemeChange(theme: Theme): void;
  onAdd?: () => void;
}

export function TopBar({ theme, onThemeChange, onAdd }: TopBarProps) {
  const navigate = useNavigate();
  const [params] = useSearchParams();

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const q = String(new FormData(event.currentTarget).get("q") ?? "").trim();
    navigate(q === "" ? "/" : `/?${new URLSearchParams({ q })}`);
  }

  return (
    <div className="studio-topbar">
      <MenuButton />
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
            defaultValue={params.get("q") ?? ""}
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
    </div>
  );
}
