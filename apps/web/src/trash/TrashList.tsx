// The trash (build plan Task 21; AC-063 UI, decided Q11), on its own page
// and on the settings page. Each trashed model shows the day after which
// the daily purge deletes it for good (30 days after it was trashed) and a
// Restore button, which brings it back with its files, tags and
// collections. Empty trash deletes everything in the trash at once, after a
// themed confirmation, never the browser's own dialog. A model whose purge has
// begun cannot be restored, and says so. After any Empty trash, done or not,
// the list is read again, so a model deleted for good never stays on screen.
// When only some models could be deleted, the dialog says how many were and
// gives the server's sentence for the rest. After an Empty trash that worked,
// focus goes to the sentence saying what was deleted rather than back to the
// button, which has nothing left to do. No button here takes the disabled
// attribute, which would push a focused button's focus to the page body:
// Empty trash with nothing in the trash, a Restore that is running and the
// Restore of a model whose purge has begun are marked aria-disabled and
// ignore a press. When a restored model leaves the list, focus goes to the
// next model's Restore, else the previous one's, else the status line
// (useRowFocus in ../settings/focus).
import { useRef, useState } from "react";
import { AppApiError, appApi, errorText, formatDate, segment, useAppApi } from "../settings/api";
import { ConfirmDialog } from "../settings/Dialog";
import { useRowFocus } from "../settings/focus";

export interface TrashedModel {
  id: string;
  name: string;
  creator: string | null;
  trashedAt: string;
  purgeAt: string;
  purgeStarted: boolean;
}

function deletedSentence(purged: number): string {
  return `Deleted ${purged} ${purged === 1 ? "model" : "models"} for good.`;
}

/**
 * The sentence for an Empty trash that deleted some models but not all: the
 * server answers 500 with error "incomplete", the count it purged and a
 * sentence for the page (apps/server/src/app-api/organise.ts). Any other
 * failure is left as it is.
 */
function incompleteFailure(failure: unknown): unknown {
  if (!(failure instanceof AppApiError)) return failure;
  const body = failure.body as { error?: unknown; purged?: unknown; message?: unknown } | null;
  if (body?.error !== "incomplete" || typeof body.message !== "string") return failure;
  const done = typeof body.purged === "number" && body.purged > 0;
  const sentence = done
    ? `${deletedSentence(body.purged as number)} ${body.message}`
    : body.message;
  return new AppApiError(failure.status, sentence, failure.body);
}

export function TrashList() {
  const trash = useAppApi<{ models: TrashedModel[] }>("/trash");
  const [asking, setAsking] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const emptyButton = useRef<HTMLButtonElement>(null);
  const statusLine = useRef<HTMLParagraphElement>(null);
  /** Where focus goes when the dialog closes: the button, or the result after a success. */
  const emptyReturn = useRef<HTMLElement | null>(null);
  /** The models whose Restore is running. */
  const [restoring, setRestoring] = useState<ReadonlySet<string>>(new Set());
  const models = trash.data?.models ?? [];
  const focus = useRowFocus(
    models.map((m) => m.id),
    statusLine,
  );

  function marking(id: string, on: boolean) {
    setRestoring((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function restore(model: TrashedModel) {
    if (model.purgeStarted || restoring.has(model.id)) return;
    marking(model.id, true);
    setError(undefined);
    setStatus("");
    try {
      await appApi("POST", `/trash/${segment(model.id)}/restore`);
      trash.set((prev) => ({ models: prev.models.filter((m) => m.id !== model.id) }));
      setStatus("Restored. The model is back in the library with its files, tags and collections.");
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      marking(model.id, false);
    }
  }

  async function emptyTrash() {
    setStatus("");
    try {
      const answer = await appApi<{ purged: number }>("POST", "/trash/empty");
      trash.set({ models: [] });
      // The result goes where focus goes; Empty trash has nothing left to do.
      emptyReturn.current = statusLine.current;
      setAsking(false);
      setStatus(deletedSentence(answer.purged));
    } catch (failure) {
      // The dialog shows this; the list below is read again either way.
      throw incompleteFailure(failure);
    } finally {
      trash.reload();
    }
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
          aria-disabled={models.length === 0}
          onClick={() => {
            if (models.length === 0) return;
            emptyReturn.current = emptyButton.current;
            setAsking(true);
          }}
        >
          Empty trash
        </button>
      </div>
      <p ref={statusLine} role="status" tabIndex={-1}>
        {status}
      </p>
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
            <li key={model.id} className="studio-list-item" onFocus={focus.focusIn(model.id)}>
              <div className="studio-row">
                <strong>{model.name}</strong>
                <button
                  ref={focus.control(model.id)}
                  type="button"
                  className="studio-button ph-small"
                  aria-label={`Restore ${model.name}`}
                  aria-disabled={model.purgeStarted || restoring.has(model.id)}
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
          returnFocusTo={emptyReturn}
        />
      ) : null}
    </div>
  );
}
