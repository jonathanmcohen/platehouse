// Test-only builders for the 3D model parts of a .3mf, for the plate mesh
// reader (issue #358). Two layouts are built, as Bambu Studio writes them:
// - one part: every object's mesh inside 3D/3dmodel.model, placed by the
//   build items (buildSliceable in sliceable.ts is this layout);
// - split: 3D/3dmodel.model holds only objects made of components, each
//   component naming a mesh object in a part of its own under 3D/Objects/
//   with the production extension's p:path, and the build items place those
//   objects.
// Every value is synthetic; no designer file is read.

const CORE = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02";
const PRODUCTION = "http://schemas.microsoft.com/3dmanufacturing/production/2015/06";

export const IDENTITY = "1 0 0 0 1 0 0 0 1 0 0 0";

/** A 3MF transform that only moves: x, y, z in millimetres. */
export function moved(x: number, y: number, z = 0): string {
  return `1 0 0 0 1 0 0 0 1 ${x} ${y} ${z}`;
}

/** An axis-aligned box mesh from the origin, s by s by h, counter-clockwise from outside. */
export function boxMesh(s: number, h = s): string {
  const v = [
    [0, 0, 0],
    [s, 0, 0],
    [s, s, 0],
    [0, s, 0],
    [0, 0, h],
    [s, 0, h],
    [s, s, h],
    [0, s, h],
  ];
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
  return meshXml(v, t);
}

/** A mesh from raw vertices and triangles, as written in a .model part. */
export function meshXml(vertices: number[][], triangles: number[][]): string {
  const vs = vertices.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join("\n     ");
  const ts = triangles
    .map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`)
    .join("\n     ");
  return `<mesh>\n    <vertices>\n     ${vs}\n    </vertices>\n    <triangles>\n     ${ts}\n    </triangles>\n   </mesh>`;
}

/** A .model part: its resources and, for the root part, its build items. */
export function modelXml(resources: string[], build: string[] | null): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<model unit="millimeter" xml:lang="en-US" xmlns="${CORE}" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="${PRODUCTION}" requiredextensions="p">`,
    ' <metadata name="Application">BambuStudio-02.03.00.70</metadata>',
    " <resources>",
    ...resources.map((r) => `  ${r}`),
    " </resources>",
    ...(build === null ? [] : [" <build>", ...build.map((b) => `  ${b}`), " </build>"]),
    "</model>",
  ].join("\n");
}

export function meshObject(id: number, mesh: string): string {
  return `<object id="${id}" type="model">\n   ${mesh}\n  </object>`;
}

export interface ComponentSpec {
  objectId: number;
  /** The part holding the mesh object, such as /3D/Objects/object_1.model; left out, the same part. */
  path?: string;
  transform?: string;
}

export function componentObject(id: number, components: ComponentSpec[]): string {
  const cs = components
    .map(
      (c) =>
        `<component${c.path === undefined ? "" : ` p:path="${c.path}"`} objectid="${c.objectId}"${
          c.transform === undefined ? "" : ` transform="${c.transform}"`
        }/>`,
    )
    .join("\n    ");
  return `<object id="${id}" type="model">\n   <components>\n    ${cs}\n   </components>\n  </object>`;
}

export function buildItem(objectId: number, transform?: string): string {
  return `<item objectid="${objectId}"${transform === undefined ? "" : ` transform="${transform}"`} printable="1"/>`;
}

export interface SettingsPart {
  id: number;
  extruder?: number;
  /** normal_part when left out; modifier_part, negative_volume and the support kinds are not printed. */
  subtype?: string;
}

export interface SettingsObject {
  id: number;
  extruder?: number;
  parts?: SettingsPart[];
}

export interface SettingsPlate {
  index: number;
  /** [object id, instance id]; the instance id line is left out when undefined. */
  instances: Array<[number, number | undefined]>;
}

/** Metadata/model_settings.config with object extruders, parts and plates. */
export function settingsXml(objects: SettingsObject[], plates: SettingsPlate[]): string {
  const obj = objects
    .map((o) => {
      const parts = (o.parts ?? [])
        .map(
          (p) =>
            `    <part id="${p.id}" subtype="${p.subtype ?? "normal_part"}">\n` +
            `      <metadata key="name" value="part ${p.id}"/>\n` +
            (p.extruder === undefined
              ? ""
              : `      <metadata key="extruder" value="${p.extruder}"/>\n`) +
            "    </part>\n",
        )
        .join("");
      return (
        `  <object id="${o.id}">\n    <metadata key="name" value="object ${o.id}"/>\n` +
        (o.extruder === undefined ? "" : `    <metadata key="extruder" value="${o.extruder}"/>\n`) +
        parts +
        "  </object>\n"
      );
    })
    .join("");
  const pl = plates
    .map(
      (p) =>
        `  <plate>\n    <metadata key="plater_id" value="${p.index}"/>\n    <metadata key="plater_name" value=""/>\n` +
        p.instances
          .map(
            ([objectId, instanceId]) =>
              `    <model_instance>\n      <metadata key="object_id" value="${objectId}"/>\n` +
              (instanceId === undefined
                ? ""
                : `      <metadata key="instance_id" value="${instanceId}"/>\n`) +
              "    </model_instance>\n",
          )
          .join("") +
        "  </plate>\n",
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n${obj}${pl}</config>\n`;
}

/** Metadata/project_settings.config with only the filament colours (and types). */
export function projectJson(colours: string[]): string {
  return JSON.stringify({
    filament_type: colours.map(() => "PLA"),
    filament_colour: colours,
  });
}
