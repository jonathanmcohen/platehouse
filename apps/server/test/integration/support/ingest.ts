// The ingest tests' environment (build plan Task 8): the library env (a
// migrated Postgres 17 and a bucket on the S3 test server) plus a temp folder
// for uploaded files and the builders for the files themselves. Every file is
// made here from synthetic bytes; no designer file is read or committed.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { sql } from "kysely";
import { createIngest, type IngestStore } from "../../../src/ingest/ingest.js";
import { type LibraryEnv, startLibraryEnv } from "./library.js";

export interface IngestEnv extends LibraryEnv {
  /** A fresh folder for the files a test writes, removed by stop(). */
  dir: string;
  ingest: ReturnType<typeof createIngest>;
  /** An ingest over another store, such as one that is stopped. */
  ingestWith(store: IngestStore): ReturnType<typeof createIngest>;
}

export async function startIngestEnv(): Promise<IngestEnv> {
  const lib = await startLibraryEnv();
  const dir = await mkdtemp(join(tmpdir(), "platehouse-ingest-"));
  return {
    ...lib,
    dir,
    ingest: createIngest({ db: lib.db, store: lib.store }),
    ingestWith: (store) => createIngest({ db: lib.db, store }),
    async stop() {
      await rm(dir, { recursive: true, force: true });
      await lib.stop();
    },
  };
}

let fileCounter = 0;

/** Writes bytes to a new file in the env's folder and returns its path. */
export async function writeUpload(env: IngestEnv, bytes: Buffer | string): Promise<string> {
  fileCounter += 1;
  const path = join(env.dir, `upload-${fileCounter}.tmp`);
  await writeFile(path, bytes);
  return path;
}

/** Rows in the tables an ingest writes, and objects in the bucket. */
export async function footprint(env: IngestEnv) {
  const { rows } = await sql<{
    models: number;
    files: number;
    blobs: number;
    plates: number;
    estimates: number;
  }>`select
       (select count(*)::int from models) as models,
       (select count(*)::int from files) as files,
       (select count(*)::int from blobs) as blobs,
       (select count(*)::int from plates) as plates,
       (select count(*)::int from estimates) as estimates`.execute(env.db);
  const row = rows[0];
  if (!row) throw new Error("count query returned no row");
  const objects = (await env.store.listPrefix("models/")).length;
  return { ...row, objects };
}

// A minimal zip writer: every entry deflated, sizes and offsets true.
export function buildZip(entries: Array<{ name: string; data: Buffer | string }>): Buffer {
  const parts: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = typeof entry.data === "string" ? Buffer.from(entry.data, "utf8") : entry.data;
    const body = deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(45, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface MakerWorldSpec {
  title?: string;
  designer: string;
  /** HTML, as MakerWorld writes it; escaped once more into the XML here. */
  descriptionHtml?: string;
  license?: string;
}

export interface ThreeMfSpec {
  /** How many plates, numbered from 1, each holding one object. */
  plates: number;
  /** Plates that carry Bambu's own slice numbers, sliced on a P1S (BBL C12). */
  sliced?: number[];
  /** The filament ids on each sliced plate; [1] when left out. */
  sliceFilamentIds?: number[];
  makerWorld?: MakerWorldSpec;
}

// MakerWorld values are escaped twice in a real file (extractMakerWorld
// decodes twice), so the text is escaped here and again into the XML.
function modelXml(mw: MakerWorldSpec | undefined): string {
  const meta = (name: string, value: string | undefined) =>
    value === undefined ? "" : ` <metadata name="${name}">${esc(esc(value))}</metadata>\n`;
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" ' +
    'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n' +
    ' <metadata name="Application">BambuStudio-02.03.00.70</metadata>\n' +
    (mw
      ? meta("Designer", mw.designer) +
        meta("Title", mw.title) +
        meta("Description", mw.descriptionHtml) +
        meta("License", mw.license)
      : "") +
    ' <resources>\n  <object id="1" type="model"/>\n </resources>\n</model>\n'
  );
}

/** A small PNG-shaped payload; nothing decodes it. */
export function png(tag: string): Buffer {
  return Buffer.from(`\x89PNG\r\n\x1a\n${tag}`, "latin1");
}

/** A Bambu-style .3mf with plates, thumbnails, a filament list and optional slice data. */
export function build3mf(spec: ThreeMfSpec): Buffer {
  const indexes = Array.from({ length: spec.plates }, (_, i) => i + 1);
  const settings =
    '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n' +
    '  <object id="2">\n    <metadata key="name" value="Synthetic cube"/>\n  </object>\n' +
    indexes
      .map(
        (n) =>
          "  <plate>\n" +
          `    <metadata key="plater_id" value="${n}"/>\n` +
          `    <metadata key="plater_name" value="Plate name ${n}"/>\n` +
          '    <model_instance>\n      <metadata key="object_id" value="2"/>\n    </model_instance>\n' +
          "  </plate>\n",
      )
      .join("") +
    "</config>\n";
  const entries: Array<{ name: string; data: Buffer | string }> = [
    { name: "3D/3dmodel.model", data: modelXml(spec.makerWorld) },
    { name: "Metadata/model_settings.config", data: settings },
    {
      name: "Metadata/project_settings.config",
      data: JSON.stringify({
        print_settings_id: "0.20mm Standard @BBL X1C",
        filament_type: ["PLA", "PETG"],
        filament_colour: ["#00AE42", "#FFFFFF"],
      }),
    },
  ];
  const sliced = spec.sliced ?? [];
  if (sliced.length > 0) {
    entries.push({
      name: "Metadata/slice_info.config",
      data:
        '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n' +
        sliced
          .map(
            (n) =>
              "  <plate>\n" +
              `    <metadata key="index" value="${n}"/>\n` +
              '    <metadata key="printer_model_id" value="C12"/>\n' +
              '    <metadata key="nozzle_diameters" value="0.4"/>\n' +
              `    <metadata key="prediction" value="${1000 * n}"/>\n` +
              `    <metadata key="weight" value="${10 * n}.5"/>\n` +
              (spec.sliceFilamentIds ?? [1])
                .map(
                  (id, i) =>
                    `    <filament id="${id}" type="${i === 0 ? "PLA" : "PETG"}" color="#00AE42" used_m="1.00" used_g="${10 * n}.5" />\n`,
                )
                .join("") +
              "  </plate>\n",
          )
          .join("") +
        "</config>\n",
    });
  }
  for (const n of indexes) entries.push({ name: `Metadata/plate_${n}.png`, data: png(`p${n}`) });
  return buildZip(entries);
}

/** A zip that names no Bambu entry: a .3mf with no plate data. */
export function plainZip(): Buffer {
  return buildZip([{ name: "3D/3dmodel.model", data: modelXml(undefined) }]);
}

/** An ASCII STL of one triangle. */
export const ASCII_STL =
  "solid cube\n facet normal 0 0 1\n  outer loop\n   vertex 0 0 0\n   vertex 1 0 0\n" +
  "   vertex 0 1 0\n  endloop\n endfacet\nendsolid cube\n";

/** A binary STL with one triangle: 80-byte header, count, one 50-byte facet. */
export function binaryStl(): Buffer {
  const out = Buffer.alloc(84 + 50);
  out.write("binary stl from the platehouse tests", 0, "ascii");
  out.writeUInt32LE(1, 80);
  return out;
}

export const STEP_TEXT =
  "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('synthetic'),'2;1');\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n";

export const SCAD_TEXT = "cube([10, 10, 10]);\n";
