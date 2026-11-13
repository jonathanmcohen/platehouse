// One card in the library grid (build plan Task 19, AC-073, AC-050): plate
// 1's thumbnail, the name, the creator, the plate count, and the total time
// and weight for the selected printer when every plate has numbers for it,
// "partial" when some plate does not. An STL, STEP or SCAD model (no plate
// thumbnail) shows a generic file-type icon instead. The card links to the
// model page (Task 20).
//
// The image is the only thing a card loads, and only from the /blobs/<id>
// thumbnail the library's API named (AC-073). It is decorative (the link's
// text is the name), so its alt is empty.
import { Link } from "react-router";

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
}

/** A print time as the card shows it: 50m, 1h 25m. Never less than 1m. */
export function formatDuration(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

/** A weight as the card shows it: 31 g, 41.4 g, 1.25 kg. */
export function formatWeight(grams: number): string {
  if (grams >= 1000) return `${Number((grams / 1000).toFixed(2))} kg`;
  return `${Number(grams.toFixed(1))} g`;
}

const KIND_LABEL: Record<NonNullable<LibraryCard["fileKind"]>, string> = {
  "3mf": "3MF",
  stl: "STL",
  step: "STEP",
  scad: "SCAD",
};

/** A generic file outline with the file type under it. */
function FileTypeIcon({ kind }: { kind: LibraryCard["fileKind"] }) {
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
        {kind === null ? "No files" : `${KIND_LABEL[kind]} file`}
      </span>
    </span>
  );
}

export function ModelCard({ card }: { card: LibraryCard }) {
  const known = card.timeSeconds !== null && card.weightGrams !== null;
  return (
    <li>
      <Link to={`/models/${card.id}`} className="studio-card">
        <span className="studio-card-media">
          {card.thumbnail === null ? (
            <FileTypeIcon kind={card.fileKind} />
          ) : (
            <img src={card.thumbnail} alt="" loading="lazy" decoding="async" />
          )}
        </span>
        <span className="studio-card-body">
          <span className="studio-card-title">{card.name}</span>
          <span className="studio-card-meta">{card.creator ?? "Unknown creator"}</span>
          {card.plateCount > 0 ? (
            <span className="studio-card-plates">
              {card.plateCount === 1 ? "1 plate" : `${card.plateCount} plates`}
            </span>
          ) : null}
          {known ? (
            <span className="studio-card-meta">
              {formatDuration(card.timeSeconds as number)} -{" "}
              {formatWeight(card.weightGrams as number)}
            </span>
          ) : card.partial ? (
            <span
              className="studio-card-meta"
              title="Some plates have no numbers for this printer yet"
            >
              partial
            </span>
          ) : null}
        </span>
      </Link>
    </li>
  );
}
