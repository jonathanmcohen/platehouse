// The narrow-screen menu (build plan Task 18, AC-074): below 899.98 px the
// sidebar is hidden (studio.css) and this button opens the same navigation
// in a panel. The panel is always in the page, hidden while closed, so
// aria-controls always names it. Escape closes it and puts focus back on the
// button; so does a press outside it, and following one of its links.
import { useEffect, useRef, useState } from "react";
import { Sidebar } from "./Sidebar";

const PANEL_ID = "ph-menu";

export function MenuButton() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
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
        Menu
      </button>
      <div id={PANEL_ID} className="studio-menu-panel" hidden={!open}>
        <Sidebar menu onNavigate={() => setOpen(false)} />
      </div>
    </div>
  );
}
