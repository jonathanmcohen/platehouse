// The narrow-screen menu (build plan Task 18, AC-074): below 899.98 px the
// sidebar is hidden (studio.css) and this button opens the same navigation
// in a panel. The panel is always in the page, hidden while closed, so
// aria-controls always names it. Escape closes it and puts focus back on the
// button. Following one of its links closes it and calls onNavigate, which
// the shell uses to put focus on the main landmark, so focus never drops to
// the document body from the hidden panel; without onNavigate, focus goes
// back to the button. A press outside closes it and leaves focus where that
// press put it.
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/I18n";
import { Sidebar } from "./Sidebar";

const PANEL_ID = "ph-menu";

/**
 * Whether the narrow-screen menu is open, for a page's own document Escape
 * listener (Select mode's in LibraryPage): that listener can run before this
 * one, so it asks here and leaves Escape to the menu while it is open.
 */
export function menuIsOpen(): boolean {
  const panel = document.getElementById(PANEL_ID);
  return panel !== null && !panel.hidden;
}

export interface MenuButtonProps {
  /** Runs after a link in the menu is followed; it should move focus. */
  onNavigate?: () => void;
}

export function MenuButton({ onNavigate }: MenuButtonProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Marked as used, as UploadDialog does, so a page's own Escape listener
      // (Select mode's) leaves it alone in either listener order: when this
      // one runs first, the menu is already shown closed by the time that one
      // runs, so menuIsOpen alone cannot tell (issue #285).
      event.preventDefault();
      setOpen(false);
      button.current?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && root.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  return (
    <div className="studio-menu" ref={root}>
      <button
        ref={button}
        type="button"
        className="studio-button"
        aria-expanded={open}
        aria-controls={PANEL_ID}
        onClick={() => setOpen((was) => !was)}
      >
        {t("shell.menu")}
      </button>
      <div id={PANEL_ID} className="studio-menu-panel" hidden={!open}>
        <Sidebar
          menu
          onNavigate={() => {
            setOpen(false);
            if (onNavigate === undefined) button.current?.focus();
            else onNavigate();
          }}
        />
      </div>
    </div>
  );
}
