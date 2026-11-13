// Tag and collection chips that can be added and removed (build plan Task
// 21; AC-061, AC-062). Each chip has its own remove button, named for what
// it removes; a themed input with its button adds one. Adding a name the
// model already has does nothing on the server and shows no second chip.
// While a change runs, every remove button and the add button are marked
// aria-disabled and ignore a press, and so does Enter in the input. As in
// ConfirmDialog and InlineRename, none takes the disabled attribute, because
// a browser moves focus out of a focused button that becomes disabled. A
// remove that works unmounts its chip's button, so focus then goes to the
// next chip's remove button, else the previous chip's, else the add input
// (useRowFocus in ../settings/focus); a remove that fails leaves focus on
// its button.
import { type FormEvent, useId, useRef, useState } from "react";
import { errorText } from "../settings/api";
import { useRowFocus } from "../settings/focus";
import "../settings/organise.css";

export interface ChipEditorProps {
  /** The chips' names, in order. */
  values: string[];
  /** The add input's label, such as "Add a tag to Hook". */
  addLabel: string;
  /** The add button's text, such as "Add tag". */
  addButton: string;
  /** A chip's remove button's accessible name. */
  removeLabel(value: string): string;
  onAdd(value: string): Promise<void>;
  onRemove(value: string): Promise<void>;
}

/** The longest tag or collection name the server takes. */
const MAX_LABEL = 100;

export function ChipEditor({
  values,
  addLabel,
  addButton,
  removeLabel,
  onAdd,
  onRemove,
}: ChipEditorProps) {
  const id = useId();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const input = useRef<HTMLInputElement>(null);
  const focus = useRowFocus(values, input);

  async function run(change: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await change();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }

  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const value = draft.trim();
    if (value === "") return;
    void run(async () => {
      await onAdd(value);
      setDraft("");
    });
  }

  return (
    <div className="ph-chip-row">
      {values.map((value) => (
        <span key={value} className="studio-chip ph-chip">
          <span>{value}</span>
          <button
            ref={focus.control(value)}
            onFocus={focus.focusIn(value)}
            type="button"
            aria-label={removeLabel(value)}
            aria-disabled={busy}
            onClick={() => run(() => onRemove(value))}
          >
            <span aria-hidden="true">x</span>
          </button>
        </span>
      ))}
      <form className="ph-inline-form" onSubmit={add}>
        <label htmlFor={id} className="studio-visually-hidden">
          {addLabel}
        </label>
        <input
          ref={input}
          id={id}
          className="studio-input ph-small"
          value={draft}
          maxLength={MAX_LABEL}
          autoComplete="off"
          onChange={(event) => setDraft(event.currentTarget.value)}
        />
        <button type="submit" className="studio-button ph-small" aria-disabled={busy}>
          {addButton}
        </button>
      </form>
      {error === undefined ? null : (
        <span className="studio-alert studio-alert-alert">{error}</span>
      )}
    </div>
  );
}
