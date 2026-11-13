// One card in the library grid (build plan Task 19, AC-073). Not yet
// implemented: this commit carries the interfaces and the failing tests.

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

export function formatDuration(_seconds: number): string {
  return "";
}

export function formatWeight(_grams: number): string {
  return "";
}

export function ModelCard(_props: { card: LibraryCard }) {
  return null;
}
