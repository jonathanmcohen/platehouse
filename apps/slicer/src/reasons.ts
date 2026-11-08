// Orca return codes -> contract reasons (build plan, Slicer HTTP contract v1,
// Reason map as amended). The codes and messages are OrcaSlicer v2.5.0's own:
// src/libslic3r/Utils.hpp and src/OrcaSlicer.cpp cli_errors, read for the
// slicing gate (tools/slicing-gate/lib/classify.mjs) at commit 40ecc66.
//
// -50, -61, -63 to -65, -67 and -69 (empty plate, bed type, collisions,
// vase mode, TPU count, mixed filament) are not among the legitimate
// refusals AC-034 names. By Jon's decision (2026-11-08) they take the
// contract's "anything else" and are slicer_error, with Orca's message as
// the detail.
import type { Reason } from "@platehouse/slicer-contract";

export const ORCA_MESSAGES: Readonly<Record<number, string>> = Object.freeze({
  0: "success",
  [-1]: "environment error",
  [-2]: "invalid parameters",
  [-3]: "input file not found",
  [-4]: "file list in the wrong order",
  [-5]: "preset file invalid",
  [-6]: "model file cannot be parsed",
  [-7]: "printer technology not FDM",
  [-8]: "unsupported CLI instruction",
  [-14]: "out of memory",
  [-15]: "the selected printer is not supported",
  [-16]: "the selected printer is not compatible with the 3mf",
  [-17]: "the selected printer is not compatible with the process preset in the 3mf",
  [-18]: "invalid values in the 3mf",
  [-19]: "post-processing not supported",
  [-20]: "the selected printer's bed is smaller than the print profile's",
  [-23]: "modified printer parameter in the 3mf",
  [-24]: "unsupported 3MF version",
  [-25]: "failed exporting statistics",
  [-50]: "the plate has nothing to slice",
  [-51]: "incorrect slicing parameters in the 3mf",
  [-52]: "objects partly outside the bed",
  [-58]: "slicing time of a plate exceeds the limit",
  [-59]: "triangle count exceeds the limit",
  [-61]: "filaments not compatible with the plate type",
  [-62]: "filament temperatures too far apart",
  [-63]: "object collision in print-by-object mode",
  [-64]: "object collision",
  [-65]: "parameters not valid for spiral vase mode",
  [-66]: "filaments cannot be mapped to extruders",
  [-67]: "two or more TPU filaments",
  [-68]: "filaments not supported by the mapped extruder",
  [-69]: "mixed filament invalid",
  [-100]: "slicing failed",
  [-101]: "G-code path conflicts",
  [-102]: "G-code in an unprintable area of a multi-extruder printer",
});

// Exactly the contract's map. -15 (printer not supported) and -20 (bed
// smaller than the print profile's) are not in it, so they take "anything
// else" and are slicer_error with Orca's message, like the gate's planReason.
const MAP: ReadonlyMap<number, Reason> = new Map<number, Reason>([
  [-16, "machine_not_supported"],
  [-17, "process_not_compatible"],
  [-52, "bed_too_small"],
  [-102, "bed_too_small"],
  [-66, "nozzle_mismatch"],
  [-68, "nozzle_mismatch"],
  // Jon, 2026-11-08 (gate run 3): legitimate refusals, shown with the reason.
  [-62, "filament_temperature"],
  [-101, "toolpath_conflict"],
  [-58, "timeout"],
]);

/** The contract reason for an Orca return code; anything unmapped is slicer_error. */
export function reasonFor(code: number): Reason {
  return MAP.get(code) ?? "slicer_error";
}

/** Orca's message for a code, or a generic one naming the code. */
export function orcaMessage(code: number): string {
  return ORCA_MESSAGES[code] ?? `Orca return code ${code}`;
}
