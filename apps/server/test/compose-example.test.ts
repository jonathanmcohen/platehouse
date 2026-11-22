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
import { PLATE_MESH_LIMITS } from "@platehouse/threemf";
import { describe, expect, test } from "vitest";
import { PLATE_MESH_BUILDS, PLATE_MESH_READ_PEAK_MB } from "../src/plate-mesh/plate-mesh.js";
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

  test("the reads that can run at once, and the server's allowance, fit under mem_limit", () => {
    const app = services().get("platehouse") ?? [];
    const limit = mebibytes(field(app, "mem_limit"));
    expect(mebibytes(field(app, "memswap_limit"))).toBe(limit);
    const needed = PLATE_MESH_BUILDS * PLATE_MESH_READ_PEAK_MB + SERVER_ALLOWANCE_MB;
    expect(needed).toBeLessThanOrEqual(limit);
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
