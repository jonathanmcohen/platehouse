// The frame around every page (build plan Task 18, AC-071): the sidebar on
// the left, the top bar (menu, search, Add, theme) above the content, and a
// skip link to the main landmark. It holds the theme: initialTheme is what
// the server wrote into the html element, and a change is applied to the
// document (cookie, data-theme, color-scheme) at once, with no reload.
// Following a link in the narrow-screen menu puts focus on the main
// landmark, as the skip link does, so a keyboard user starts in the new
// section. So does any other client-side change of page (issue #187): a
// card's link to a model page, Show in the library, a sidebar link. The
// link that was followed often goes away with the old page, and the browser
// then leaves focus on the body, so a keyboard or screen-reader user would
// start again from the top of the document. It happens here, once, when the
// path changes: not on Back or Forward (a POP, where the browser restores
// focus), not for a change of search or filter on the same page (a tag chip
// keeps focus), and not when focus is in the top bar's search box, which a
// search leaves there on purpose (TopBar).
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useLocation, useNavigationType } from "react-router";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { applyTheme, DEFAULT_THEME, type Theme } from "./theme";

export interface ShellProps {
  initialTheme?: Theme;
  /** The upload dialog's opener (Task 19); Add is disabled without it. */
  onAdd?: () => void;
  children?: ReactNode;
}

export function Shell({ initialTheme = DEFAULT_THEME, onAdd, children }: ShellProps) {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const main = useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  const navigationType = useNavigationType();
  const shownPath = useRef(pathname);

  useEffect(() => {
    if (shownPath.current === pathname) return;
    shownPath.current = pathname;
    if (navigationType === "POP") return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest(".studio-search") !== null) return;
    main.current?.focus();
  }, [pathname, navigationType]);

  function changeTheme(next: Theme) {
    applyTheme(next, document);
    setTheme(next);
  }

  return (
    <>
      <a className="studio-skip" href="#ph-content">
        Skip to content
      </a>
      <div className="studio-app">
        <Sidebar />
        <div className="studio-main">
          <TopBar
            theme={theme}
            onThemeChange={changeTheme}
            onMenuNavigate={() => main.current?.focus()}
            {...(onAdd === undefined ? {} : { onAdd })}
          />
          <main id="ph-content" className="studio-content" tabIndex={-1} ref={main}>
            {children}
          </main>
        </div>
      </div>
    </>
  );
}
