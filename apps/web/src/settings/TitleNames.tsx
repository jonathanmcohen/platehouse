// The Settings page's "Use file titles" (0.1.0): a one-off action that names
// the models nobody has renamed after their file's title, for the models
// imported before titles were used. Pressing it asks the server for a
// preview (GET /app/api/models/title-names), which changes nothing, then
// asks in the app's own dialog with the count, a few examples and what is
// left alone, and why. Only Rename in that dialog sends the POST that
// renames them, and it sends the preview's planId, so the server renames
// only the list shown; if the library changed in between it renames
// nothing and the dialog says so. A model renamed by hand, one made by an
// import, or one with a name that is none of its files' names, is never
// touched; the server decides that (apps/server/src/repos/models.ts
// titleNamePlan).
import { useRef, useState } from "react";
import { appApi, errorText } from "./api";
import { ConfirmDialog } from "./Dialog";
import "./organise.css";

/** What GET /app/api/models/title-names answers. */
export interface TitleNamePlan {
  /** Sent back with Rename, so only this list is applied. */
  planId: string;
  renames: Array<{ id: string; from: string; to: string }>;
  skipped: {
    renamedByUser: number;
    namedFromTitle: number;
    noTitle: number;
    sameName: number;
    nameNotFromFile: number;
    imported: number;
    /** A caption that was not read from a .3mf, such as an API client's free text. */
    captionNotFromFile: number;
  };
}

/** How many renames the dialog shows as examples. */
const EXAMPLES = 5;

const models = (n: number) => (n === 1 ? "1 model" : `${n} models`);

/** "N are left as they are", or "" when none is. */
function leftCount(skipped: TitleNamePlan["skipped"]): string {
  const total = Object.values(skipped).reduce((sum, n) => sum + n, 0);
  if (total === 0) return "";
  return total === 1 ? "1 is left as it is" : `${total} are left as they are`;
}

/** leftCount with the reasons: "N are left as they are: 2 renamed by you, ...", or "". */
function leftAlone(skipped: TitleNamePlan["skipped"]): string {
  const count = leftCount(skipped);
  if (count === "") return "";
  const reasons = [
    [skipped.renamedByUser, "renamed by you"],
    [skipped.nameNotFromFile, "whose name is not a file name"],
    [skipped.noTitle, "with no title"],
    [skipped.namedFromTitle, "already named from a title"],
    [skipped.sameName, "already named as their title"],
    [skipped.imported, "imported from another library"],
    [skipped.captionNotFromFile, "whose caption was not read from a .3mf"],
  ] as const;
  const listed = reasons.filter(([n]) => n > 0).map(([n, why]) => `${n} ${why}`);
  return `${count}: ${listed.join(", ")}.`;
}

/** The dialog's message: how many, a few examples, and what is left alone. */
function previewMessage(plan: TitleNamePlan): string {
  const n = plan.renames.length;
  const head =
    n === 1
      ? "1 model will be renamed from its file's title."
      : `${n} models will be renamed from their file's title.`;
  const shown = plan.renames.slice(0, EXAMPLES).map((r) => `"${r.from}" becomes "${r.to}"`);
  const more = n > EXAMPLES ? `; and ${n - EXAMPLES} more` : "";
  const examples = ` For example: ${shown.join("; ")}${more}.`;
  const rest = leftAlone(plan.skipped);
  return `${head}${examples}${rest === "" ? "" : ` ${rest}`} A model can still be renamed by hand afterwards.`;
}

export function TitleNames() {
  const [plan, setPlan] = useState<TitleNamePlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const start = useRef<HTMLButtonElement>(null);
  const statusLine = useRef<HTMLParagraphElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  async function preview() {
    if (busy) return;
    setBusy(true);
    setStatus("");
    setError(undefined);
    try {
      const answer = await appApi<TitleNamePlan>("GET", "/models/title-names");
      if (answer.renames.length === 0) {
        const rest = leftCount(answer.skipped);
        setStatus(`No model needs a new name.${rest === "" ? "" : ` ${rest}.`}`);
      } else {
        returnTo.current = start.current;
        setPlan(answer);
      }
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    if (plan === null) return;
    // A 409 (the library changed since the preview) throws, and the dialog
    // shows the server's sentence and stays open.
    const answer = await appApi<{ renamed: number }>("POST", "/models/title-names", {
      planId: plan.planId,
    });
    // The result goes where focus goes; the dialog has nothing left to do.
    returnTo.current = statusLine.current;
    setPlan(null);
    setStatus(`Renamed ${models(answer.renamed)}.`);
  }

  return (
    <div className="ph-section">
      <h2>Model names</h2>
      <div className="studio-panel">
        <p className="studio-muted">
          Name the models nobody has renamed after the title in their .3mf file, such as a
          MakerWorld title, instead of the file name. You see how many first, and a model you
          renamed is never changed.
        </p>
        <div className="studio-actions">
          <button
            ref={start}
            type="button"
            className="studio-button"
            aria-disabled={busy}
            onClick={preview}
          >
            Use file titles
          </button>
        </div>
        <p ref={statusLine} role="status" tabIndex={-1}>
          {status}
        </p>
        {error === undefined ? null : (
          <p role="alert" className="studio-alert studio-alert-alert">
            {error}
          </p>
        )}
      </div>
      {plan === null ? null : (
        <ConfirmDialog
          title="Use file titles?"
          message={previewMessage(plan)}
          confirmLabel={`Rename ${models(plan.renames.length)}`}
          onConfirm={run}
          onCancel={() => setPlan(null)}
          returnFocusTo={returnTo}
        />
      )}
    </div>
  );
}
