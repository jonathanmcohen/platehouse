// A printer's name in the shown language (Jon, 2026-11-19). The server
// names printers in English ("Bambu Lab P1S, 0.4 mm nozzle", "another
// printer"; packages/i18n/src/printers.ts); this writes them again with the
// catalog's words and the language's decimal mark. A name in any other form
// (an Orca preset the pattern does not cover) is shown as it is.
import { OTHER_PRINTER_LABEL, parsePrinterName } from "@platehouse/i18n";
import type { I18n } from "./I18n";

export function printerNameIn(i18n: Pick<I18n, "t" | "fmt">, name: string): string {
  if (name === OTHER_PRINTER_LABEL) return i18n.t("printer.other");
  const parsed = parsePrinterName(name);
  if (parsed === undefined) return name;
  return i18n.t("printer.full", {
    model: parsed.model,
    nozzle: i18n.fmt.decimal(parsed.nozzle, 2),
  });
}

/** A nozzle choice's label, such as "0.4 mm nozzle". */
export function nozzleIn(i18n: Pick<I18n, "t" | "fmt">, nozzle: number): string {
  return i18n.t("printer.nozzle", { nozzle: i18n.fmt.decimal(nozzle, 2) });
}
