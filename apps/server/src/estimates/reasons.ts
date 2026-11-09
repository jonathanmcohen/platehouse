// Plain words for why a plate could not be sliced (build plan Task 12,
// AC-034). The reason itself comes from the slicer's reason map (Slicer HTTP
// contract v1): Orca's return code mapped to one of the contract's reasons,
// with every code the map does not name reported as slicer_error. The app
// never re-maps a reason; it only puts it in words.
//
// The first six sentences are the plan's, word for word. filament_temperature
// (-62) and toolpath_conflict (-101) were added to the map as legitimate
// refusals after the plan was written (Jon, 2026-11-08, gate run 3); their
// sentences are written here in the same style. The slicer's own detail
// (Orca's error_string) is kept with the estimate and shown behind a Details
// toggle, never in place of these words.
import { REASONS, type Reason } from "@platehouse/slicer-contract";

export const REASON_WORDS: Readonly<Record<Reason, string>> = Object.freeze({
  process_not_compatible: "This file's print settings do not fit the selected printer.",
  machine_not_supported: "This file cannot be switched to the selected printer.",
  bed_too_small: "The plate is too big for this printer's bed.",
  nozzle_mismatch:
    "This plate needs a different nozzle or extruder setup than the selected printer has.",
  filament_temperature:
    "The filaments on this plate need print temperatures too far apart to print together.",
  toolpath_conflict: "The slicer found print paths on this plate that would collide.",
  timeout: "Slicing took too long and was stopped.",
  slicer_error: "The slicer could not slice this plate.",
});

const KNOWN: ReadonlySet<string> = new Set(REASONS);

/** Whether a value is one of the contract's reasons. */
export function isReason(value: unknown): value is Reason {
  return typeof value === "string" && KNOWN.has(value);
}

/** The words for a stored reason; anything the contract does not name reads as slicer_error. */
export function reasonWords(reason: string | null): string {
  return isReason(reason) ? REASON_WORDS[reason] : REASON_WORDS.slicer_error;
}
