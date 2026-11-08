// Test-only synthetic copy of Orca's resources/profiles layout (BBL vendor
// tree plus OrcaFilamentLibrary), small enough to reason about in a test.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

function put(root, rel, obj) {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(obj));
}

export function profileTree() {
  const root = mkdtempSync(join(tmpdir(), "gate-prof-"));
  const m = (name, sub = `machine/${name}.json`) => ({ name, sub_path: sub });
  const f = (name, sub = `filament/${name}.json`) => ({ name, sub_path: sub });
  put(root, "BBL.json", {
    name: "Bambu Lab",
    machine_model_list: [m("Bambu Lab P1S"), m("Bambu Lab A1")],
    machine_list: [
      m("fdm_machine_common"),
      m("fdm_bbl_3dp_001_common"),
      m("Bambu Lab P1S 0.4 nozzle"),
      m("Bambu Lab A1 0.4 nozzle"),
      m("Escape", "../outside.json"),
    ],
    process_list: [],
    filament_list: [
      f("fdm_filament_common"),
      f("Generic PLA @base"),
      f("Generic PLA"),
      f("Generic PLA Silk"),
      f("Generic PLA @BBL A1", "filament/A1/Generic PLA @BBL A1.json"),
      f("Generic PETG"),
      f("Dangling"),
      f("Loop A"),
      f("Loop B"),
    ],
  });
  put(root, "BBL/machine/Bambu Lab P1S.json", { type: "machine_model", name: "Bambu Lab P1S", model_id: "C12" });
  put(root, "BBL/machine/Bambu Lab A1.json", { type: "machine_model", name: "Bambu Lab A1", model_id: "N2S" });
  put(root, "BBL/machine/fdm_machine_common.json", {
    type: "machine",
    name: "fdm_machine_common",
    from: "system",
    instantiation: "false",
    machine_start_gcode: "generic",
    printable_height: "100",
    gcode_flavor: "marlin",
  });
  put(root, "BBL/machine/fdm_bbl_3dp_001_common.json", {
    type: "machine",
    name: "fdm_bbl_3dp_001_common",
    inherits: "fdm_machine_common",
    from: "system",
    instantiation: "false",
    printable_height: "250",
  });
  put(root, "BBL/machine/Bambu Lab P1S 0.4 nozzle.json", {
    type: "machine",
    name: "Bambu Lab P1S 0.4 nozzle",
    inherits: "fdm_bbl_3dp_001_common",
    from: "system",
    instantiation: "true",
    printer_model: "Bambu Lab P1S",
    nozzle_diameter: ["0.4"],
  });
  put(root, "BBL/machine/Bambu Lab P1S 0.4 nozzle template machine_start_gcode.json", {
    name: "Bambu Lab P1S 0.4 nozzle template machine_start_gcode",
    instantiation: "false",
    machine_start_gcode: "real P1S start",
    printable_height: "999",
    printer_model: "wrong",
  });
  put(root, "BBL/machine/Bambu Lab A1 0.4 nozzle.json", {
    type: "machine",
    name: "Bambu Lab A1 0.4 nozzle",
    inherits: "fdm_bbl_3dp_001_common",
    from: "system",
    instantiation: "true",
    printer_model: "Bambu Lab A1",
  });
  put(root, "outside.json", { name: "Escape", instantiation: "true" });
  put(root, "BBL/filament/fdm_filament_common.json", {
    type: "filament",
    name: "fdm_filament_common",
    from: "system",
    instantiation: "false",
    filament_density: ["1.24"],
  });
  put(root, "BBL/filament/Generic PLA @base.json", {
    type: "filament",
    name: "Generic PLA @base",
    inherits: "fdm_filament_pla",
    from: "system",
    instantiation: "false",
    filament_type: ["PLA"],
    filament_id: "GFL99",
  });
  put(root, "BBL/filament/Generic PLA.json", {
    type: "filament",
    name: "Generic PLA",
    inherits: "Generic PLA @base",
    from: "system",
    instantiation: "true",
    compatible_printers: ["Bambu Lab P1S 0.4 nozzle"],
  });
  put(root, "BBL/filament/Generic PLA Silk.json", {
    type: "filament",
    name: "Generic PLA Silk",
    inherits: "Generic PLA @base",
    from: "system",
    instantiation: "true",
    compatible_printers: ["Bambu Lab P1S 0.4 nozzle", "Bambu Lab A1 0.4 nozzle"],
  });
  put(root, "BBL/filament/A1/Generic PLA @BBL A1.json", {
    type: "filament",
    name: "Generic PLA @BBL A1",
    inherits: "Generic PLA @base",
    from: "system",
    instantiation: "true",
    compatible_printers: ["Bambu Lab A1 0.4 nozzle"],
  });
  put(root, "BBL/filament/Generic PETG.json", {
    type: "filament",
    name: "Generic PETG",
    inherits: "fdm_filament_common",
    from: "system",
    instantiation: "true",
    filament_type: ["PETG"],
    compatible_printers: ["Bambu Lab P1S 0.4 nozzle"],
  });
  put(root, "BBL/filament/Dangling.json", { type: "filament", name: "Dangling", inherits: "No Such Parent", from: "system" });
  put(root, "BBL/filament/Loop A.json", { type: "filament", name: "Loop A", inherits: "Loop B" });
  put(root, "BBL/filament/Loop B.json", { type: "filament", name: "Loop B", inherits: "Loop A" });
  put(root, "OrcaFilamentLibrary.json", {
    name: "OrcaFilamentLibrary",
    filament_list: [f("fdm_filament_pla"), f("fdm_filament_common")],
  });
  put(root, "OrcaFilamentLibrary/filament/fdm_filament_pla.json", {
    type: "filament",
    name: "fdm_filament_pla",
    inherits: "fdm_filament_common",
    from: "system",
    instantiation: "false",
    filament_type: ["PLA"],
  });
  put(root, "OrcaFilamentLibrary/filament/fdm_filament_common.json", {
    type: "filament",
    name: "fdm_filament_common",
    from: "system",
    instantiation: "false",
    filament_density: ["1.30"],
    library_only: "yes",
  });
  return root;
}
