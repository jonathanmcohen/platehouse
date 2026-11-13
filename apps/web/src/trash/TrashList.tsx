// The trash (build plan Task 21; AC-063 UI, decided Q11), on its own page
// and on the settings page. Each trashed model shows the day after which
// the daily purge deletes it for good (30 days after it was trashed) and a
// Restore button, which brings it back with its files, tags and
// collections. Empty trash deletes everything in the trash at once, after a
// themed confirmation, never the browser's own dialog. A model whose purge has
// begun cannot be restored, and says so.
import { useRef, useState } from "react";
import { appApi, errorText, formatDate, segment, useAppApi } from "../settings/api";
import { ConfirmDialog } from "../settings/Dialog";

export interface TrashedModel {
  id: string;
  name: string;
  creator: string | null;
  trashedAt: string;
  purgeAt: string;
  purgeStarted: boolean;
}

export function TrashList() {
  const trash = useAppApi<{ models: TrashedModel[] }>("/trash");
  const [asking, setAsking] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const emptyButton = useRef<HTMLButtonElement>(null);
  const models = trash.data?.models ?? [];

  async function restore(model: TrashedModel) {
    setError(undefined);
    setStatus("");
    try {
      await appApi("POST", `/trash/${segment(model.id)}/restore`);
      trash.set({ models: models.filter((m) => m.id !== model.id) });
      setStatus("Restored. The model is back in the library with its files, tags and collections.");
    } catch (failure) {
      setError(errorText(failure));
    }
  }

  async function emptyTrash() {
    setStatus("");
    const answer = await appApi<{ purged: number }>("POST", "/trash/empty");
    trash.set({ models: [] });
    setAsking(false);
    setStatus(`Deleted ${answer.purged} ${answer.purged === 1 ? "model" : "models"} for good.`);
  }

  return (
    <div className="studio-panel">
      <p className="studio-muted">
        A model in the trash is deleted for good 30 days after it was trashed. Restore brings it
        back with its files, tags and collections.
      </p>
      <div className="studio-actions">
        <button
          ref={emptyButton}
          type="button"
          className="studio-button ph-button-danger"
          disabled={models.length === 0}
          onClick={() => setAsking(true)}
        >
          Empty trash
        </button>
      </div>
      <p role="status">{status}</p>
      {error === undefined ? null : <p className="studio-alert studio-alert-alert">{error}</p>}
      {trash.error === undefined ? null : (
        <p className="studio-alert studio-alert-alert">{trash.error}</p>
      )}
      {trash.data === undefined && trash.error === undefined ? (
        <p className="studio-muted">Loading the trash.</p>
      ) : null}
      {trash.data !== undefined && models.length === 0 ? (
        <p className="studio-empty">The trash is empty.</p>
      ) : null}
      {models.length > 0 ? (
        <ul className="studio-list">
          {models.map((model) => (
            <li key={model.id} className="studio-list-item">
              <div className="studio-row">
                <strong>{model.name}</strong>
                <button
                  type="button"
                  className="studio-button ph-small"
                  aria-label={`Restore ${model.name}`}
                  disabled={model.purgeStarted}
                  onClick={() => restore(model)}
                >
                  Restore
                </button>
              </div>
              <span className="studio-muted">
                {model.creator === null ? null : `By ${model.creator}. `}
                {model.purgeStarted ? (
                  "It is being deleted now and cannot be restored."
                ) : (
                  <>
                    {"Deleted for good after "}
                    <time dateTime={model.purgeAt}>{formatDate(model.purgeAt)}</time>.
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {asking ? (
        <ConfirmDialog
          title="Empty the trash?"
          message="Every model in the trash is deleted for good, with its files. This cannot be undone."
          confirmLabel="Empty trash"
          onConfirm={emptyTrash}
          onCancel={() => setAsking(false)}
          returnFocusTo={emptyButton}
        />
      ) : null}
    </div>
  );
}
