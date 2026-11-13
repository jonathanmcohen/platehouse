// The printer setting (build plan Task 21; AC-031 menu UI). A themed select
// of every printer the slicer has a profile for, grouped by printer model
// with each model's nozzle choices (the server's groupPrinters, from Task
// 12's listPrinters). Choosing one in the menu saves nothing: Save printer
// does. On Windows an arrow key on a focused, closed select changes its value
// and fires change at once, so saving on change would save, and queue
// re-estimation of the whole library for, a printer only passed on the way.
// Once saved, the server queues re-estimation of the whole library in the
// background, and the page says that until a plate's new estimate lands its
// old numbers stay, marked as for the previous printer. While the save runs
// the menu and Save printer are marked aria-disabled and ignore input; as in
// ConfirmDialog, neither takes the disabled attribute, because a browser
// moves focus out of a focused control that becomes disabled. A save that
// fails puts the menu back and says why. The stored printer can be missing
// from the slicer's list, after an OrcaSlicer update renames a profile (the
// server then refuses estimates with UnknownPrinter): the menu then shows it
// as a disabled option with a note, so the page shows the true state and any
// real choice is a change.
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

/** The disabled option for a stored printer the slicer no longer offers. */
export function goneLabel(printerId: string): string {
  return `${printerId}, no longer offered by the slicer`;
}

export function PrinterMenu({ printerId, printers }: PrinterMenuProps) {
  const id = useId();
  const [saved, setSaved] = useState(printerId);
  const [selected, setSelected] = useState(printerId);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);

  function pick(event: ChangeEvent<HTMLSelectElement>) {
    // The select is controlled, so ignoring a change while a save runs puts
    // it back to the printer being saved.
    if (busy) return;
    setSelected(event.currentTarget.value);
  }

  async function save() {
    const next = selected;
    const previous = saved;
    if (busy || next === previous) return;
    setBusy(true);
    setError(undefined);
    setStatus("");
    try {
      await appApi("PUT", "/settings/printer", { printerId: next });
      setSaved(next);
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

  const offered =
    printers === null || printers.some((group) => group.printers.some((p) => p.id === saved));

  return (
    <div className="ph-field">
      {printers === null ? (
        <>
          {/* No select to name, so plain text, not a label pointing at nothing. */}
          <span>Printer</span>
          <p className="studio-muted">
            The slicer cannot be reached, so the printer list is not available right now. The
            selected printer is {printerId}.
          </p>
        </>
      ) : (
        <>
          <label htmlFor={id}>Printer</label>
          <div className="ph-inline-form">
            <select
              id={id}
              className="ph-select"
              value={selected}
              onChange={pick}
              aria-disabled={busy}
            >
              {offered ? null : (
                <option value={saved} disabled>
                  {goneLabel(saved)}
                </option>
              )}
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
            <button type="button" className="studio-button" onClick={save} aria-disabled={busy}>
              Save printer
            </button>
          </div>
        </>
      )}
      {offered ? null : (
        <p className="studio-alert studio-alert-alert">
          The slicer no longer offers the selected printer, {saved}, so no plate can be estimated.
          Choose a printer from the list and save it.
        </p>
      )}
      <p className="studio-muted">
        Platehouse estimates time, weight and filament for every plate on this printer.
      </p>
      <p role="status">{status}</p>
      {error === undefined ? null : (
        <p role="alert" className="studio-alert studio-alert-alert">
          {error}
        </p>
      )}
    </div>
  );
}
