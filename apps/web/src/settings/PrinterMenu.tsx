// My printers on the Settings page (build plan Task 21; AC-031 menu UI, and
// Jon's 2026-11-19 asks: several printers, and a menu that names the
// printer). Jon lists the printers he owns, picked from the slicer's printer
// menu, in the order he wants them, and one of them is the default.
// Platehouse estimates every plate for each of them; the library and model
// pages show the default first and switch to the others with no slicing.
//
// - Every printer is named in full, its model and nozzle ("Bambu Lab P1S,
//   0.4 mm nozzle"), in the list and in the add menu, so the closed menu
//   says which printer is chosen. The add menu stays grouped by model.
// - The page saves the whole list at once (PUT /app/api/settings/printers)
//   for each change: add, remove, move up or down, or make default. Choosing
//   in the add menu saves nothing: Add printer does. On Windows an arrow key
//   on a focused, closed select changes its value and fires change at once,
//   so adding on change would queue hours of slicing for a printer only
//   passed on the way.
// - Adding a printer queues every plate in the library for it. The slicer
//   does one plate at a time, so the page says how many plates were queued
//   and about how long they take at the slicer's rate (slicesPerMinute), and
//   each printer's line shows the plates it still has waiting, read again
//   every WAITING_POLL_MS while any are. There is one slicer queue for every
//   printer, so both times count the plates queued ahead for other printers
//   (the server's through: slices up to and including the printer's last
//   one), not just the printer's own.
// - Removing asks first in the app's own dialog, because the printer's
//   waiting work is dropped (numbers already made for it are kept). The
//   default printer cannot be removed: another one is made the default
//   first, so the list is never empty.
// - While a save runs every control is marked aria-disabled and ignores
//   input; none takes the disabled attribute, because a browser moves focus
//   out of a focused control that becomes disabled. A save that fails leaves
//   the list as it was and says why. After a move, focus stays on the moved
//   printer's button, so a keyboard user keeps their place.
// - A save is not over until the list read after it is on screen (#254).
//   Every change sends the whole list, and the server treats a printer
//   missing from it as removed, so a click made from the list as it was
//   before a save would drop a printer just added, with no confirm, and
//   cancel its slices. The controls stay busy until that read lands, and an
//   older read (a waiting-count poll sent before the save) never replaces it
//   (useAppApi's reload). If the read fails, the controls stay locked, the
//   page says why, and Read the list again unlocks them once the list is in.
// - A listed printer the slicer no longer offers (an OrcaSlicer update
//   renamed its preset) stays listed, and says nothing can be estimated for
//   it. While the slicer cannot be reached the list still shows, and the
//   add menu says why it is missing.
import { useEffect, useId, useRef, useState } from "react";
import { appApi, errorText } from "./api";
import { ConfirmDialog } from "./Dialog";
import type { MyPrinterView, SettingsView } from "./SettingsPage";

/** How often the page reads the waiting counts again while a printer has any. */
export const WAITING_POLL_MS = 15_000;

/** What PUT /app/api/settings/printers answers. */
interface SavedPrinters {
  /** through: slices that run up to its last plate, other printers' queued work counted. */
  added: Array<{ printerId: string; queued: number; through: number }>;
  removed: string[];
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** About how long plates take at perMinute, in plain words: "about 2 hours and 35 minutes". */
export function howLong(plates: number, perMinute: number): string {
  const minutes = Math.max(1, Math.ceil(plates / perMinute));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `about ${plural(rest, "minute", "minutes")}`;
  if (rest === 0) return `about ${plural(hours, "hour", "hours")}`;
  return `about ${plural(hours, "hour", "hours")} and ${plural(rest, "minute", "minutes")}`;
}

/**
 * What the page says once a printer is added. through is how many slices
 * run up to and including its last plate: the slicer is one queue for every
 * printer, so plates already queued for other printers come first and the
 * time counts them.
 */
export function addedMessage(
  name: string,
  queued: number,
  perMinute: number,
  through = queued,
): string {
  if (queued === 0) return `Added ${name}. Every plate already has numbers for it.`;
  const start =
    `Added ${name}. Platehouse is now estimating ${plural(queued, "plate", "plates")} for it, ` +
    `one at a time, at about ${plural(perMinute, "plate", "plates")} a minute`;
  const ahead = through - queued;
  const wait =
    ahead > 0
      ? `. The slicer has ${plural(ahead, "plate", "plates")} for other printers queued ahead ` +
        `of them, so this takes ${howLong(through, perMinute)}.`
      : `, so this takes ${howLong(queued, perMinute)}.`;
  return `${start}${wait} Its numbers show on each plate as they land, and the other printers' numbers stay as they are.`;
}

/**
 * A printer's waiting line: its plates, and about how long until its last
 * one lands, counting the plates for other printers the one slicer does
 * ahead of them (through).
 */
export function waitingLine(waiting: number, through: number, perMinute: number): string {
  const head = `${plural(waiting, "plate", "plates")} waiting to be estimated, ${howLong(
    Math.max(through, waiting),
    perMinute,
  )} left`;
  const ahead = through - waiting;
  return ahead > 0
    ? `${head}, counting ${plural(ahead, "plate", "plates")} for other printers queued ahead of them.`
    : `${head}.`;
}

export interface PrinterMenuProps {
  view: SettingsView;
  /**
   * Reads the settings again, after a save or to refresh the waiting counts;
   * resolves true once a list read after the call is on screen (useAppApi).
   */
  reload(): Promise<boolean>;
}

type Move = "up" | "down";

export function PrinterMenu({ view, reload }: PrinterMenuProps) {
  const id = useId();
  const listRef = useRef<HTMLOListElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const [busy, setBusy] = useState(false);
  /** A save went through but the list could not be read after it: the list on screen may be old. */
  const [unread, setUnread] = useState(false);
  /** Every control ignores input: a change is running, or the list on screen may be old. */
  const locked = busy || unread;
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [removing, setRemoving] = useState<MyPrinterView | null>(null);
  /** The button to focus ("<printer id> <action>") once the list is drawn in order. */
  const [focusAfter, setFocusAfter] = useState<{ key: string; order: string } | null>(null);
  /** A printer just removed: once its row has left, focus goes to the list. */
  const [removedId, setRemovedId] = useState<string | null>(null);

  const listed = view.myPrinters.map((p) => p.id);
  const offered = view.printers?.flatMap((g) => g.printers) ?? [];
  const firstFree = offered.find((p) => !listed.includes(p.id))?.id ?? "";
  const [chosen, setChosen] = useState(firstFree);
  const toAdd = listed.includes(chosen) || chosen === "" ? firstFree : chosen;
  const anyWaiting = view.myPrinters.some((p) => p.waiting > 0);

  // The waiting counts are the queue's progress: read them again while any
  // printer has plates waiting. An interval, not a one-shot timer: a reload
  // leaves anyWaiting and reload unchanged, so the effect does not run again
  // to set a new timer, and a failed reload changes nothing at all.
  useEffect(() => {
    if (!anyWaiting) return;
    const timer = setInterval(reload, WAITING_POLL_MS);
    return () => clearInterval(timer);
  }, [anyWaiting, reload]);

  // After a move the list is drawn in its new order; focus the moved button.
  // After a removal, once the row has left, focus the list rather than let
  // it fall to the page body.
  useEffect(() => {
    if (focusAfter !== null && listed.join("\n") === focusAfter.order) {
      buttons.current.get(focusAfter.key)?.focus();
      setFocusAfter(null);
    }
    if (removedId !== null && !listed.includes(removedId)) {
      listRef.current?.focus();
      setRemovedId(null);
    }
  });

  function buttonRef(key: string) {
    return (el: HTMLButtonElement | null) => {
      if (el === null) buttons.current.delete(key);
      else buttons.current.set(key, el);
    };
  }

  /**
   * Saves a new list and default, then waits for the list read after it;
   * resolves what the server did, or throws. When that read fails the
   * controls stay locked (unread) rather than act on the old list.
   */
  async function save(printers: string[], defaultId: string): Promise<SavedPrinters> {
    const saved = await appApi<SavedPrinters>("PUT", "/settings/printers", {
      printers,
      defaultId,
    });
    if (!(await reload())) setUnread(true);
    return saved;
  }

  /** Reads the list again after a failed read; the controls come back once it is in. */
  async function readAgain(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      if (await reload()) setUnread(false);
    } finally {
      setBusy(false);
    }
  }

  /** Runs one change with the controls busy; a failure is said and the list stays. */
  async function run(change: () => Promise<string>): Promise<void> {
    if (locked) return;
    setBusy(true);
    setError(undefined);
    setStatus("");
    try {
      setStatus(await change());
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }

  function add() {
    const printerId = toAdd;
    if (printerId === "") return;
    void run(async () => {
      const name = offered.find((p) => p.id === printerId)?.name ?? printerId;
      const saved = await save([...listed, printerId], view.printerId);
      const mine = saved.added.find((a) => a.printerId === printerId);
      const queued = mine?.queued ?? 0;
      return addedMessage(name, queued, view.slicesPerMinute, mine?.through ?? queued);
    });
  }

  function makeDefault(printer: MyPrinterView) {
    void run(async () => {
      await save(listed, printer.id);
      return `${printer.name} is now the default printer. No slicing was started.`;
    });
  }

  function move(printer: MyPrinterView, direction: Move) {
    const at = listed.indexOf(printer.id);
    const to = direction === "up" ? at - 1 : at + 1;
    if (locked || at < 0 || to < 0 || to >= listed.length) return;
    const next = [...listed];
    next.splice(at, 1);
    next.splice(to, 0, printer.id);
    void run(async () => {
      await save(next, view.printerId);
      setFocusAfter({ key: `${printer.id} ${direction}`, order: next.join("\n") });
      return `Moved ${printer.name} ${direction}. No slicing was started.`;
    });
  }

  function askRemove(printer: MyPrinterView) {
    if (locked) return;
    if (printer.id === view.printerId) {
      setError(undefined);
      setStatus("Make another printer the default before removing this one.");
      return;
    }
    setRemoving(printer);
  }

  async function remove(printer: MyPrinterView): Promise<void> {
    await save(
      listed.filter((p) => p !== printer.id),
      view.printerId,
    );
    setRemovedId(printer.id);
    setRemoving(null);
    setError(undefined);
    setStatus(`Removed ${printer.name}. Its waiting estimates were dropped.`);
  }

  return (
    <div className="ph-field">
      <p className="studio-muted">
        Times and weights are estimated for every printer here. The default is shown first on the
        library and model pages; the printer switch there shows the others.
      </p>
      <ol
        ref={listRef}
        className="studio-list ph-my-printers"
        aria-label="My printers"
        tabIndex={-1}
      >
        {view.myPrinters.map((printer, at) => {
          const isDefault = printer.id === view.printerId;
          return (
            <li key={printer.id} className="studio-list-item" data-my-printer="">
              <div className="ph-printer-line">
                <span className="ph-printer-name">{printer.name}</span>
                {isDefault ? <span className="studio-chip">Default</span> : null}
              </div>
              {printer.waiting > 0 ? (
                <p className="studio-muted">
                  {waitingLine(printer.waiting, printer.through, view.slicesPerMinute)}
                </p>
              ) : null}
              {printer.offered === false ? (
                <p className="studio-alert studio-alert-alert">
                  The slicer no longer offers this printer, so nothing can be estimated for it.
                </p>
              ) : null}
              <div className="studio-actions">
                {isDefault ? null : (
                  <button
                    type="button"
                    className="studio-button"
                    aria-label={`Make ${printer.name} the default`}
                    aria-disabled={locked}
                    onClick={() => makeDefault(printer)}
                  >
                    Make default
                  </button>
                )}
                <button
                  ref={buttonRef(`${printer.id} up`)}
                  type="button"
                  className="studio-button"
                  aria-label={`Move ${printer.name} up`}
                  aria-disabled={locked || at === 0}
                  onClick={() => move(printer, "up")}
                >
                  Up
                </button>
                <button
                  ref={buttonRef(`${printer.id} down`)}
                  type="button"
                  className="studio-button"
                  aria-label={`Move ${printer.name} down`}
                  aria-disabled={locked || at === view.myPrinters.length - 1}
                  onClick={() => move(printer, "down")}
                >
                  Down
                </button>
                <button
                  type="button"
                  className="studio-button"
                  aria-label={`Remove ${printer.name}`}
                  aria-disabled={locked || isDefault}
                  onClick={() => askRemove(printer)}
                >
                  Remove
                </button>
              </div>
            </li>
          );
        })}
      </ol>
      {view.printers === null ? (
        <p className="studio-muted">
          The slicer cannot be reached, so no printer can be added right now.
        </p>
      ) : (
        <>
          <label htmlFor={id}>Add a printer</label>
          <div className="ph-inline-form ph-printer-add">
            <select
              id={id}
              className="ph-select"
              value={toAdd}
              onChange={(event) => {
                if (!locked) setChosen(event.currentTarget.value);
              }}
              aria-disabled={locked}
            >
              {view.printers.map((group) => (
                <optgroup key={group.model} label={group.model}>
                  {group.printers.map((p) => (
                    <option key={p.id} value={p.id} disabled={listed.includes(p.id)}>
                      {p.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <button
              type="button"
              className="studio-button"
              onClick={add}
              aria-disabled={locked || toAdd === ""}
            >
              Add printer
            </button>
          </div>
        </>
      )}
      <p role="status">{status}</p>
      {unread ? (
        <div role="alert" className="studio-alert studio-alert-alert">
          <p>
            The change was saved, but the list could not be read again, so the buttons wait until it
            is.
          </p>
          <button
            type="button"
            className="studio-button"
            aria-disabled={busy}
            onClick={() => void readAgain()}
          >
            Read the list again
          </button>
        </div>
      ) : null}
      {error === undefined ? null : (
        <p role="alert" className="studio-alert studio-alert-alert">
          {error}
        </p>
      )}
      {removing === null ? null : (
        <ConfirmDialog
          title={`Remove ${removing.name}?`}
          message={
            `${removing.name} leaves My printers. ` +
            (removing.waiting > 0
              ? `The ${plural(removing.waiting, "plate", "plates")} still waiting to be estimated for it are dropped.`
              : "Nothing is waiting to be estimated for it.") +
            " Numbers already made for it are kept."
          }
          confirmLabel="Remove"
          onConfirm={() => remove(removing)}
          onCancel={() => setRemoving(null)}
        />
      )}
    </div>
  );
}
