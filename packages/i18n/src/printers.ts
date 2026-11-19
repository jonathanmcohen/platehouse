// How a printer is named (Jon, 2026-11-19). The server names a printer in
// English in its answers, such as "Bambu Lab P1S, 0.4 mm nozzle", and names a
// file's printer the slicer's menu lacks "another printer"
// (apps/server/src/estimates/display.ts builds both with what is here). The
// web app reads those names back with PRINTER_NAME and writes them in the
// shown language, so the server's answers keep their shape (the public API
// is pinned byte for byte) and the page still translates them.

/** What a file's printer the slicer's menu does not have is called. */
export const OTHER_PRINTER_LABEL = "another printer";

/** A printer named in full: its model, a comma, its nozzle in mm. */
export const PRINTER_NAME = /^(.+), ([0-9]+(?:\.[0-9]+)?) mm nozzle$/;

/** A printer's full English name, such as "Bambu Lab P1S, 0.4 mm nozzle". */
export function englishPrinterName(model: string, nozzle: number): string {
  return `${model}, ${nozzle} mm nozzle`;
}

/** A full name read back into its model and nozzle, or undefined for any other name. */
export function parsePrinterName(name: string): { model: string; nozzle: number } | undefined {
  const m = PRINTER_NAME.exec(name);
  if (m === null) return undefined;
  return { model: m[1] as string, nozzle: Number(m[2]) };
}
