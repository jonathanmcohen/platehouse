// One card in the library grid: plate
// 1's thumbnail, the name, the creator, the plate count, and the total time
// and weight for the selected printer when every plate has numbers for it,
// "partial" when some plate does not, and "numbers unavailable" when the
// slicer's printer menu could not be read, so the file's own numbers could
// not be matched to the printer. An STL or STEP model shows its rendered
// preview picture instead (issue #316), and a generic file-type icon until
// it has one or when its render failed; a SCAD model keeps the icon. The
// card links to the model page, except in the library's Select
// mode (the maintainer, 2026-11-19), where the card is the label of a
// checkbox named for the model, shown in its corner, and a selected card is
// ringed in the accent.
//
// The image is the only thing a card loads, and only from the /blobs/<id>
// thumbnail or preview the library's API named, so rendering the library never downloads a model file. It is decorative
// (the link's text is the name), so its alt is empty.
import { Link } from "react-router";
import { ENGLISH_I18N, type Formatters, useI18n } from "../i18n/I18n";

/** A card as GET /app/api/library answers it (apps/server/src/app-api/library.ts). */
export interface LibraryCard {
  id: string;
  name: string;
  creator: string | null;
  tags: string[];
  plateCount: number;
  thumbnail: string | null;
  fileKind: "3mf" | "stl" | "step" | "scad" | null;
  timeSeconds: number | null;
  weightGrams: number | null;
  partial: boolean;
  /** True when the printer menu could not be read, so a plate's numbers could not be matched. */
  numbersUnavailable: boolean;
}

/** A print time as the card shows it: 50m, 1h 25m. Never less than 1m. English when no language is given. */
export function formatDuration(seconds: number, fmt: Formatters = ENGLISH_I18N.fmt): string {
  return fmt.duration(seconds);
}

/** A weight as the card shows it: 31 g, 41.4 g, 1.25 kg. English when no language is given. */
export function formatWeight(grams: number, fmt: Formatters = ENGLISH_I18N.fmt): string {
  return fmt.weight(grams);
}

const KIND_LABEL: Record<NonNullable<LibraryCard["fileKind"]>, string> = {
  "3mf": "3MF",
  stl: "STL",
  step: "STEP",
  scad: "SCAD",
};

/** A generic file outline with the file type under it. */
function FileTypeIcon({ kind }: { kind: LibraryCard["fileKind"] }) {
  const { t } = useI18n();
  return (
    <span className="studio-placeholder">
      <span>
        <svg
          aria-hidden="true"
          width="44"
          height="44"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        >
          <path d="M6 2.75h8l4.25 4.25v14.25H6z" />
          <path d="M14 2.75V7h4.25" />
        </svg>
        <br />
        {kind === null
          ? t("library.card.noFiles")
          : t("library.card.kindFile", { kind: KIND_LABEL[kind] })}
      </span>
    </span>
  );
}

/** A card in Select mode: whether it is selected, and how to toggle it. */
export interface CardSelection {
  selected: boolean;
  onToggle(): void;
}

export function ModelCard({ card, selection }: { card: LibraryCard; selection?: CardSelection }) {
  const { t, fmt } = useI18n();
  const known = card.timeSeconds !== null && card.weightGrams !== null;
  const content = (
    <>
      <span className="studio-card-media">
        {card.thumbnail === null ? (
          <FileTypeIcon kind={card.fileKind} />
        ) : (
          <img src={card.thumbnail} alt="" loading="lazy" decoding="async" />
        )}
      </span>
      <span className="studio-card-body">
        <span className="studio-card-title">{card.name}</span>
        <span className="studio-card-meta">{card.creator ?? t("library.card.unknownCreator")}</span>
        {card.plateCount > 0 ? (
          <span className="studio-card-plates">
            {t("library.card.plates", { count: card.plateCount })}
          </span>
        ) : null}
        {known ? (
          <span className="studio-card-meta">
            {fmt.duration(card.timeSeconds as number)} - {fmt.weight(card.weightGrams as number)}
          </span>
        ) : card.numbersUnavailable ? (
          <span className="studio-card-meta" title={t("library.card.unavailableTitle")}>
            {t("library.card.unavailable")}
          </span>
        ) : card.partial ? (
          <span className="studio-card-meta" title={t("library.card.partialTitle")}>
            {t("library.card.partial")}
          </span>
        ) : null}
      </span>
    </>
  );
  if (selection === undefined) {
    return (
      <li>
        <Link to={`/models/${card.id}`} className="studio-card">
          {content}
        </Link>
      </li>
    );
  }
  // Select mode: the card is the label of a real checkbox named for the
  // model, drawn in its corner, so a click anywhere on the card toggles it
  // and the focus ring is the checkbox's own. Space on the focused checkbox
  // is toggled here, with the browser's own toggle prevented (a keydown
  // whose default is prevented never becomes the checkbox's click), so it
  // toggles exactly once in every browser and the page does not scroll.
  return (
    <li>
      <label className="studio-card ph-card-select" data-selected={selection.selected}>
        <input
          type="checkbox"
          className="ph-card-check"
          aria-label={card.name}
          checked={selection.selected}
          onChange={selection.onToggle}
          onKeyDown={(event) => {
            if (event.key !== " ") return;
            event.preventDefault();
            selection.onToggle();
          }}
        />
        {content}
      </label>
    </li>
  );
}
