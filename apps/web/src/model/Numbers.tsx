// One plate's numbers on the model page (build plan Task 20; AC-030, and
// the display halves of AC-032 to AC-034), from Task 12's plateNumbers:
//
// - Bambu's own numbers from the file, labelled "Bambu, in the file", with
//   the printer the file was sliced for and its process. This block never
//   says "estimate".
// - A Platehouse estimate, labelled "Platehouse estimate" and marked as an
//   estimate, with the slicer and its version, the printer, the process and
//   each filament's preset (Bambu's own, Orca's Generic, or the file's own).
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
import { formatDuration, formatWeight } from "../library/ModelCard";
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

const SOURCE_WORDS: Record<NonNullable<FilamentNumbers["profileSource"]>, string> = {
  bambu: "Bambu preset",
  generic: "Generic preset",
  file: "the file's own filament",
};

function FilamentList({ filaments }: { filaments: Array<FilamentNumbers | ProjectFilament> }) {
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
            {grams === null ? null : <> {formatWeight(grams)}</>}
            {profile === null ? null : (
              <span className="studio-muted">
                {" "}
                ({profile}
                {source === null ? "" : `, ${SOURCE_WORDS[source]}`})
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
  const slicer = slicerText(numbers);
  return (
    <>
      {numbers.timeSeconds === null || numbers.weightGrams === null ? null : (
        <p className="ph-numbers-main">
          {formatDuration(numbers.timeSeconds)}, {formatWeight(numbers.weightGrams)}
        </p>
      )}
      <dl className="studio-dl ph-numbers-facts">
        <dt>{printerWord}</dt>
        <dd>{numbers.printerLabel}</dd>
        {slicer === null ? null : (
          <>
            <dt>Slicer</dt>
            <dd>{slicer}</dd>
          </>
        )}
        {numbers.processProfile === null ? null : (
          <>
            <dt>Process</dt>
            <dd>{numbers.processProfile}</dd>
          </>
        )}
      </dl>
      <FilamentList filaments={numbers.filaments} />
    </>
  );
}

function FileNumbers({ numbers }: { numbers: Numbers }) {
  return (
    <div className="ph-numbers">
      <p className="ph-numbers-source">Bambu, in the file</p>
      <Facts numbers={numbers} printerWord="Sliced for" />
    </div>
  );
}

function EstimateNumbers({
  numbers,
  printer,
  pending,
}: {
  numbers: PlatehouseNumbers;
  printer: string;
  /** Whether a new estimate for the selected printer is queued or slicing. */
  pending: boolean;
}) {
  return (
    <div className="ph-numbers">
      <p className="ph-numbers-source">
        Platehouse estimate <span className="studio-chip ph-estimate-mark">Estimate</span>
      </p>
      {numbers.state === "estimating" ? (
        <p className="studio-muted">
          Estimating for {printer}. The numbers show here when the slice finishes.
        </p>
      ) : (
        <>
          {numbers.state === "stale" ? (
            <p className="studio-muted">
              {numbers.printerId === printer
                ? `Made with the previous slicer version, ${numbers.staleFor ?? "unknown"}.`
                : `Made for the previous printer, ${numbers.printerLabel}.`}
              {pending ? ` A new estimate for ${printer} is on its way.` : null}
            </p>
          ) : null}
          <Facts numbers={numbers} printerWord="Printer" />
        </>
      )}
    </div>
  );
}

export interface PlateNumbersViewProps {
  numbers: PlateNumbers;
  /** The selected printer. */
  printer: string;
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
  projectFilaments,
  pending,
  onRetry,
}: PlateNumbersViewProps) {
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
        setRetryError("This plate could not be retried right now. Try again later.");
      }
    } catch {
      setRetryError("This plate could not be retried right now. Try again later.");
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
          pending={pending && failure === undefined}
        />
      )}
      {failure === undefined ? null : (
        <div className="ph-numbers ph-failure">
          <p className="ph-numbers-source">Platehouse estimate for {printer}</p>
          <p>{failure.words}</p>
          <div className="studio-actions">
            {failure.detail === null ? null : (
              <button
                type="button"
                className="studio-button"
                aria-expanded={showDetail}
                {...(showDetail ? { "aria-controls": detailId } : {})}
                onClick={() => setShowDetail((v) => !v)}
              >
                Details
              </button>
            )}
            <button
              type="button"
              className="studio-button"
              aria-disabled={retrying}
              onClick={() => void retry()}
            >
              Retry
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
          <p className="studio-muted">No numbers for this plate yet.</p>
          {projectFilaments.length === 0 ? null : (
            <>
              <p className="studio-filaments-label studio-muted">Project filaments</p>
              <FilamentList filaments={projectFilaments} />
            </>
          )}
        </>
      ) : null}
    </div>
  );
}
