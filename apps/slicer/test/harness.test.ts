// The container test harness (test/container/support/slicer.ts) says it runs
// the slicer image the way examples/docker-compose.yml does, and the slicer
// image workflow's smoke slice, the only gate before a new Orca image is
// published, runs through it. So every limit the compose file sets on the
// platehouse-slicer service must reach docker run with the same value: a
// harness without the swap cap lets a slice that needs more than 4 GiB swap
// and pass in CI, then be OOM-killed in a deployment.
//
// The compose file is read as text: the workspace has no YAML parser, and
// the file is small and plainly indented (as apps/server's compose test
// reads it).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { cpuLimit, slicerRunArgs } from "./container/support/slicer.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const COMPOSE = readFileSync(join(ROOT, "examples", "docker-compose.yml"), "utf8");

/** The platehouse-slicer service's lines, up to the next service. */
function slicerService(): string[] {
  const lines = COMPOSE.split("\n");
  const start = lines.indexOf("  platehouse-slicer:");
  if (start === -1) throw new Error("no platehouse-slicer service");
  const end = lines.findIndex((l, i) => i > start && /^ {0,2}\S/.test(l) && !/^\s*#/.test(l));
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

/** The value of a "key: value" line at the given indent, or undefined. */
function field(lines: string[], key: string, indent = 4): string | undefined {
  const re = new RegExp(`^ {${indent}}${key}: (.+)$`);
  for (const line of lines) {
    const m = re.exec(line);
    if (m) return m[1]?.trim();
  }
  return undefined;
}

/** The "- item" lines under a "key:" line at indent 4. */
function list(lines: string[], key: string): string[] {
  const at = lines.indexOf(`    ${key}:`);
  if (at === -1) return [];
  const out: string[] = [];
  for (const line of lines.slice(at + 1)) {
    const m = /^ {6}- (.+)$/.exec(line);
    if (!m) break;
    out.push(m[1]?.trim() ?? "");
  }
  return out;
}

/** The "key: value" lines under a "key:" line at indent 4, as a map. */
function block(lines: string[], key: string): Map<string, string> {
  const at = lines.indexOf(`    ${key}:`);
  const out = new Map<string, string>();
  if (at === -1) return out;
  for (const line of lines.slice(at + 1)) {
    const m = /^ {6}([\w-]+): (.+)$/.exec(line);
    if (!m) break;
    out.set(m[1] ?? "", m[2]?.trim() ?? "");
  }
  return out;
}

/** Every value given after flag in a docker run argument list. */
function flagValues(args: string[], flag: string): string[] {
  return args.flatMap((a, i) => (a === flag && i + 1 < args.length ? [args[i + 1] ?? ""] : []));
}

// tmpfs options as a set, without rw (the default, which the compose file
// leaves out), so the order the two files write them in does not matter.
const tmpfsOptions = (spec: string) => {
  const [path, opts = ""] = spec.split(/:(.*)/s);
  return { path, opts: new Set(opts.split(",").filter((o) => o !== "" && o !== "rw")) };
};

describe("the container harness runs the slicer under examples/docker-compose.yml's limits", () => {
  const service = slicerService();
  const args = slicerRunArgs(8);

  test("the compose file sets the limits this test compares", () => {
    for (const key of ["read_only", "cpus", "mem_limit", "memswap_limit", "pids_limit"]) {
      expect(field(service, key), key).toBeDefined();
    }
    expect(block(service, "ulimits").get("core")).toBeDefined();
  });

  test("the same memory cap, and a swap cap equal to it, so a slice cannot swap", () => {
    expect(flagValues(args, "--memory")).toEqual([field(service, "mem_limit")]);
    expect(flagValues(args, "--memory-swap")).toEqual([field(service, "memswap_limit")]);
  });

  test("the same core-file size limit", () => {
    const core = block(service, "ulimits").get("core");
    expect(flagValues(args, "--ulimit")).toContain(`core=${core}`);
  });

  test("the same process cap, CPU count, read-only root and /work tmpfs", () => {
    expect(flagValues(args, "--pids-limit")).toEqual([field(service, "pids_limit")]);
    expect(flagValues(args, "--cpus")).toEqual([cpuLimit(Number(field(service, "cpus")))]);
    expect(field(service, "read_only")).toBe("true");
    expect(args).toContain("--read-only");
    const [want] = list(service, "tmpfs").map(tmpfsOptions);
    const got = flagValues(args, "--tmpfs").map(tmpfsOptions);
    expect(got).toEqual([want]);
  });

  test("the same dropped capabilities and security options", () => {
    expect(flagValues(args, "--cap-drop")).toEqual(list(service, "cap_drop"));
    expect(flagValues(args, "--security-opt")).toEqual(list(service, "security_opt"));
  });
});
