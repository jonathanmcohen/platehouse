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
import { appApi, useErrorText } from "./api";
import { type I18n, type MessageKey, useI18n } from "../i18n/I18n";
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

/** Builds the sentences in a language. */
type Words = Pick<I18n, "t">;

const models = (t: Words["t"], n: number) => t("library.count.models", { count: n });

/** "N are left as they are", or "" when none is. */
function leftCount(t: Words["t"], skipped: TitleNamePlan["skipped"]): string {
  const total = Object.values(skipped).reduce((sum, n) => sum + n, 0);
  if (total === 0) return "";
  return t("titles.left", { count: total });
}

/** The words for each reason a model keeps its name, by its field in skipped. */
const REASON_KEYS = [
  ["renamedByUser", "titles.reason.renamedByUser"],
  ["nameNotFromFile", "titles.reason.nameNotFromFile"],
  ["noTitle", "titles.reason.noTitle"],
  ["namedFromTitle", "titles.reason.namedFromTitle"],
  ["sameName", "titles.reason.sameName"],
  ["imported", "titles.reason.imported"],
  ["captionNotFromFile", "titles.reason.captionNotFromFile"],
] as const satisfies ReadonlyArray<readonly [keyof TitleNamePlan["skipped"], MessageKey]>;

/** leftCount with the reasons: "N are left as they are: 2 renamed by you, ...", or "". */
function leftAlone(t: Words["t"], skipped: TitleNamePlan["skipped"]): string {
  const count = leftCount(t, skipped);
  if (count === "") return "";
  const listed = REASON_KEYS.filter(([field]) => skipped[field] > 0).map(([field, key]) =>
    t(key, { count: skipped[field] }),
  );
  return t("titles.leftAlone", { left: count, reasons: listed.join(", ") });
}

/** The dialog's message: how many, a few examples, and what is left alone. */
function previewMessage(t: Words["t"], plan: TitleNamePlan): string {
  const n = plan.renames.length;
  const head = t("titles.head", { count: n });
  const shown = plan.renames
    .slice(0, EXAMPLES)
    .map((r) => t("titles.example", { from: r.from, to: r.to }))
    .join("; ");
  const examples =
    n > EXAMPLES
      ? t("titles.examplesMore", { list: shown, more: n - EXAMPLES })
      : t("titles.examples", { list: shown });
  const rest = leftAlone(t, plan.skipped);
  return `${head} ${examples}${rest === "" ? "" : ` ${rest}`} ${t("titles.byHand")}`;
}

export function TitleNames() {
  const { t } = useI18n();
  const errorText = useErrorText();
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
        const rest = leftCount(t, answer.skipped);
        setStatus(
          rest === "" ? t("titles.noneNeeded") : `${t("titles.noneNeeded")} ${t("titles.leftSentence", { left: rest })}`,
        );
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
    setStatus(t("titles.renamed", { models: models(t, answer.renamed) }));
  }

  return (
    <div className="ph-section">
      <h2>{t("titles.heading")}</h2>
      <div className="studio-panel">
        <p className="studio-muted">
          {t("titles.intro")}
        </p>
        <div className="studio-actions">
          <button
            ref={start}
            type="button"
            className="studio-button"
            aria-disabled={busy}
            onClick={preview}
          >
            {t("titles.button")}
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
          title={t("titles.confirmTitle")}
          message={previewMessage(t, plan)}
          confirmLabel={t("titles.renameCount", { models: models(t, plan.renames.length) })}
          onConfirm={run}
          onCancel={() => setPlan(null)}
          returnFocusTo={returnTo}
        />
      )}
    </div>
  );
}
