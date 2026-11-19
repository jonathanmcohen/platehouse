// The Plates tab (build plan Task 20, AC-030): every plate of every .3mf of
// the model, file by file, each file's plates in plate order, with the
// plate's thumbnail, its name or "Plate N", and its numbers (Numbers.tsx).
// Each file has its Open in Bambu Studio and Open in OrcaSlicer buttons
// (AC-040). A .3mf whose plates could not be read says why in plain words.
// At the top, the printer the numbers are for, in full; with more than one
// of My printers it is a menu that shows another printer's numbers
// (PrinterSwitch), which reads only and starts no slicing.
// The headings never skip a level under the page's h1 (#206): with one .3mf
// there is no file heading and the plate names are h2; with several, each
// file's name is an h2 and its plate names h3.
import { PrinterSwitch } from "../settings/PrinterSwitch";
import { ENGLISH_I18N, type I18n, useI18n } from "../i18n/I18n";
import type { ModelFile, ModelView } from "./ModelPage";
import { PlateNumbersView } from "./Numbers";
import { OpenInSlicer, type Platform } from "./OpenInSlicer";
import { plateLabel } from "./PlateStrip";

/** What a .3mf without plates says, by parse status. */
export function parseStatusWords(
  file: Pick<ModelFile, "parseStatus">,
  i18n: Pick<I18n, "t"> = ENGLISH_I18N,
): string | null {
  switch (file.parseStatus) {
    case "no_plate_data":
      return i18n.t("model.plates.noData");
    case "unavailable":
      return i18n.t("model.plates.unavailable");
    case "pending":
      return i18n.t("model.plates.reading");
    default:
      return null;
  }
}

export interface PlatesTabProps {
  model: ModelView;
  onRetry(estimateId: string): Promise<boolean>;
  /** The printer switch: shows another of My printers' numbers. */
  onChoosePrinter(printerId: string): void;
  /** The switch's stored choice, which may still be loading; null for the default. */
  chosenPrinter?: string | null | undefined;
  navigateTo?: ((url: string) => void) | undefined;
  platform?: Platform | undefined;
}

/**
 * The printer the switch shows: a choice still loading (one of the model's
 * printers, other than the one its numbers are for), else the model's
 * printer. The select is controlled, so drawing it from model.printer alone
 * would put it back to the old printer until the new answer lands, and
 * arrow keys could not step past the next printer (#255). A choice the
 * server answered with another printer (removed from My printers) is
 * forgotten by the page, so it is not shown here for long.
 */
export function switchPrinter(
  model: Pick<ModelView, "printer" | "printerName" | "printers">,
  chosen: string | null | undefined,
): { printer: string; printerName: string } {
  const pending = model.printers.find((p) => p.id === chosen && p.id !== model.printer);
  return pending === undefined
    ? { printer: model.printer, printerName: model.printerName }
    : { printer: pending.id, printerName: pending.name };
}

export function PlatesTab({
  model,
  onRetry,
  onChoosePrinter,
  chosenPrinter,
  navigateTo,
  platform,
}: PlatesTabProps) {
  const i18n = useI18n();
  const files = model.files.filter((f) => f.kind === "3mf");
  const PlateHeading = files.length > 1 ? "h3" : "h2";
  const shown = switchPrinter(model, chosenPrinter);
  return (
    <>
      <PrinterSwitch
        printer={shown.printer}
        printerName={shown.printerName}
        printers={model.printers}
        onChoose={onChoosePrinter}
      />
      {files.map((file) => {
        const words = parseStatusWords(file, i18n);
        const plates = [...file.plates].sort((a, b) => a.index - b.index);
        return (
          <section key={file.id} className="ph-file-plates" aria-label={file.name}>
            {files.length > 1 ? <h2 className="ph-file-title">{file.name}</h2> : null}
            <OpenInSlicer
              fileId={file.id}
              fileName={file.name}
              navigateTo={navigateTo}
              platform={platform}
            />
            {words === null ? null : <p className="studio-muted">{words}</p>}
            {plates.length === 0 ? null : (
              <ol className="studio-list">
                {plates.map((plate) => (
                  <li key={plate.id} className="studio-list-item" data-plate="">
                    <div className="ph-plate-head">
                      {plate.thumbnail === null ? null : (
                        <img src={plate.thumbnail} alt="" loading="lazy" />
                      )}
                      <PlateHeading className="ph-plate-title">{plateLabel(plate, i18n)}</PlateHeading>
                    </div>
                    <PlateNumbersView
                      numbers={plate.numbers}
                      printer={model.printer}
                      printerName={model.printerName}
                      projectFilaments={file.filaments}
                      pending={plate.estimatePending}
                      onRetry={onRetry}
                    />
                  </li>
                ))}
              </ol>
            )}
          </section>
        );
      })}
    </>
  );
}
