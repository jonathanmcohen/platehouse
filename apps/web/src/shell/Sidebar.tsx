// Platehouse's navigation (build plan Task 18, AC-071): Library, Creators,
// Collections and Tags, then Task 21's Trash, the Activity page (Jon,
// 2026-11-19) and Task 21's Settings. Rendered as the
// sidebar on wide screens and, with menu, inside the narrow-screen menu
// panel. NavLink marks the current section aria-current="page"; Library
// matches only its own path. The server answers with the shell only at
// listed paths (SHELL_PAGES in
// apps/server/src/web/shell.ts); a server test checks every section here is
// one of them, or a reload of that section would be a 404.
//
// The brand at the top is the logo (Logo.tsx, aria-hidden beside the name)
// and the name, linking to the library.
import { Link, NavLink } from "react-router";
import { ENGLISH_I18N, type MessageKey, useI18n } from "../i18n/I18n";
import { Logo } from "./Logo";

/**
 * The sections: each one's message key, its English name (for code that is
 * not shown, such as the tests) and its path. A server test reads the paths
 * from this literal list.
 */
export const SECTIONS: ReadonlyArray<{ key: MessageKey; label: string; to: string }> = [
  { key: "shell.nav.library", label: ENGLISH_I18N.t("shell.nav.library"), to: "/" },
  { key: "shell.nav.creators", label: ENGLISH_I18N.t("shell.nav.creators"), to: "/creators" },
  {
    key: "shell.nav.collections",
    label: ENGLISH_I18N.t("shell.nav.collections"),
    to: "/collections",
  },
  { key: "shell.nav.tags", label: ENGLISH_I18N.t("shell.nav.tags"), to: "/tags" },
  // Task 21: the trash and settings pages.
  { key: "shell.nav.trash", label: ENGLISH_I18N.t("shell.nav.trash"), to: "/trash" },
  // What Platehouse is doing and holds: numbers, jobs, the slicer, events.
  { key: "shell.nav.activity", label: ENGLISH_I18N.t("shell.nav.activity"), to: "/activity" },
  { key: "shell.nav.settings", label: ENGLISH_I18N.t("shell.nav.settings"), to: "/settings" },
];

export interface SidebarProps {
  /** Inside the menu panel: no brand, and onNavigate runs when a link is followed. */
  menu?: boolean;
  onNavigate?: () => void;
}

export function Sidebar({ menu = false, onNavigate }: SidebarProps) {
  const { t } = useI18n();
  return (
    <nav className={menu ? "studio-menu-nav" : "studio-sidebar"} aria-label={t("shell.nav.label")}>
      {menu ? null : (
        <Link to="/" className="studio-brand">
          <Logo />
          Platehouse
        </Link>
      )}
      <ul className="studio-nav-list">
        {SECTIONS.map(({ key, to }) => (
          <li key={to}>
            <NavLink to={to} end={to === "/"} onClick={onNavigate}>
              {t(key)}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
