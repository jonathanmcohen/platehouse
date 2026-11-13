// Platehouse's navigation (build plan Task 18, AC-071): Library, Creators,
// Collections and Tags, then Task 21's Trash and Settings. Rendered as the sidebar on wide screens and, with
// menu, inside the narrow-screen menu panel. NavLink marks the current
// section aria-current="page"; Library matches only its own path. The
// server answers with the shell only at listed paths (SHELL_PAGES in
// apps/server/src/web/shell.ts); a server test checks every section here is
// one of them, or a reload of that section would be a 404.
import { Link, NavLink } from "react-router";

export const SECTIONS: ReadonlyArray<{ label: string; to: string }> = [
  { label: "Library", to: "/" },
  { label: "Creators", to: "/creators" },
  { label: "Collections", to: "/collections" },
  { label: "Tags", to: "/tags" },
  // Task 21: the trash and settings pages.
  { label: "Trash", to: "/trash" },
  { label: "Settings", to: "/settings" },
];

export interface SidebarProps {
  /** Inside the menu panel: no brand, and onNavigate runs when a link is followed. */
  menu?: boolean;
  onNavigate?: () => void;
}

export function Sidebar({ menu = false, onNavigate }: SidebarProps) {
  return (
    <nav className={menu ? "studio-menu-nav" : "studio-sidebar"} aria-label="Main">
      {menu ? null : (
        <Link to="/" className="studio-brand">
          <span className="studio-brand-dot" aria-hidden="true" />
          Platehouse
        </Link>
      )}
      <ul className="studio-nav-list">
        {SECTIONS.map(({ label, to }) => (
          <li key={to}>
            <NavLink to={to} end={to === "/"} onClick={onNavigate}>
              {label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
