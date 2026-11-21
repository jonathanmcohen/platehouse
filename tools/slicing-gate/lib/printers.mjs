// Bambu printer identity for the slicing gate.
//
// MODEL_IDS is copied from the model_id field of each machine_model file in
// OrcaSlicer v2.5.0 resources/profiles/BBL/machine/ (read 2026-11-07). Inside
// the gate image, flatten-profiles.mjs re-derives the same table from the
// extracted profiles and the report prints that one, so a drift between this
// copy and the image shows up in the report rather than silently.
export const MODEL_IDS = Object.freeze({
  "BL-P001": "Bambu Lab X1 Carbon",
  "BL-P002": "Bambu Lab X1",
  C11: "Bambu Lab P1P",
  C12: "Bambu Lab P1S",
  C13: "Bambu Lab X1E",
  N1: "Bambu Lab A1 mini",
  N2S: "Bambu Lab A1",
  N6: "Bambu Lab X2D",
  N7: "Bambu Lab P2S",
  N9: "Bambu Lab A2L",
  O1C2: "Bambu Lab H2C",
  O1D: "Bambu Lab H2D",
  O1E: "Bambu Lab H2D Pro",
  O1S: "Bambu Lab H2S",
});

// The printers Task 1 names, by the short label used in roles and reports.
export const SHORT = Object.freeze({
  P1S: "Bambu Lab P1S",
  X1C: "Bambu Lab X1 Carbon",
  A1: "Bambu Lab A1",
  "A1 mini": "Bambu Lab A1 mini",
  P1P: "Bambu Lab P1P",
  P2S: "Bambu Lab P2S",
  X2D: "Bambu Lab X2D",
});

// The three selected printers of Task 1, as Orca machine preset names.
export const SELECTED_PRINTERS = Object.freeze([
  "Bambu Lab P1S 0.4 nozzle",
  "Bambu Lab X1 Carbon 0.4 nozzle",
  "Bambu Lab A1 0.4 nozzle",
]);

function normaliseNozzle(text) {
  if (text === null || text === undefined) return null;
  const firstValue = String(text).split(/[;,]/)[0].trim();
  const n = Number(firstValue);
  return Number.isFinite(n) && n > 0 ? String(n) : null;
}

export function orcaPrinterName(model, nozzle) {
  return `${model} ${normaliseNozzle(nozzle)} nozzle`;
}

/**
 * The printer a sliced file was sliced for, or null when no plate carries
 * Bambu's numbers. Prefers slice_info's printer_model_id, then
 * project_settings' printer_model. Dual-nozzle values ("0.4;0.4") take the
 * first nozzle.
 */
export function printerOf(meta) {
  if (!meta || !meta.plates.some((p) => p.sliced)) return null;
  const id = meta.slicedFor?.printerModelId ?? null;
  const nozzle = normaliseNozzle(meta.slicedFor?.nozzle) ?? normaliseNozzle(meta.project?.nozzleDiameter) ?? "0.4";
  if (id !== null && MODEL_IDS[id]) {
    const model = MODEL_IDS[id];
    return { model, nozzle, orcaName: orcaPrinterName(model, nozzle), source: `slice_info printer_model_id ${id}` };
  }
  const model = meta.project?.printerModel ?? null;
  if (model) {
    return {
      model,
      nozzle,
      orcaName: orcaPrinterName(model, nozzle),
      source: `project_settings printer_model${id === null ? "" : ` (slice_info printer_model_id ${id} not in the table)`}`,
    };
  }
  return null;
}
