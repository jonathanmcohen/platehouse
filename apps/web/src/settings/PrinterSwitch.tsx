// The printer switch on the library header and the model page (Jon,
// 2026-11-19): a small menu of My printers that changes whose times and
// weights the page shows. It only reads. The page asks its own route again
// with ?printer=<id> (app-api/library.ts and model.ts), whose answer names
// the printer shown and lists the choices, so the switch needs no request of
// its own and never starts a slice; estimates are made for every printer in
// My printers anyway, in the background.
//
// - The choice is kept per browser (localStorage, PRINTER_CHOICE_KEY), so the
//   library and the model page show the same printer, and a reload keeps it.
//   Nothing is stored until the menu is used.
// - A stored choice the server no longer lists (the printer was removed from
//   My printers) is answered with the default printer; the page then forgets
//   it (usePrinterChoice's settle).
// - With one printer there is nothing to switch, so the page says which
//   printer the numbers are for, in full, as plain text.
// - The menu's label is the sentence it completes, "Times and weights for",
//   so a screen reader announces "Times and weights for, Bambu Lab P1S,
//   0.4 mm nozzle, menu". Each option is the printer in full.
import { useI18n } from "../i18n/I18n";
import { printerNameIn } from "../i18n/printers";
import { useCallback, useId, useState } from "react";
import "./organise.css";

/** Where the browser keeps the printer switch's choice. */
export const PRINTER_CHOICE_KEY = "platehouse.printer";

/** One choice: one of My printers, named in full. */
export interface PrinterChoice {
  id: string;
  name: string;
}

function readChoice(): string | null {
  try {
    return localStorage.getItem(PRINTER_CHOICE_KEY);
  } catch {
    return null;
  }
}

function writeChoice(printerId: string | null): void {
  try {
    if (printerId === null) localStorage.removeItem(PRINTER_CHOICE_KEY);
    else localStorage.setItem(PRINTER_CHOICE_KEY, printerId);
  } catch {
    // Storage is off (a private window): the choice lasts for this page only.
  }
}

export interface PrinterChoiceState {
  /** The stored choice, or null for the default printer. */
  choice: string | null;
  /** Stores a new choice; the page asks for its numbers again. */
  choose(printerId: string): void;
  /**
   * Called with the printer an answer was for: a stored choice the server
   * answered with another printer is no longer in My printers, so it is
   * forgotten and the page shows the default.
   */
  settle(shown: string): void;
}

/** The printer switch's choice, kept per browser. */
export function usePrinterChoice(): PrinterChoiceState {
  const [choice, setChoice] = useState<string | null>(readChoice);
  const choose = useCallback((printerId: string) => {
    writeChoice(printerId);
    setChoice(printerId);
  }, []);
  const settle = useCallback(
    (shown: string) => {
      if (choice !== null && shown !== "" && shown !== choice) {
        writeChoice(null);
        setChoice(null);
      }
    },
    [choice],
  );
  return { choice, choose, settle };
}

/** The ?printer= query part for a choice, or "" for the default printer. */
export function printerQuery(choice: string | null, joiner: "?" | "&" = "?"): string {
  return choice === null ? "" : `${joiner}printer=${encodeURIComponent(choice)}`;
}

export interface PrinterSwitchProps {
  /** The printer the page's numbers are for. */
  printer: string;
  /** That printer in full. */
  printerName: string;
  /** My printers, in order. */
  printers: PrinterChoice[];
  onChoose(printerId: string): void;
}

export function PrinterSwitch({ printer, printerName, printers, onChoose }: PrinterSwitchProps) {
  const i18n = useI18n();
  const id = useId();
  if (printers.length < 2) {
    return (
      <p className="studio-muted">
        {i18n.t("printers.switch.single", { printer: printerNameIn(i18n, printerName) })}
      </p>
    );
  }
  return (
    <div className="ph-printer-switch">
      <label htmlFor={id} className="studio-muted">
        {i18n.t("printers.switch.label")}
      </label>{" "}
      <select
        id={id}
        className="ph-select"
        value={printer}
        onChange={(event) => onChoose(event.currentTarget.value)}
      >
        {printers.map((p) => (
          <option key={p.id} value={p.id}>
            {printerNameIn(i18n, p.name)}
          </option>
        ))}
      </select>
    </div>
  );
}
