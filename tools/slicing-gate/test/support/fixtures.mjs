// Test-only builders for synthetic Bambu-style .3mf archives. They carry just
// the Metadata entries the gate reads; no geometry, no designer content.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildZip } from "./zipwriter.mjs";

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * plates: [{ index, objects?: n, sliced?: { prediction, weight, modelId, nozzle,
 *            filaments: [{ id, type, usedG }] } }]
 * project: object written as project_settings.config (JSON), or null to omit
 * pngOnly: write plate_N.png entries instead of model_settings.config
 */
export function build3mf({ plates = [], project = null, pngOnly = false, sliceInfo = true } = {}) {
  const entries = [{ name: "3D/3dmodel.model", data: "<model/>" }];
  if (pngOnly) {
    for (const p of plates) entries.push({ name: `Metadata/plate_${p.index}.png`, data: "png" });
  } else {
    const xml = plates
      .map(
        (p) =>
          `  <plate>\n    <metadata key="plater_id" value="${p.index}"/>\n    <metadata key="plater_name" value="${esc(p.name ?? "")}"/>\n` +
          "    <model_instance>\n    </model_instance>\n".repeat(p.objects ?? 1) +
          "  </plate>\n",
      )
      .join("");
    entries.push({
      name: "Metadata/model_settings.config",
      data: `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n${xml}</config>\n`,
    });
  }
  if (sliceInfo) {
    const sliced = plates
      .filter((p) => p.sliced)
      .map((p) => {
        const s = p.sliced;
        const fil = (s.filaments ?? [])
          .map(
            (f) =>
              `    <filament id="${f.id}" tray_info_idx="GFA00" type="${esc(f.type)}" color="#FFFFFF" used_m="1.0" used_g="${f.usedG}" />\n`,
          )
          .join("");
        return (
          "  <plate>\n" +
          `    <metadata key="index" value="${p.index}"/>\n` +
          (s.modelId === undefined ? "" : `    <metadata key="printer_model_id" value="${esc(s.modelId)}"/>\n`) +
          (s.nozzle === undefined ? "" : `    <metadata key="nozzle_diameters" value="${esc(s.nozzle)}"/>\n`) +
          `    <metadata key="prediction" value="${s.prediction}"/>\n` +
          `    <metadata key="weight" value="${s.weight}"/>\n` +
          fil +
          "  </plate>\n"
        );
      })
      .join("");
    entries.push({
      name: "Metadata/slice_info.config",
      data: `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n  <header>\n    <header_item key="X-BBL-Client-Type" value="slicer"/>\n  </header>\n${sliced}</config>\n`,
    });
  }
  if (project) {
    entries.push({
      name: "Metadata/project_settings.config",
      data: typeof project === "string" ? project : JSON.stringify(project),
    });
  }
  return buildZip(entries);
}

export function writeTmp(name, buf, dir = mkdtempSync(join(tmpdir(), "gate-3mf-"))) {
  const file = join(dir, name);
  writeFileSync(file, buf);
  return file;
}

export const P1S_PROJECT = {
  printer_model: "Bambu Lab P1S",
  printer_settings_id: "Bambu Lab P1S 0.4 nozzle",
  nozzle_diameter: ["0.4"],
  print_settings_id: "0.20mm Standard @BBL X1C",
  filament_type: ["PLA", "PETG"],
  layer_height: "0.2",
  wall_loops: "2",
  sparse_infill_density: "15%",
};
