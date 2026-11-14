// The Plates tab (build plan Task 20, AC-030): every plate of every .3mf of
// the model, file by file, each file's plates in plate order, with the
// plate's thumbnail, its name or "Plate N", and its numbers (Numbers.tsx).
// Each file has its Open in Bambu Studio and Open in OrcaSlicer buttons
// (AC-040). A .3mf whose plates could not be read says why in plain words.
// The headings never skip a level under the page's h1 (#206): with one .3mf
// there is no file heading and the plate names are h2; with several, each
// file's name is an h2 and its plate names h3.
import type { ModelFile, ModelView } from "./ModelPage";
import { PlateNumbersView } from "./Numbers";
import { OpenInSlicer, type Platform } from "./OpenInSlicer";
import { plateLabel } from "./PlateStrip";

/** What a .3mf without plates says, by parse status. */
export function parseStatusWords(file: Pick<ModelFile, "parseStatus">): string | null {
  switch (file.parseStatus) {
    case "no_plate_data":
      return "No Bambu plate data in this file";
    case "unavailable":
      return "This file's plates could not be read right now.";
    case "pending":
      return "This file's plates are still being read.";
    default:
      return null;
  }
}

export interface PlatesTabProps {
  model: ModelView;
  onRetry(estimateId: string): Promise<boolean>;
  navigateTo?: ((url: string) => void) | undefined;
  platform?: Platform | undefined;
}

export function PlatesTab({ model, onRetry, navigateTo, platform }: PlatesTabProps) {
  const files = model.files.filter((f) => f.kind === "3mf");
  const PlateHeading = files.length > 1 ? "h3" : "h2";
  return (
    <>
      {files.map((file) => {
        const words = parseStatusWords(file);
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
                      <PlateHeading className="ph-plate-title">{plateLabel(plate)}</PlateHeading>
                    </div>
                    <PlateNumbersView
                      numbers={plate.numbers}
                      printer={model.printer}
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
