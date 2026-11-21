// Tag and collection chips that can be added and removed (build plan Task
// 21; AC-061, AC-062). Each chip has its own remove button, named for what
// it removes; a themed input with its button adds one, and may offer names
// to pick from while typing (suggestions, a datalist), and tells a form
// around it what is typed but not yet added (onDraft). Adding a name the
// model already has does nothing on the server and shows no second chip.
// While a change runs, every remove button and the add button are marked
// aria-disabled and ignore a press, and so does Enter in the input. As in
// ConfirmDialog and InlineRename, none takes the disabled attribute, because
// a browser moves focus out of a focused button that becomes disabled. A
// remove that works unmounts its chip's button, so focus then goes to the
// next chip's remove button, else the previous chip's, else the add input
// (useRowFocus in ../settings/focus); a remove that fails leaves focus on
// its button. The input stays open while an add runs; when the add answers
// it is cleared only if it still holds the text that was added, so a next
// name typed meanwhile is kept.
import { type FormEvent, useId, useRef, useState } from "react";
import { useErrorText } from "../settings/api";
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
  /** Names to offer while typing (a datalist), such as the library's tags; none when left out. */
  suggestions?: string[];
  /**
   * Told the input's text whenever it changes, including when an add clears
   * it (an add clears only the text it added), so a form around the editor can count text typed but not yet added.
   */
  onDraft?(draft: string): void;
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
  suggestions,
  onDraft,
}: ChipEditorProps) {
  const errorText = useErrorText();
  const id = useId();
  const [draft, setDraftState] = useState("");
  // The input's text right now, which an add that answers later reads.
  const latestDraft = useRef("");
  const setDraft = (next: string) => {
    latestDraft.current = next;
    setDraftState(next);
    onDraft?.(next);
  };
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
      if (latestDraft.current.trim() === value) setDraft("");
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
          {...(suggestions === undefined ? {} : { list: `${id}-suggestions` })}
          onChange={(event) => setDraft(event.currentTarget.value)}
        />
        {suggestions === undefined ? null : (
          <datalist id={`${id}-suggestions`}>
            {suggestions.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        )}
        <button type="submit" className="studio-button ph-small" aria-disabled={busy}>
          {addButton}
        </button>
      </form>
      {error === undefined ? null : (
        <span role="alert" className="studio-alert studio-alert-alert">
          {error}
        </span>
      )}
    </div>
  );
}
