// Plain words for why a plate could not be sliced (build plan Task 12).
// Skeleton: the failing tests come first.
import type { Reason } from "@platehouse/slicer-contract";

export const REASON_WORDS: Readonly<Record<Reason, string>> = Object.freeze({
  process_not_compatible: "",
  machine_not_supported: "",
  bed_too_small: "",
  nozzle_mismatch: "",
  filament_temperature: "",
  toolpath_conflict: "",
  timeout: "",
  slicer_error: "",
});

export function isReason(_value: unknown): _value is Reason {
  throw new Error("not implemented");
}

export function reasonWords(_reason: string | null): string {
  throw new Error("not implemented");
}
