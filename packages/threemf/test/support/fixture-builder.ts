// Test-only builders for synthetic Bambu-style .3mf archives. The suite makes
// every fixture itself: no designer file is ever read or committed. The zip
// writer can lie about sizes and offsets so the hostile-file tests can build
// the damaged archives the Bambu Plates issues describe.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

export const MiB = 1024 * 1024;

export interface ZipEntry {
  name: string;
  data: Buffer | string;
  /** 0 = stored, 8 = deflated (default). */
  method?: 0 | 8;
  /** Uncompressed size written to the headers instead of the real one. */
  declaredSize?: number;
  /** Local header offset written to the central directory instead of the real one. */
  localOffset?: number;
  /** Raw extra field for the central directory entry. */
  centralExtra?: Buffer;
  /** Write 0xFFFFFFFF as the uncompressed size, so a reader must look for a zip64 field. */
  zip64Size?: boolean;
}

export interface ZipOptions {
  /** Central directory offset written to the end record instead of the real one. */
  cdOffset?: number;
  /** Mark the end record as zip64 and add a locator pointing at this offset. */
  zip64EndAt?: bigint;
}

export function buildZip(entries: ZipEntry[], opts: ZipOptions = {}): Buffer {
  const parts: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = typeof entry.data === "string" ? Buffer.from(entry.data, "utf8") : entry.data;
    const method = entry.method ?? 8;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const size = entry.zip64Size ? 0xffffffff : (entry.declaredSize ?? raw.length);
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, body);

    const extra = entry.centralExtra ?? Buffer.alloc(0);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(45, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(entry.localOffset ?? offset, 42);
    centrals.push(central, name, extra);

    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const tail: Buffer[] = [];
  if (opts.zip64EndAt !== undefined) {
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(opts.zip64EndAt, 8);
    locator.writeUInt32LE(1, 16);
    tail.push(locator);
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  const zip64 = opts.zip64EndAt !== undefined;
  eocd.writeUInt16LE(zip64 ? 0xffff : entries.length, 8);
  eocd.writeUInt16LE(zip64 ? 0xffff : entries.length, 10);
  eocd.writeUInt32LE(zip64 ? 0xffffffff : cd.length, 12);
  eocd.writeUInt32LE(zip64 ? 0xffffffff : (opts.cdOffset ?? offset), 16);
  tail.push(eocd);
  return Buffer.concat([...parts, cd, ...tail]);
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface PlateSpec {
  index: number | string;
  name?: string;
  objects?: number;
}

/** Metadata/model_settings.config as Bambu Studio writes it. */
export function modelSettingsXml(plates: PlateSpec[], objectBlock = true): string {
  const objects = objectBlock
    ? '  <object id="2">\n    <metadata key="name" value="Synthetic cube"/>\n  </object>\n'
    : "";
  const body = plates
    .map(
      (p) =>
        "  <plate>\n" +
        `    <metadata key="plater_id" value="${esc(String(p.index))}"/>\n` +
        `    <metadata key="plater_name" value="${esc(p.name ?? "")}"/>\n` +
        '    <metadata key="locked" value="false"/>\n' +
        '    <model_instance>\n      <metadata key="object_id" value="2"/>\n    </model_instance>\n'.repeat(
          p.objects ?? 1,
        ) +
        "  </plate>\n",
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n${objects}${body}</config>\n`;
}

export interface SliceFilamentSpec {
  id: number | string;
  type: string;
  color?: string;
  usedG?: number | string;
}

export interface SliceSpec {
  index: number | string;
  prediction?: number | string;
  weight?: number | string;
  printerModelId?: string;
  nozzle?: string;
  filaments?: SliceFilamentSpec[];
}

/** Metadata/slice_info.config as Bambu Studio writes it after slicing. */
export function sliceInfoXml(slices: SliceSpec[]): string {
  const body = slices
    .map((s) => {
      const meta = (key: string, v: string | number | undefined): string =>
        v === undefined ? "" : `    <metadata key="${key}" value="${esc(String(v))}"/>\n`;
      const fil = (s.filaments ?? [])
        .map(
          (f) =>
            `    <filament id="${esc(String(f.id))}" tray_info_idx="GFA00" type="${esc(f.type)}" color="${esc(f.color ?? "#FFFFFF")}" used_m="1.00" used_g="${esc(String(f.usedG ?? 1))}" />\n`,
        )
        .join("");
      return (
        "  <plate>\n" +
        meta("index", s.index) +
        meta("printer_model_id", s.printerModelId) +
        meta("nozzle_diameters", s.nozzle) +
        meta("prediction", s.prediction) +
        meta("weight", s.weight) +
        '    <metadata key="outside" value="false"/>\n' +
        '    <object identify_id="99" name="Synthetic cube" skipped="false" />\n' +
        fil +
        "  </plate>\n"
      );
    })
    .join("");
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n  <header>\n' +
    '    <header_item key="X-BBL-Client-Type" value="slicer"/>\n' +
    '    <header_item key="X-BBL-Client-Version" value="02.03.00.70"/>\n' +
    `  </header>\n${body}</config>\n`
  );
}

/** A small valid PNG-shaped payload; the parser never decodes images. */
export function png(tag: string, size?: number): Buffer {
  const head = Buffer.from(`\x89PNG\r\n\x1a\n${tag}`, "latin1");
  if (size === undefined) return head;
  const out = Buffer.alloc(size);
  head.copy(out, 0, 0, Math.min(head.length, size));
  return out;
}

export const MODEL_XML =
  '<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" ' +
  'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n' +
  ' <metadata name="Application">BambuStudio-02.03.00.70</metadata>\n' +
  ' <metadata name="Designer">Synthetic Designer</metadata>\n' +
  ' <metadata name="Title">Synthetic Title</metadata>\n' +
  ' <resources>\n  <object id="1" type="model"/>\n </resources>\n</model>\n';

export const P1S_PROJECT = {
  printer_model: "Bambu Lab P1S",
  printer_settings_id: "Bambu Lab P1S 0.4 nozzle",
  nozzle_diameter: ["0.4"],
  print_settings_id: "0.20mm Standard @BBL X1C",
  filament_type: ["PLA", "PETG"],
  filament_colour: ["#00AE42", "#FFFFFF80"],
};

export interface ProjectSpec {
  plates?: PlateSpec[];
  /** Raw model_settings.config text; overrides plates. null omits the entry. */
  modelSettings?: string | null;
  slices?: SliceSpec[];
  /** Raw slice_info.config text; overrides slices. */
  sliceInfo?: string;
  /** Written as JSON unless it is already a string. */
  project?: object | string;
  /** Thumbnails by plate index: plate_<n>.png. */
  pngs?: Record<number, Buffer>;
  /** Fallback thumbnails by plate index: plate_<n>_small.png. */
  smallPngs?: Record<number, Buffer>;
  /** 3D/3dmodel.model text; defaults to MODEL_XML. null omits it. */
  model?: string | Buffer | null;
  extra?: ZipEntry[];
}

/** The entries of a Bambu-style project, so a test can alter one before zipping. */
export function projectEntries(spec: ProjectSpec): ZipEntry[] {
  const entries: ZipEntry[] = [];
  const model = spec.model === undefined ? MODEL_XML : spec.model;
  if (model !== null) entries.push({ name: "3D/3dmodel.model", data: model });
  const settings =
    spec.modelSettings !== undefined
      ? spec.modelSettings
      : spec.plates
        ? modelSettingsXml(spec.plates)
        : null;
  if (settings !== null) entries.push({ name: "Metadata/model_settings.config", data: settings });
  const slice = spec.sliceInfo ?? (spec.slices ? sliceInfoXml(spec.slices) : undefined);
  if (slice !== undefined) entries.push({ name: "Metadata/slice_info.config", data: slice });
  if (spec.project !== undefined) {
    entries.push({
      name: "Metadata/project_settings.config",
      data: typeof spec.project === "string" ? spec.project : JSON.stringify(spec.project),
    });
  }
  for (const [n, data] of Object.entries(spec.pngs ?? {})) {
    entries.push({ name: `Metadata/plate_${n}.png`, data, method: 8 });
  }
  for (const [n, data] of Object.entries(spec.smallPngs ?? {})) {
    entries.push({ name: `Metadata/plate_${n}_small.png`, data, method: 8 });
  }
  entries.push(...(spec.extra ?? []));
  return entries;
}

export function build3mf(spec: ProjectSpec, opts?: ZipOptions): Buffer {
  return buildZip(projectEntries(spec), opts);
}

let tmpRoot: string | undefined;

/** Writes the bytes to a fresh temp file and returns its path. */
export function writeTmp(buf: Buffer, name = "fixture.3mf"): string {
  tmpRoot ??= mkdtempSync(join(tmpdir(), "platehouse-threemf-"));
  const dir = mkdtempSync(join(tmpRoot, "f-"));
  const file = join(dir, name);
  writeFileSync(file, buf);
  return file;
}

/** Deterministic pseudo-random bytes, so a failing row is reproducible. */
export function seededBytes(length: number, seed = 0x5eed): Buffer {
  const out = Buffer.alloc(length);
  let x = seed >>> 0;
  for (let i = 0; i < length; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

export const range = (n: number, from = 1): number[] =>
  Array.from({ length: n }, (_, i) => i + from);
