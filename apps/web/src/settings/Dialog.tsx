// The app's own themed dialogs (build plan Task 21; Task 18's rule: no
// native browser dialog anywhere). Dialog is a modal panel over the page:
// role="dialog" with aria-modal and its title as its name, focus moved into
// it when it opens and kept there (Tab and Shift+Tab wrap), Escape closes it,
// and on close focus goes back to the control that opened it
// (returnFocusTo), so a keyboard user never lands on the document body.
// ConfirmDialog asks before something that cannot be undone, with the safe
// choice, Cancel, focused first. Once the change is sent it cannot be called
// back, so while it runs Cancel is disabled and Escape does nothing: the
// dialog stays open until the change has answered, and shows any failure.
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { errorText } from "./api";
import "./organise.css";

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

export interface DialogProps {
  title: string;
  onClose(): void;
  /** Where focus goes when the dialog closes; the element focused before it opened otherwise. */
  returnFocusTo?: RefObject<HTMLElement | null>;
  /** The element focused when the dialog opens; the first focusable one otherwise. */
  initialFocus?: RefObject<HTMLElement | null>;
  children: ReactNode;
}

export function Dialog({ title, onClose, returnFocusTo, initialFocus, children }: DialogProps) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  const returnTo = useRef(returnFocusTo);

  useEffect(() => {
    opener.current = document.activeElement;
    const first =
      initialFocus?.current ?? panel.current?.querySelector<HTMLElement>(FOCUSABLE) ?? null;
    (first ?? panel.current)?.focus();
    return () => {
      const target = returnTo.current?.current ?? opener.current;
      if (target instanceof HTMLElement && target.isConnected) target.focus();
    };
  }, [initialFocus]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const items = [...(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    const first = items[0];
    const last = items[items.length - 1];
    if (first === undefined || last === undefined) {
      event.preventDefault();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="ph-dialog-backdrop">
      <div
        ref={panel}
        className="ph-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export interface ConfirmDialogProps {
  title: string;
  message: ReactNode;
  /** The button that goes ahead, such as "Empty trash". */
  confirmLabel: string;
  /** Runs the change; the dialog stays open, showing any failure, until it resolves. */
  onConfirm(): Promise<void>;
  onCancel(): void;
  returnFocusTo?: RefObject<HTMLElement | null>;
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
  returnFocusTo,
}: ConfirmDialogProps) {
  const cancel = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  async function go() {
    setBusy(true);
    setError(undefined);
    try {
      await onConfirm();
    } catch (failure) {
      setError(errorText(failure));
      setBusy(false);
    }
  }

  // A change in flight is not stopped by closing the dialog, so it cannot close
  // until the change has answered.
  function close() {
    if (!busy) onCancel();
  }

  return (
    <Dialog
      title={title}
      onClose={close}
      initialFocus={cancel}
      {...(returnFocusTo === undefined ? {} : { returnFocusTo })}
    >
      <p>{message}</p>
      {error === undefined ? null : <p className="studio-alert studio-alert-alert">{error}</p>}
      <div className="studio-actions">
        <button
          type="button"
          className="studio-button ph-button-danger"
          onClick={go}
          disabled={busy}
        >
          {confirmLabel}
        </button>
        <button
          ref={cancel}
          type="button"
          className="studio-button"
          onClick={close}
          disabled={busy}
        >
          Cancel
        </button>
      </div>
    </Dialog>
  );
}
