// One plate's numbers on the model page (build plan Task 20; AC-030, and
// the display halves of AC-032 to AC-034), from Task 12's plateNumbers:
//
// - Bambu's own numbers from the file, labelled "Bambu, in the file", with
//   the printer the file was sliced for and its process. This block never
//   says "estimate".
// - A Platehouse estimate, labelled "Platehouse estimate" once, as plain
//   text like the file's "Bambu, in the file" (it once also carried an
//   "Estimate" badge, so it read "Platehouse estimate Estimate", and a
//   screen reader said both), with the slicer and its version, the printer
//   in full, the process and each filament's preset (Bambu's own, Orca's
//   Generic, or the file's own).
//   While it runs it says Estimating; an older one shown meanwhile is marked
//   as made for the previous printer (or Orca version) (AC-031), and says a
//   new one is on its way only when the server says one is queued or
//   slicing (pending).
// - A plate that could not be sliced: the reason in plain words, Orca's own
//   message behind a Details button, and Retry, which queues the slice again
//   from the stored file (no re-upload). A refused or failed retry is said
//   beside the plate: a 409 not_retryable says it can no longer be retried,
//   in a status line that outlives the failure (the page loads the model
//   again, which usually no longer has it), but not the facts it was about:
//   it goes when another printer is shown, when a different failure is
//   shown, or when the refused estimate fails again (it was estimated again
//   and failed again, so Retry works again): its failure comes back after
//   it had gone, or is shown with a later failedAt than the one refused,
//   as when the reload after the 409 already shows the new failure.
//   A 401 says the user is signed out; anything else says what the
//   server's answer means (errorText).
// Times and weights are formatted as the library's cards format them.
import { useId, useState } from "react";
import { type I18n, type MessageKey, useI18n } from "../i18n/I18n";
import { printerNameIn } from "../i18n/printers";
import { ESTIMATE_REASON_KEYS, serverText } from "../i18n/serverText";
import { AppApiError, useErrorText } from "../settings/api";
import type {
  FilamentNumbers,
  Numbers,
  PlatehouseNumbers,
  PlateNumbers,
  ProjectFilament,
} from "./ModelPage";

/** A colour the parser accepted: #RRGGBB or #RRGGBBAA. Anything else gets no swatch colour. */
const COLOUR = /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/;

export function Swatch({ color }: { color: string | null }) {
  const ok = color !== null && COLOUR.test(color);
  return (
    <span
      className="studio-swatch"
      aria-hidden="true"
      {...(ok ? { style: { backgroundColor: color }, title: color } : {})}
    />
  );
}

const SOURCE_WORDS: Record<NonNullable<FilamentNumbers["profileSource"]>, MessageKey> = {
  bambu: "model.numbers.source.bambu",
  generic: "model.numbers.source.generic",
  file: "model.numbers.source.file",
};

/**
 * A failure's words in the shown language: the server's own words on an
 * English page, never en.json's copy of them; on another, by its reason,
 * else the server's words.
 */
function failureWords(
  i18n: Pick<I18n, "t" | "locale">,
  failure: { reason: string; words: string },
): string {
  return serverText(i18n, failure.words, ESTIMATE_REASON_KEYS[failure.reason]);
}

function FilamentList({ filaments }: { filaments: Array<FilamentNumbers | ProjectFilament> }) {
  const { t, fmt } = useI18n();
  if (filaments.length === 0) return null;
  return (
    <ul className="ph-filaments">
      {filaments.map((f) => {
        const grams = "grams" in f ? f.grams : null;
        const profile = "profile" in f ? f.profile : null;
        const source = "profileSource" in f ? f.profileSource : null;
        return (
          <li key={f.slot}>
            <Swatch color={f.color} /> {f.type}
            {grams === null ? null : <> {fmt.weight(grams)}</>}
            {profile === null ? null : (
              <span className="studio-muted">
                {" "}
                {source === null
                  ? t("model.numbers.profile", { profile })
                  : t("model.numbers.profileSource", { profile, source: t(SOURCE_WORDS[source]) })}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function slicerText(n: Numbers): string | null {
  if (n.slicer === null) return null;
  return n.slicerVersion === null ? n.slicer : `${n.slicer} ${n.slicerVersion}`;
}

/** Time, weight, and the facts the numbers came from. */
function Facts({ numbers, printerWord }: { numbers: Numbers; printerWord: string }) {
  const i18n = useI18n();
  const { t, fmt } = i18n;
  const slicer = slicerText(numbers);
  return (
    <>
      {numbers.timeSeconds === null || numbers.weightGrams === null ? null : (
        <p className="ph-numbers-main">
          {t("model.numbers.main", {
            time: fmt.duration(numbers.timeSeconds),
            weight: fmt.weight(numbers.weightGrams),
          })}
        </p>
      )}
      <dl className="studio-dl ph-numbers-facts">
        <dt>{printerWord}</dt>
        <dd>{printerNameIn(i18n, numbers.printerName)}</dd>
        {slicer === null ? null : (
          <>
            <dt>{t("model.numbers.slicer")}</dt>
            <dd>{slicer}</dd>
          </>
        )}
        {numbers.processProfile === null ? null : (
          <>
            <dt>{t("model.numbers.process")}</dt>
            <dd>{numbers.processProfile}</dd>
          </>
        )}
      </dl>
      <FilamentList filaments={numbers.filaments} />
    </>
  );
}

function FileNumbers({ numbers }: { numbers: Numbers }) {
  const { t } = useI18n();
  return (
    <div className="ph-numbers">
      <p className="ph-numbers-source">{t("model.numbers.fromFile")}</p>
      <Facts numbers={numbers} printerWord={t("model.numbers.slicedFor")} />
    </div>
  );
}

function EstimateNumbers({
  numbers,
  printer,
  printerName,
  pending,
}: {
  numbers: PlatehouseNumbers;
  printer: string;
  printerName: string;
  /** Whether a new estimate for the shown printer is queued or slicing. */
  pending: boolean;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const shownName = printerNameIn(i18n, printerName);
  return (
    <div className="ph-numbers">
      <p className="ph-numbers-source">{t("model.numbers.estimate")}</p>
      {numbers.state === "estimating" ? (
        <p className="studio-muted">{t("model.numbers.estimating", { printer: shownName })}</p>
      ) : (
        <>
          {numbers.state === "stale" ? (
            <p className="studio-muted">
              {numbers.printerId === printer
                ? t("model.numbers.staleSlicer", {
                    version: numbers.staleFor ?? t("model.numbers.unknownVersion"),
                  })
                : t("model.numbers.stalePrinter", {
                    printer: printerNameIn(i18n, numbers.printerName),
                  })}
              {pending ? ` ${t("model.numbers.onItsWay", { printer: shownName })}` : null}
            </p>
          ) : null}
          <Facts numbers={numbers} printerWord={t("model.numbers.printer")} />
        </>
      )}
    </div>
  );
}

/** A Retry refused as not retryable: what it was for, and whether that failure has gone since. */
interface Refused {
  estimateId: string;
  printer: string;
  /** When the refused failure was recorded (PlateFailure.failedAt). */
  failedAt: string | null;
  /** Whether a shown answer has had no failure since the refusal. */
  gone: boolean;
}

/**
 * Whether a refusal still holds for what is shown now: null once another
 * printer or a different failure is shown, or once the refused estimate
 * has failed again (and can be retried): its failure is back after it had
 * gone, or shown with another failedAt. A retry keeps the estimate's id,
 * so the time is what tells a new failure from the refused one, as
 * notice.at against event.at does on the Activity page.
 * Returns the same object when nothing changed.
 */
function refusedNow(
  refused: Refused,
  printer: string,
  failure: PlateNumbers["failure"],
): Refused | null {
  if (printer !== refused.printer) return null;
  if (failure === undefined) return refused.gone ? refused : { ...refused, gone: true };
  if (failure.estimateId !== refused.estimateId || refused.gone) return null;
  if (failure.failedAt !== refused.failedAt) return null;
  return refused;
}

export interface PlateNumbersViewProps {
  numbers: PlateNumbers;
  /** The printer the page shows numbers for (an Orca preset id). */
  printer: string;
  /** That printer in full, such as "Bambu Lab P1S, 0.4 mm nozzle". */
  printerName: string;
  /** The file's project filament list, shown when the plate has no numbers yet. */
  projectFilaments: ProjectFilament[];
  /** Whether an estimate for the selected printer is queued or slicing (ModelPlate.estimatePending). */
  pending: boolean;
  /**
   * Queues a failed estimate again; rejects with the server's AppApiError
   * when refused (and the page loads the model again on a 409).
   */
  onRetry(estimateId: string): Promise<void>;
}

export function PlateNumbersView({
  numbers,
  printer,
  printerName,
  projectFilaments,
  pending,
  onRetry,
}: PlateNumbersViewProps) {
  const i18n = useI18n();
  const { t } = i18n;
  const detailId = useId();
  const [showDetail, setShowDetail] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const errorText = useErrorText();
  const [retryError, setRetryError] = useState<string | null>(null);
  /**
   * That the plate can no longer be retried: the estimate and printer the
   * 409 was for. It is shown outside the failure block, because the model
   * loaded again after the refusal usually no longer has the failure, and
   * the words must not go with it.
   */
  const [refused, setRefused] = useState<Refused | null>(null);
  const { file, platehouse, failure } = numbers;
  // Polls, reloads and the printer switch keep this view mounted, so the
  // line is checked against what is shown now, as each answer lands.
  const stillRefused = refused === null ? null : refusedNow(refused, printer, failure);
  if (stillRefused !== refused) setRefused(stillRefused);

  async function retry() {
    if (failure === undefined || retrying) return;
    setRetrying(true);
    setRetryError(null);
    setRefused(null);
    try {
      await onRetry(failure.estimateId);
    } catch (refusal) {
      // 409 not_retryable is final: say so rather than "try again". A 401
      // says the user is signed out, and anything else what the server's
      // answer means (errorText).
      if (refusal instanceof AppApiError && refusal.status === 409) {
        setRefused({
          estimateId: failure.estimateId,
          printer,
          failedAt: failure.failedAt,
          gone: false,
        });
      } else setRetryError(errorText(refusal));
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div className="ph-plate-numbers">
      {file === undefined ? null : <FileNumbers numbers={file} />}
      {platehouse === undefined ? null : (
        <EstimateNumbers
          numbers={platehouse}
          printer={printer}
          printerName={printerName}
          pending={pending && failure === undefined}
        />
      )}
      {failure === undefined ? null : (
        <div className="ph-numbers ph-failure">
          <p className="ph-numbers-source">
            {t("model.numbers.estimateFor", { printer: printerNameIn(i18n, printerName) })}
          </p>
          <p>{failureWords(i18n, failure)}</p>
          <div className="studio-actions">
            {failure.detail === null ? null : (
              <button
                type="button"
                className="studio-button"
                aria-expanded={showDetail}
                {...(showDetail ? { "aria-controls": detailId } : {})}
                onClick={() => setShowDetail((v) => !v)}
              >
                {t("model.numbers.details")}
              </button>
            )}
            <button
              type="button"
              className="studio-button"
              aria-disabled={retrying}
              onClick={() => void retry()}
            >
              {t("model.numbers.retry")}
            </button>
          </div>
          {failure.detail === null || !showDetail ? null : (
            <pre id={detailId} className="ph-detail">
              {failure.detail}
            </pre>
          )}
          {retryError === null ? null : (
            <p role="alert" className="ph-error">
              {retryError}
            </p>
          )}
        </div>
      )}
      {/* Always in the page, so a screen reader hears what is put in it. */}
      <div role="status">
        {stillRefused !== null ? (
          <p className="ph-error">{t("model.numbers.notRetryable")}</p>
        ) : null}
      </div>
      {file === undefined && platehouse === undefined && failure === undefined ? (
        <>
          <p className="studio-muted">{t("model.numbers.none")}</p>
          {projectFilaments.length === 0 ? null : (
            <>
              <p className="studio-filaments-label studio-muted">
                {t("model.numbers.projectFilaments")}
              </p>
              <FilamentList filaments={projectFilaments} />
            </>
          )}
        </>
      ) : null}
    </div>
  );
}
