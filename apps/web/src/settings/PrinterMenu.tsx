// The printer setting (build plan Task 21; AC-031 menu UI). A themed select
// of every printer the slicer has a profile for, grouped by printer model
// with each model's nozzle choices (the server's groupPrinters, from Task
// 12's listPrinters). Choosing one saves it at once: the server queues
// re-estimation of the whole library in the background, and the page says
// that until a plate's new estimate lands its old numbers stay, marked as
// for the previous printer. A change that fails puts the menu back and says
// why.
import { type ChangeEvent, useId, useState } from "react";
import { appApi, errorText } from "./api";
import type { PrinterGroup } from "./SettingsPage";

export interface PrinterMenuProps {
  printerId: string;
  /** The menu; null while the slicer cannot be asked. */
  printers: PrinterGroup[] | null;
}

/** The nozzle choice's label, such as "0.4 mm nozzle". */
export function nozzleLabel(nozzle: number): string {
  return `${nozzle} mm nozzle`;
}

export function PrinterMenu({ printerId, printers }: PrinterMenuProps) {
  const id = useId();
  const [selected, setSelected] = useState(printerId);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);

  async function change(event: ChangeEvent<HTMLSelectElement>) {
    const next = event.currentTarget.value;
    const previous = selected;
    if (next === previous) return;
    setSelected(next);
    setBusy(true);
    setError(undefined);
    setStatus("");
    try {
      await appApi("PUT", "/settings/printer", { printerId: next });
      setStatus(
        `Re-estimating the library for ${next} in the background. Until a plate's new estimate ` +
          `lands, its old numbers stay visible, marked as for ${previous}.`,
      );
    } catch (failure) {
      setSelected(previous);
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ph-field">
      <label htmlFor={id}>Printer</label>
      {printers === null ? (
        <p className="studio-muted">
          The slicer cannot be reached, so the printer list is not available right now. The selected
          printer is {printerId}.
        </p>
      ) : (
        <select id={id} className="ph-select" value={selected} onChange={change} disabled={busy}>
          {printers.map((group) => (
            <optgroup key={group.model} label={group.model}>
              {group.printers.map((p) => (
                <option key={p.id} value={p.id}>
                  {nozzleLabel(p.nozzle)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      )}
      <p className="studio-muted">
        Platehouse estimates time, weight and filament for every plate on this printer.
      </p>
      <p role="status">{status}</p>
      {error === undefined ? null : <p className="studio-alert studio-alert-alert">{error}</p>}
    </div>
  );
}
