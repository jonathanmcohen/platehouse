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
//   beside the plate.
// Times and weights are formatted as the library's cards format them.
import { useId, useState } from "react";
import { type I18n, type MessageKey, useI18n } from "../i18n/I18n";
import { printerNameIn } from "../i18n/printers";
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

/** The words for each reason a plate could not be sliced (the Slicer HTTP contract's reasons). */
const REASON_WORDS: Readonly<Record<string, MessageKey>> = {
  process_not_compatible: "estimate.reason.processNotCompatible",
  machine_not_supported: "estimate.reason.machineNotSupported",
  bed_too_small: "estimate.reason.bedTooSmall",
  nozzle_mismatch: "estimate.reason.nozzleMismatch",
  filament_temperature: "estimate.reason.filamentTemperature",
  toolpath_conflict: "estimate.reason.toolpathConflict",
  timeout: "estimate.reason.timeout",
  slicer_error: "estimate.reason.slicerError",
};

/** A failure's words in the shown language: by its reason, else the server's words. */
function failureWords(t: I18n["t"], failure: { reason: string; words: string }): string {
  const key = REASON_WORDS[failure.reason];
  return key === undefined ? failure.words : t(key);
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
  /** Queues a failed estimate again; resolves true when it was queued. */
  onRetry(estimateId: string): Promise<boolean>;
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
  const [retryError, setRetryError] = useState<string | null>(null);
  const { file, platehouse, failure } = numbers;

  async function retry() {
    if (failure === undefined || retrying) return;
    setRetrying(true);
    setRetryError(null);
    try {
      if (!(await onRetry(failure.estimateId))) {
        setRetryError(t("model.numbers.retryFailed"));
      }
    } catch {
      setRetryError(t("model.numbers.retryFailed"));
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
          <p>{failureWords(t, failure)}</p>
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
