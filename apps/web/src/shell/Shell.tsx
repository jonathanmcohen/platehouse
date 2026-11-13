// The frame around every page (build plan Task 18, AC-071): the sidebar on
// the left, the top bar (menu, search, Add, theme) above the content, and a
// skip link to the main landmark. It holds the theme: initialTheme is what
// the server wrote into the html element, and a change is applied to the
// document (cookie, data-theme, color-scheme) at once, with no reload.
// Following a link in the narrow-screen menu puts focus on the main
// landmark, as the skip link does, so a keyboard user starts in the new
// section.
import { type ReactNode, useRef, useState } from "react";
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
