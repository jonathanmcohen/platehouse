// Inline rename with a themed input (build plan Task 21; AC-060). A name
// with a Rename button beside it; Rename swaps in a text input with Save and
// Cancel. Enter or Save saves, Escape or Cancel leaves without saving, and
// either way focus goes back to the Rename button. A rename changes only the
// displayed name; the server keeps the file's bucket key.
import { type FormEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { errorText } from "../settings/api";
import "../settings/organise.css";

export interface InlineRenameProps {
  value: string;
  /** The Rename button's accessible name, such as "Rename Cable clip". */
  buttonLabel: string;
  /** The input's label, such as "New name for Cable clip". */
  inputLabel: string;
  /** Saves the new name (trimmed, not empty, changed); rejects with what went wrong. */
  onSave(name: string): Promise<void>;
  /** The longest name the server takes. */
  maxLength?: number;
}

export function InlineRename({
  value,
  buttonLabel,
  inputLabel,
  onSave,
  maxLength = 500,
}: InlineRenameProps) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const button = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const refocus = useRef(false);

  useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    } else if (refocus.current) {
      refocus.current = false;
      button.current?.focus();
    }
  }, [editing]);

  function leave() {
    refocus.current = true;
    setEditing(false);
    setError(undefined);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = draft.trim();
    if (name === "") {
      setError("A name cannot be empty.");
      return;
    }
    if (name === value) {
      leave();
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await onSave(name);
      leave();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      leave();
    }
  }

  if (!editing) {
    return (
      <span className="ph-name">
        <span>{value}</span>
        <button
          ref={button}
          type="button"
          className="studio-button ph-small"
          aria-label={buttonLabel}
          onClick={() => {
            setDraft(value);
            setEditing(true);
          }}
        >
          Rename
        </button>
      </span>
    );
  }

  return (
    <form className="ph-inline-form" onSubmit={save}>
      <label htmlFor={id} className="studio-visually-hidden">
        {inputLabel}
      </label>
      <input
        ref={input}
        id={id}
        className="studio-input"
        value={draft}
        maxLength={maxLength}
        autoComplete="off"
        onChange={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
      <button type="submit" className="studio-button ph-small" disabled={busy}>
        Save
      </button>
      <button type="button" className="studio-button ph-small" onClick={leave}>
        Cancel
      </button>
      {error === undefined ? null : (
        <span className="studio-alert studio-alert-alert">{error}</span>
      )}
    </form>
  );
}
