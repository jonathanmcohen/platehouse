// The example Compose project (examples/docker-compose.yml) and the docs that
// name its services. Docker registers each service name as a DNS alias on
// every network the service joins, so a generic name such as db or app could
// resolve to another project's container on a shared network. The services
// are therefore named platehouse, platehouse-slicer and platehouse-db, the
// same as their containers (the maintainer, 2026-11-19), and every host the app is given
// and every service a doc names is one of them.
//
// Read as text: the workspace has no YAML parser of its own, and the file is
// small and plainly indented.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { LIMITS } from "@platehouse/slicer-contract";
import { PLATE_MESH_LIMITS, LIMITS as THREEMF_LIMITS } from "@platehouse/threemf";
import { describe, expect, test } from "vitest";
import { ANSWER_LIMITS, ERROR_ANSWER_MAX_BYTES } from "../src/derived/client.js";
import { PREVIEW_MESH_MAX_BYTES } from "../src/derived/preview.js";
import { MAX_ANSWER_BYTES as ESTIMATE_ANSWER_MAX_BYTES } from "../src/estimates/client.js";
import { INGEST_CONCURRENCY } from "../src/jobs/queues.js";
import { PLATE_MESH_BUILDS } from "../src/memory/gate.js";
import {
  MEMORY_GATE_PEAK_MB,
  PLATE_MESH_READ_PEAK_MB,
  STEP_PREVIEW_PEAK_MB,
} from "../src/memory/peaks.js";
import { PLATE_MESH_WORKER_LIMITS } from "../src/plate-mesh/worker-read.js";
import { MAX_UPLOAD_BYTES } from "../src/uploads/tus.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const COMPOSE = readFileSync(join(ROOT, "examples", "docker-compose.yml"), "utf8");
const SERVICES = ["platehouse", "platehouse-slicer", "platehouse-db"];

/** The lines of one top-level section ("services:" or "networks:"), without its heading. */
function section(text: string, name: string): string[] {
  const lines = text.split("\n");
  const start = lines.indexOf(`${name}:`);
  if (start === -1) throw new Error(`no ${name}: section`);
  const end = lines.findIndex((l, i) => i > start && /^\S/.test(l) && !l.startsWith("#"));
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

/** Each service's own lines, by name, from the services section. */
function services(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of section(COMPOSE, "services")) {
    const key = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line);
    if (key) {
      current = key[1] ?? null;
      if (current) out.set(current, []);
    } else if (current) {
      out.get(current)?.push(line);
    }
  }
  return out;
}

/** The value of a "    key: value" line in a service, or undefined. */
function field(lines: string[], key: string): string | undefined {
  const re = new RegExp(`^ {4,6}${key}: (.+)$`);
  for (const line of lines) {
    const m = re.exec(line);
    if (m) return m[1]?.trim();
  }
  return undefined;
}

describe("examples/docker-compose.yml", () => {
  test("names its services platehouse, platehouse-slicer and platehouse-db", () => {
    expect([...services().keys()]).toEqual(SERVICES);
  });

  test("gives each service the container name it is named for", () => {
    for (const [name, lines] of services()) expect(field(lines, "container_name")).toBe(name);
  });

  test("both images are pinned to this release's version tag", () => {
    const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
    expect(field(services().get("platehouse") ?? [], "image")).toBe(
      `ghcr.io/jonathanmcohen/platehouse:${version}`,
    );
    expect(field(services().get("platehouse-slicer") ?? [], "image")).toBe(
      `ghcr.io/jonathanmcohen/platehouse-slicer:${version}`,
    );
  });

  test("starts the app after platehouse-db is healthy", () => {
    const app = services().get("platehouse") ?? [];
    const at = app.findIndex((l) => /^ {4}depends_on:\s*$/.test(l));
    expect(at).toBeGreaterThan(-1);
    expect(app[at + 1]).toMatch(/^ {6}platehouse-db:\s*$/);
    expect(app[at + 2]).toMatch(/^ {8}condition: service_healthy\s*$/);
  });

  test("points the app at the database and the slicer by their service names", () => {
    const app = services().get("platehouse") ?? [];
    expect(field(app, "DATABASE_URL")).toMatch(/@platehouse-db:5432\//);
    expect(field(app, "SLICER_URL")).toBe("http://platehouse-slicer:8080");
  });
});

const MiB = 1024 * 1024;

/** A Compose byte value ("2g", "512m", "1024k" or plain bytes) in MiB. */
function mebibytes(value: string | undefined): number {
  const m = /^(\d+)([bkmg]?)$/i.exec(value ?? "");
  if (!m) throw new Error(`not a byte value: ${value}`);
  const unit: Record<string, number> = { "": 1, b: 1, k: 1024, m: MiB, g: 1024 * MiB };
  const scale = unit[(m[2] ?? "").toLowerCase()] ?? Number.NaN;
  return (Number(m[1]) * scale) / MiB;
}

/**
 * What the platehouse service needs beside its plate mesh reads: the server's
 * own heap, its requests and its other jobs. An allowance, not a measurement.
 */
const SERVER_ALLOWANCE_MB = 512;

/**
 * Every path in the app process that can hold a large buffer, with its peak
 * in MiB, and whether it runs under the memory gate (memory/gate.ts).
 * A new path that holds a large buffer goes here on purpose, under the gate,
 * or the test below fails.
 */
const LARGE_BUFFERS = [
  // A plate's 3D view: the worker's heap, the mesh arrays and the zip
  // reader's entry records (plate-mesh.ts).
  { path: "plate mesh read", peakMb: PLATE_MESH_READ_PEAK_MB, gated: true },
  // A STEP file's preview: its stored mesh, read whole (derived/preview.ts).
  { path: "STEP preview mesh read", peakMb: STEP_PREVIEW_PEAK_MB, gated: true },
];

/**
 * Reads held whole that are small and bounded, counted inside
 * SERVER_ALLOWANCE_MB: each at most `bytes`, at most `atOnce` at a time.
 */
const SMALL_BUFFERS = [
  // A .scad source, read whole to send it twice (derived/derived.ts readAll);
  // slicer jobs run one at a time.
  { path: ".scad source", bytes: LIMITS.scadBodyBytes, atOnce: 1 },
  // A slice answer from the slicer (estimates/client.ts); one at a time.
  { path: "slice answer", bytes: ESTIMATE_ANSWER_MAX_BYTES, atOnce: 1 },
  // A render route's error answer (derived/client.ts); one at a time.
  { path: "render error answer", bytes: ERROR_ANSWER_MAX_BYTES, atOnce: 1 },
  // A .3mf plate thumbnail at ingest (packages/threemf), one per import at a time.
  { path: "3MF thumbnail", bytes: THREEMF_LIMITS.pngBytes, atOnce: INGEST_CONCURRENCY },
  // A .3mf Metadata/*.config entry at ingest, one per import at a time.
  { path: "3MF config entry", bytes: THREEMF_LIMITS.configBytes, atOnce: INGEST_CONCURRENCY },
];

// Paths that stream and hold no large buffer, so they are in neither list:
// - every slicer render answer (STEP GLB, OpenSCAD STL and PNG, STL and STEP
//   preview PNGs): streamed to a temp file under TMP_DIR with its cap
//   enforced while it streams (derived/client.ts, ANSWER_LIMITS), then
//   stored from the file;
// - the STEP and STL sources sent to the slicer: streamed from the store;
// - a STEP preview's STL: made a chunk at a time and written to a temp file;
// - uploads (uploads/tus.ts) and inbox imports: written to disk, then stored
//   from the file;
// - a plate's GLB: views of the plate read's mesh arrays, inside its peak;
// - blob downloads: streamed from the store to the browser.
// Known and not yet counted (outside the slicer answers this list was
// written for): ingest's .3mf parse (two at once, INGEST_CONCURRENCY) lists
// every zip entry, the same entry records PLATE_MESH_READ_PEAK_MB counts,
// and runs outside the gate.

// Issue #358 review: a plate mesh worker's heap limit caps only its
// JavaScript heap. Its mesh arrays and the zip reader's entry records live
// outside that heap, so the worker limits alone do not keep the server inside
// its container; the kernel ends the whole server, not one worker, when the
// container passes mem_limit. So the reads that can run at once must fit,
// with room left for the server.
describe("the platehouse service's memory holds its plate mesh reads", () => {
  test("a read's peak is its heap, its mesh arrays and the biggest file's entry records", () => {
    const heap = PLATE_MESH_WORKER_LIMITS.maxOldGenerationSizeMb ?? Number.NaN;
    const young = PLATE_MESH_WORKER_LIMITS.maxYoungGenerationSizeMb ?? Number.NaN;
    const mesh = PLATE_MESH_LIMITS.meshBytes / MiB;
    const entries = MAX_UPLOAD_BYTES / MiB;
    expect(PLATE_MESH_READ_PEAK_MB).toBe(heap + young + mesh + entries);
  });

  // Review of PR #409: a STEP file's preview reads its whole mesh into the
  // app too (derived/preview.ts). It goes through the same gate as the plate
  // reads (memory/gate.ts, memoryGate), so each of the gate's
  // PLATE_MESH_BUILDS places holds a plate read or a STEP preview, never
  // both, and must fit the larger of the two.
  test("a place in the memory gate fits a plate read or a STEP preview's mesh read", () => {
    expect(STEP_PREVIEW_PEAK_MB).toBeGreaterThan(0);
    expect(MEMORY_GATE_PEAK_MB).toBe(Math.max(PLATE_MESH_READ_PEAK_MB, STEP_PREVIEW_PEAK_MB));
  });

  test("the jobs the memory gate runs at once, and the server's allowance, fit under mem_limit", () => {
    const app = services().get("platehouse") ?? [];
    const limit = mebibytes(field(app, "mem_limit"));
    expect(mebibytes(field(app, "memswap_limit"))).toBe(limit);
    const gated = LARGE_BUFFERS.filter((b) => b.gated);
    // Every large buffer is under the gate; nothing of size runs beside it.
    expect(LARGE_BUFFERS.filter((b) => !b.gated)).toEqual([]);
    const place = Math.max(...gated.map((b) => b.peakMb));
    expect(place).toBe(MEMORY_GATE_PEAK_MB);
    const needed = PLATE_MESH_BUILDS * place + SERVER_ALLOWANCE_MB;
    expect(needed).toBeLessThanOrEqual(limit);
  });

  test("the small reads held whole fit well inside the server's allowance", () => {
    const total = SMALL_BUFFERS.reduce((sum, b) => sum + b.bytes * b.atOnce, 0) / MiB;
    expect(total).toBeLessThanOrEqual(SERVER_ALLOWANCE_MB / 8);
  });

  // Review of PR #409, follow-up: no slicer answer is held whole. Each
  // render route's answer is streamed to a temp file under a cap (client.ts,
  // ANSWER_LIMITS) and stored from the file, so none is a buffer here.
  test("every slicer render answer is streamed under a cap from the contract", () => {
    expect(Object.keys(ANSWER_LIMITS).sort()).toEqual([
      "/v1/scad/png",
      "/v1/scad/stl",
      "/v1/step/glb",
      "/v1/stl/png",
    ]);
    for (const cap of Object.values(ANSWER_LIMITS)) {
      expect([LIMITS.renderOutputBytes, LIMITS.stepOutputBytes]).toContain(cap);
    }
    expect(PREVIEW_MESH_MAX_BYTES).toBe(LIMITS.stepOutputBytes);
  });
});

/** Every Markdown file under docs/, as [path from the repo root, text]. */
function docs(dir = join(ROOT, "docs")): [string, string][] {
  return readdirSync(dir).flatMap((name): [string, string][] => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return docs(path);
    return name.endsWith(".md") ? [[relative(ROOT, path), readFileSync(path, "utf8")]] : [];
  });
}

const VERB =
  /\bdocker compose (?:pull|logs|stop|start|restart|exec|rm|up)((?:\s+-[-\w]+)*)\s+([a-z][\w-]*)/g;

/** Each service a doc names, in a compose command or as the first key of a services: snippet. */
function namedServices(file: string, text: string): { where: string; name: string }[] {
  const out: { where: string; name: string }[] = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    for (const m of line.matchAll(VERB)) out.push({ where: `${file}:${i + 1}`, name: m[2] ?? "" });
    if (/^\s*services:\s*$/.test(line)) {
      const next = lines.slice(i + 1).find((l) => l.trim() !== "");
      const key = next ? /^\s*([A-Za-z0-9_.-]+):\s*$/.exec(next) : null;
      if (key) out.push({ where: `${file}:${i + 2}`, name: key[1] ?? "" });
    }
  });
  return out;
}

describe("the docs name only the example's services", () => {
  test("the check reads compose commands and services: snippets", () => {
    const sample = [
      "docker compose up -d",
      "docker compose ps",
      "docker compose logs app",
      "   docker compose up -d --no-deps slicer",
      "`docker compose pull platehouse`",
      "services:",
      "  db:",
    ].join("\n");
    expect(namedServices("s.md", sample)).toEqual([
      { where: "s.md:3", name: "app" },
      { where: "s.md:4", name: "slicer" },
      { where: "s.md:5", name: "platehouse" },
      { where: "s.md:7", name: "db" },
    ]);
  });

  test("every service a doc names is in examples/docker-compose.yml", () => {
    const all = docs();
    expect(all.some(([f]) => f === join("docs", "backups-and-upgrades.md"))).toBe(true);
    const named = all.flatMap(([file, text]) => namedServices(file, text));
    // The docs do name services: the upgrade steps and the Traefik labels at least.
    expect(named.length).toBeGreaterThanOrEqual(5);
    expect(named.filter((n) => !SERVICES.includes(n.name))).toEqual([]);
  });
});
