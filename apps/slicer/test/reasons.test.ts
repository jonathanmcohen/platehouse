// The reason map (build plan, Slicer HTTP contract v1, as amended): Orca
// v2.5.0's own return codes (src/libslic3r/Utils.hpp, messages from
// src/OrcaSlicer.cpp cli_errors), as the slicing gate's lib/classify.mjs
// reads them. -62 and -101 are legitimate refusals reported with their
// reason (Jon, 2026-11-08, gate run 3).
import { describe, expect, test } from "vitest";
import { ORCA_MESSAGES, reasonFor } from "../src/reasons.js";

const MAP: Array<[number, string]> = [
  [-15, "machine_not_supported"],
  [-16, "machine_not_supported"],
  [-17, "process_not_compatible"],
  [-20, "bed_too_small"],
  [-52, "bed_too_small"],
  [-102, "bed_too_small"],
  [-66, "nozzle_mismatch"],
  [-68, "nozzle_mismatch"],
  [-62, "filament_temperature"],
  [-101, "toolpath_conflict"],
  [-58, "timeout"],
];

// Codes the plan's original map sent to nozzle_mismatch (-61 to -69) or did
// not name (-50), whose Orca meaning is something else: empty plate, bed
// type, collisions, vase mode, TPU count, mixed filament. They wait on Jon's
// decision, and until then fall to the contract's "anything else".
const NEEDS_DECISION = [-50, -61, -63, -64, -65, -67, -69];

describe("reason map", () => {
  test.each(MAP)("Orca code %i is %s", (code, reason) => {
    expect(reasonFor(code)).toBe(reason);
  });

  test.each(NEEDS_DECISION)(
    "Orca code %i is not mapped yet and is reported as slicer_error",
    (code) => {
      expect(reasonFor(code)).toBe("slicer_error");
    },
  );

  test.each([-1, -2, -3, -5, -14, -18, -51, -59, -60, -70, -100, -103, 1, 7, 255])(
    "any other code (%i) is slicer_error",
    (code) => {
      expect(reasonFor(code)).toBe("slicer_error");
    },
  );

  test("only -66 and -68 of -61 to -69 are nozzle_mismatch", () => {
    const nozzle = [-61, -62, -63, -64, -65, -66, -67, -68, -69].filter(
      (c) => reasonFor(c) === "nozzle_mismatch",
    );
    expect(nozzle).toEqual([-66, -68]);
  });

  test("every mapped or pending code has Orca's own message for the detail fallback", () => {
    for (const code of [...MAP.map(([c]) => c), ...NEEDS_DECISION]) {
      expect(ORCA_MESSAGES[code], `code ${code}`).toMatch(/\w/);
    }
    expect(ORCA_MESSAGES[-62]).toBe("filament temperatures too far apart");
    expect(ORCA_MESSAGES[-101]).toBe("G-code path conflicts");
  });
});
