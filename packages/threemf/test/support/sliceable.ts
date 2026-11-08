// buildSliceable (build plan Task 11): a generated multi-plate,
// multi-filament Bambu project of 20 mm cubes that OrcaSlicer 2.5.0 can
// slice. It is the fixture for the slicer's container tests and the AC-037
// smoke slice; no designer file is involved.
//
// What Orca needs from it, read from its source at commit 40ecc66:
// - 3D/3dmodel.model's Application metadata starting "BambuStudio-" marks a
//   Bambu project (bbs_3mf.cpp _handle_end_metadata), so the plates in
//   Metadata/model_settings.config are used and nothing is re-arranged;
// - each plate's objects sit inside that plate's bed. Orca lays plates out
//   in a grid of ceil(sqrt(n)) columns, 1.2 bed widths apart, rows going
//   down in y (PartPlate.hpp compute_colum_count, PartPlate.cpp
//   compute_shape_position and LOGICAL_PART_PLATE_GAP);
// - Metadata/project_settings.config names the printer, process and
//   filaments. Orca loads a project config over its defaults, so keys left
//   out keep Orca's defaults (Config.cpp load_from_json); the CLI reads the
//   preset ids defensively for a project "produced by a non-GUI writer"
//   (OrcaSlicer.cpp). The project is saved for the P1S 0.4 nozzle with the
//   P1S's default process, so slicing it on the P1S switches nothing.
//
// Each plate holds one cube per filament, cube k printed with filament k.
import { buildZip } from "./fixture-builder.js";

export const SLICEABLE_PRINTER = "Bambu Lab P1S 0.4 nozzle";
const PRINTER_MODEL = "Bambu Lab P1S";
const PROCESS = "0.20mm Standard @BBL X1C";
const BED = 256;
const CUBE = 20;
const COLOURS = [
  "#FFFFFF",
  "#1F1F1F",
  "#C12E1F",
  "#2850E0",
  "#F4D53F",
  "#00AE42",
  "#F99963",
  "#8E5CB5",
  "#A3D8E1",
  "#898989",
  "#7D6556",
  "#F7ADA6",
  "#0A2989",
  "#AE835B",
  "#5E43B7",
  "#D3B7A7",
];

export interface SliceableOptions {
  plates: number;
  filaments: number;
}

/** The world position of plate `index` (0-based) in a project of `count` plates. */
export function plateOrigin(index: number, count: number, bed = BED): { x: number; y: number } {
  const value = Math.sqrt(count);
  const rounded = Math.round(value);
  const cols = value > rounded ? rounded + 1 : rounded;
  const row = Math.floor(index / cols);
  const col = index % cols;
  return { x: col * bed * 1.2, y: row === 0 ? 0 : -row * bed * 1.2 };
}

function cubeMesh(size: number): string {
  const s = size;
  const v = [
    [0, 0, 0],
    [s, 0, 0],
    [s, s, 0],
    [0, s, 0],
    [0, 0, s],
    [s, 0, s],
    [s, s, s],
    [0, s, s],
  ];
  // Counter-clockwise seen from outside, as 3MF requires.
  const t = [
    [0, 2, 1],
    [0, 3, 2],
    [4, 5, 6],
    [4, 6, 7],
    [0, 1, 5],
    [0, 5, 4],
    [1, 2, 6],
    [1, 6, 5],
    [2, 3, 7],
    [2, 7, 6],
    [3, 0, 4],
    [3, 4, 7],
  ];
  const vertices = v.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join("");
  const triangles = t.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join("");
  return `<mesh><vertices>${vertices}</vertices><triangles>${triangles}</triangles></mesh>`;
}

interface Placed {
  id: number;
  plate: number;
  filament: number;
  x: number;
  y: number;
}

/** The archive's entries before zipping, so tests can read what Orca will read. */
export function sliceableEntries(opts: SliceableOptions): Map<string, string> {
  const { plates, filaments } = opts;
  if (!Number.isInteger(plates) || plates < 1 || plates > 128) {
    throw new RangeError(`plates must be 1 to 128, not ${plates}`);
  }
  if (!Number.isInteger(filaments) || filaments < 1 || filaments > COLOURS.length) {
    throw new RangeError(`filaments must be 1 to ${COLOURS.length}, not ${filaments}`);
  }
  const placed: Placed[] = [];
  for (let p = 0; p < plates; p++) {
    const origin = plateOrigin(p, plates);
    for (let f = 0; f < filaments; f++) {
      placed.push({
        id: placed.length + 1,
        plate: p + 1,
        filament: f + 1,
        x: origin.x + 40 + (f % 4) * 45,
        y: origin.y + 40 + Math.floor(f / 4) * 45,
      });
    }
  }

  const mesh = cubeMesh(CUBE);
  const model = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">',
    '<metadata name="Application">BambuStudio-02.03.00.70</metadata>',
    '<metadata name="BambuStudio:3mfVersion">1</metadata>',
    '<metadata name="Title">Platehouse sliceable cubes</metadata>',
    "<resources>",
    ...placed.map((o) => `<object id="${o.id}" type="model">${mesh}</object>`),
    "</resources>",
    "<build>",
    ...placed.map(
      (o) =>
        `<item objectid="${o.id}" transform="1 0 0 0 1 0 0 0 1 ${o.x} ${o.y} 0" printable="1"/>`,
    ),
    "</build>",
    "</model>",
  ].join("\n");

  const settings = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<config>",
    ...placed.map(
      (o) =>
        `  <object id="${o.id}">\n    <metadata key="name" value="cube-p${o.plate}-f${o.filament}"/>\n    <metadata key="extruder" value="${o.filament}"/>\n  </object>`,
    ),
    ...Array.from({ length: plates }, (_, i) => {
      const mine = placed.filter((o) => o.plate === i + 1);
      const instances = mine
        .map(
          (o) =>
            `    <model_instance>\n      <metadata key="object_id" value="${o.id}"/>\n      <metadata key="instance_id" value="0"/>\n      <metadata key="identify_id" value="${1000 + o.id}"/>\n    </model_instance>`,
        )
        .join("\n");
      return `  <plate>\n    <metadata key="plater_id" value="${i + 1}"/>\n    <metadata key="plater_name" value=""/>\n    <metadata key="locked" value="false"/>\n${instances}\n  </plate>`;
    }),
    "</config>",
  ].join("\n");

  const project = {
    name: "project_settings",
    from: "project",
    printer_settings_id: SLICEABLE_PRINTER,
    printer_model: PRINTER_MODEL,
    print_settings_id: PROCESS,
    filament_settings_id: Array.from({ length: filaments }, () => "Generic PLA"),
    filament_type: Array.from({ length: filaments }, () => "PLA"),
    filament_colour: COLOURS.slice(0, filaments),
    nozzle_diameter: ["0.4"],
    printable_area: ["0x0", `${BED}x0`, `${BED}x${BED}`, `0x${BED}`],
    printable_height: "250",
    layer_height: "0.2",
  };

  return new Map([
    [
      "[Content_Types].xml",
      '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n <Default Extension="png" ContentType="image/png"/>\n</Types>\n',
    ],
    [
      "_rels/.rels",
      '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n</Relationships>\n',
    ],
    ["3D/3dmodel.model", model],
    ["Metadata/model_settings.config", settings],
    ["Metadata/project_settings.config", `${JSON.stringify(project, null, 4)}\n`],
  ]);
}

/** The project as .3mf bytes. */
export function buildSliceable(opts: SliceableOptions): Buffer {
  return buildZip([...sliceableEntries(opts)].map(([name, data]) => ({ name, data })));
}
