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
//   printer, so both times count the plates queued ahead for other printers,
//   and the OpenSCAD renders and STEP meshes that share the queue (the
//   server's through: jobs up to and including the printer's last slice),
//   not just the printer's own.
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
// - That covers this page only. Each save, add, remove, move or make
//   default alike, also sends the printersVersion the page last read, and
//   the server refuses it with 409 printers_changed, changing nothing, when
//   the list or the default changed since (#272): a page open in another
//   window or on another machine would otherwise undo that change, dropping
//   a printer added there or putting back the old default. The page then
//   reads the list again; once it is in, the page says nothing was saved
//   and that the list now shows the change, to be made again. If that read
//   fails, the page says only that nothing was saved and the list could not
//   be read, and keeps the buttons locked until Read the list again.
// - A listed printer the slicer no longer offers (an OrcaSlicer update
//   renamed its preset) stays listed, and says nothing can be estimated for
//   it. While the slicer cannot be reached the list still shows, and the
//   add menu says why it is missing.
import { useEffect, useId, useRef, useState } from "react";
import { ENGLISH_I18N, type I18n, useI18n } from "../i18n/I18n";
import { printerNameIn } from "../i18n/printers";
import { AppApiError, appApi, useErrorText } from "./api";
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

/** Builds the sentences in a language; English when left out. */
type Words = Pick<I18n, "t" | "fmt" | "locale">;

/** About how long plates take at perMinute, in plain words: "about 2 hours and 35 minutes". */
export function howLong(plates: number, perMinute: number, i18n: Words = ENGLISH_I18N): string {
  const minutes = Math.max(1, Math.ceil(plates / perMinute));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return i18n.t("printers.about.minutes", { minutes: rest });
  if (rest === 0) return i18n.t("printers.about.hours", { hours });
  return i18n.t("printers.about.hoursMinutes", { hours, minutes: rest });
}

/**
 * What the page says once a printer is added. through is how many jobs run
 * up to and including its last plate: the slicer is one queue for every
 * printer and for renders, so plates already queued for other printers, and
 * renders, come first and the time counts them.
 */
export function addedMessage(
  name: string,
  queued: number,
  perMinute: number,
  through = queued,
  i18n: Words = ENGLISH_I18N,
): string {
  const shown = printerNameIn(i18n, name);
  if (queued === 0) return i18n.t("printers.added.none", { name: shown });
  const ahead = through - queued;
  return ahead > 0
    ? i18n.t("printers.added.ahead", {
        name: shown,
        queued,
        perMinute,
        ahead,
        time: howLong(through, perMinute, i18n),
      })
    : i18n.t("printers.added.direct", {
        name: shown,
        queued,
        perMinute,
        time: howLong(queued, perMinute, i18n),
      });
}

/**
 * A printer's waiting line: its plates, and about how long until its last
 * one lands, counting the plates for other printers, and the renders, the
 * one slicer does ahead of them (through).
 */
export function waitingLine(
  waiting: number,
  through: number,
  perMinute: number,
  i18n: Words = ENGLISH_I18N,
): string {
  const time = howLong(Math.max(through, waiting), perMinute, i18n);
  const ahead = through - waiting;
  return ahead > 0
    ? i18n.t("printers.waitingAhead", { waiting, time, ahead })
    : i18n.t("printers.waiting", { waiting, time });
}

/** The sentence a refused save ends with once the page has read the list again. */
export const REREAD_SHOWS_CHANGE = ENGLISH_I18N.t("printers.reread");

/**
 * A refused save whose re-read failed: the page's own locked-list notice says
 * what happened, so run() shows nothing more.
 */
class RefusedUnread extends Error {}

/** The server refused a save: the list or the default changed after the version the page sent. */
function isPrintersChanged(failure: unknown): boolean {
  return (
    failure instanceof AppApiError &&
    failure.status === 409 &&
    (failure.body as { error?: unknown } | null)?.error === "printers_changed"
  );
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
  const i18n = useI18n();
  const { t } = i18n;
  const errorText = useErrorText();
  const id = useId();
  const listRef = useRef<HTMLOListElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const [busy, setBusy] = useState(false);
  /**
   * The list could not be read after a save ("saved") or after a save the
   * server refused because the list changed elsewhere ("refused"): the list
   * on screen may be old. false while it is current.
   */
  const [unread, setUnread] = useState<false | "saved" | "refused">(false);
  /** Every control ignores input: a change is running, or the list on screen may be old. */
  const locked = busy || unread !== false;
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
   * Saves a new list and default, built from the list on screen, then waits
   * for the list read after it; resolves what the server did, or throws.
   * When that read fails the controls stay locked (unread) rather than act
   * on the old list. A save the server refuses because My printers changed
   * elsewhere reads the list again before it throws, so the next change is
   * made from the list as it is.
   */
  async function save(printers: string[], defaultId: string): Promise<SavedPrinters> {
    let saved: SavedPrinters;
    try {
      saved = await appApi<SavedPrinters>("PUT", "/settings/printers", {
        printers,
        defaultId,
        version: view.printersVersion,
      });
    } catch (failure) {
      if (!isPrintersChanged(failure)) throw failure;
      if (!(await reload())) {
        setUnread("refused");
        throw new RefusedUnread();
      }
      // The list on screen is the stored one again: say so after the server's sentence.
      const said = failure instanceof AppApiError ? errorText(failure) : "";
      throw new AppApiError(409, `${said} ${i18n.t("printers.reread")}`.trim(), null);
    }
    if (!(await reload())) setUnread("saved");
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
      if (!(failure instanceof RefusedUnread)) setError(errorText(failure));
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
      return addedMessage(name, queued, view.slicesPerMinute, mine?.through ?? queued, i18n);
    });
  }

  function makeDefault(printer: MyPrinterView) {
    void run(async () => {
      await save(listed, printer.id);
      return t("printers.madeDefault", { name: printerNameIn(i18n, printer.name) });
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
      return t(direction === "up" ? "printers.movedUp" : "printers.movedDown", {
        name: printerNameIn(i18n, printer.name),
      });
    });
  }

  function askRemove(printer: MyPrinterView) {
    if (locked) return;
    if (printer.id === view.printerId) {
      setError(undefined);
      setStatus(t("printers.defaultFirst"));
      return;
    }
    setRemoving(printer);
  }

  async function remove(printer: MyPrinterView): Promise<void> {
    try {
      await save(
        listed.filter((p) => p !== printer.id),
        view.printerId,
      );
    } catch (failure) {
      // Refused, and the list could not be read again: the locked-list
      // notice says so; the dialog closes rather than say something else.
      if (failure instanceof RefusedUnread) {
        setRemoving(null);
        return;
      }
      throw failure;
    }
    setRemovedId(printer.id);
    setRemoving(null);
    setError(undefined);
    setStatus(t("printers.removed", { name: printerNameIn(i18n, printer.name) }));
  }

  return (
    <div className="ph-field">
      <p className="studio-muted">{t("printers.intro")}</p>
      <ol
        ref={listRef}
        className="studio-list ph-my-printers"
        aria-label={t("settings.myPrinters")}
        tabIndex={-1}
      >
        {view.myPrinters.map((printer, at) => {
          const isDefault = printer.id === view.printerId;
          return (
            <li key={printer.id} className="studio-list-item" data-my-printer="">
              <div className="ph-printer-line">
                <span className="ph-printer-name">{printerNameIn(i18n, printer.name)}</span>
                {isDefault ? <span className="studio-chip">{t("printers.default")}</span> : null}
              </div>
              {printer.waiting > 0 ? (
                <p className="studio-muted">
                  {waitingLine(printer.waiting, printer.through, view.slicesPerMinute, i18n)}
                </p>
              ) : null}
              {printer.offered === false ? (
                <p className="studio-alert studio-alert-alert">{t("printers.notOffered")}</p>
              ) : null}
              <div className="studio-actions">
                {isDefault ? null : (
                  <button
                    type="button"
                    className="studio-button"
                    aria-label={t("printers.makeDefaultLabel", {
                      name: printerNameIn(i18n, printer.name),
                    })}
                    aria-disabled={locked}
                    onClick={() => makeDefault(printer)}
                  >
                    {t("printers.makeDefault")}
                  </button>
                )}
                <button
                  ref={buttonRef(`${printer.id} up`)}
                  type="button"
                  className="studio-button"
                  aria-label={t("printers.upLabel", { name: printerNameIn(i18n, printer.name) })}
                  aria-disabled={locked || at === 0}
                  onClick={() => move(printer, "up")}
                >
                  {t("printers.up")}
                </button>
                <button
                  ref={buttonRef(`${printer.id} down`)}
                  type="button"
                  className="studio-button"
                  aria-label={t("printers.downLabel", { name: printerNameIn(i18n, printer.name) })}
                  aria-disabled={locked || at === view.myPrinters.length - 1}
                  onClick={() => move(printer, "down")}
                >
                  {t("printers.down")}
                </button>
                <button
                  type="button"
                  className="studio-button"
                  aria-label={t("printers.removeLabel", {
                    name: printerNameIn(i18n, printer.name),
                  })}
                  aria-disabled={locked || isDefault}
                  onClick={() => askRemove(printer)}
                >
                  {t("printers.remove")}
                </button>
              </div>
            </li>
          );
        })}
      </ol>
      {view.printers === null ? (
        <p className="studio-muted">{t("printers.unreachable")}</p>
      ) : (
        <>
          <label htmlFor={id}>{t("printers.addLabel")}</label>
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
                      {printerNameIn(i18n, p.name)}
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
              {t("printers.add")}
            </button>
          </div>
        </>
      )}
      <p role="status">{status}</p>
      {unread === false ? null : (
        <div role="alert" className="studio-alert studio-alert-alert">
          <p>{unread === "saved" ? t("printers.unread.saved") : t("printers.unread.refused")}</p>
          <button
            type="button"
            className="studio-button"
            aria-disabled={busy}
            onClick={() => void readAgain()}
          >
            {t("printers.readAgain")}
          </button>
        </div>
      )}
      {error === undefined ? null : (
        <p role="alert" className="studio-alert studio-alert-alert">
          {error}
        </p>
      )}
      {removing === null ? null : (
        <ConfirmDialog
          title={t("printers.removeTitle", { name: printerNameIn(i18n, removing.name) })}
          message={t("printers.removeMessage", {
            name: printerNameIn(i18n, removing.name),
            waiting: removing.waiting,
          })}
          confirmLabel={t("printers.remove")}
          onConfirm={() => remove(removing)}
          onCancel={() => setRemoving(null)}
        />
      )}
    </div>
  );
}
