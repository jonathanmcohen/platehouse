// Tag and collection chips that can be added and removed (build plan Task
// 21; AC-061, AC-062). Each chip has its own remove button, named for what
// it removes; a themed input with its button adds one. Adding a name the
// model already has does nothing on the server and shows no second chip.
import { type FormEvent, useId, useState } from "react";
import { errorText } from "../settings/api";
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

  async function run(change: () => Promise<void>) {
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
            type="button"
            aria-label={removeLabel(value)}
            disabled={busy}
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
          id={id}
          className="studio-input ph-small"
          value={draft}
          maxLength={MAX_LABEL}
          autoComplete="off"
          onChange={(event) => setDraft(event.currentTarget.value)}
        />
        <button type="submit" className="studio-button ph-small" disabled={busy}>
          {addButton}
        </button>
      </form>
      {error === undefined ? null : (
        <span className="studio-alert studio-alert-alert">{error}</span>
      )}
    </div>
  );
}
