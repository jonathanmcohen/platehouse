// Builds the slicer image and runs it the way Hades will (AC-035): read-only
// root, a 1 GB tmpfs at /work, 4 CPUs (fewer if the host has fewer), 4 GB of
// memory, no capabilities and
// no-new-privileges. Uses the docker CLI rather than testcontainers, which has
// no read-only-root option. The port is published on 127.0.0.1 only so the
// tests can reach the HTTP contract.
//
// SLICER_IMAGE names the image (default platehouse-slicer:test). The image is
// built here, once per run: later files hit Docker's cache.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../../../../../", import.meta.url)));
export const IMAGE = process.env.SLICER_IMAGE ?? "platehouse-slicer:test";

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function docker(args: string[], opts: { inherit?: boolean } = {}): Run {
  const r = spawnSync("docker", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: opts.inherit ? ["ignore", "inherit", "inherit"] : "pipe",
  });
  if (r.error) throw r.error;
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

let built = false;

/** docker build of apps/slicer/Dockerfile with the repo root as context. */
export function ensureImage(): void {
  if (built) return;
  const r = docker(
    ["build", "--platform", "linux/amd64", "-f", "apps/slicer/Dockerfile", "-t", IMAGE, "."],
    { inherit: true },
  );
  if (r.code !== 0)
    throw new Error(`docker build of apps/slicer/Dockerfile failed (exit ${r.code})`);
  built = true;
}

export interface RunningSlicer {
  id: string;
  base: string;
  exec(args: string[]): Run;
  health(): string;
  stop(): void;
}

/**
 * Hades gives the slicer 4 CPUs (AC-035). Docker refuses --cpus above the
 * host's count, and GitHub's runner for this private repo has 2, so the
 * tests ask for 4 or as many as the host has, whichever is fewer.
 */
export function cpuLimit(hostCpus: number): string {
  return String(Math.min(4, Math.max(1, Math.floor(hostCpus))));
}

export async function startSlicer(): Promise<RunningSlicer> {
  ensureImage();
  const info = docker(["info", "--format", "{{.NCPU}}"]);
  const hostCpus = Number(info.stdout.trim());
  if (info.code !== 0 || !Number.isFinite(hostCpus) || hostCpus < 1) {
    throw new Error(`docker info gave no CPU count: ${info.stderr}${info.stdout}`);
  }
  const run = docker([
    "run",
    "-d",
    "--platform",
    "linux/amd64",
    "--read-only",
    "--tmpfs",
    "/work:rw,size=1g,mode=1777",
    "--cpus",
    cpuLimit(hostCpus),
    "--memory",
    "4g",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "-p",
    "127.0.0.1::8080",
    IMAGE,
  ]);
  if (run.code !== 0) throw new Error(`docker run failed: ${run.stderr}`);
  const id = run.stdout.trim();
  const stop = () => {
    docker(["rm", "-f", id]);
  };
  try {
    const port = docker(["port", id, "8080/tcp"]).stdout.trim().split("\n")[0]?.split(":").at(-1);
    if (!port) throw new Error("the slicer's port 8080 is not published");
    const health = () =>
      docker(["inspect", "--format", "{{.State.Health.Status}}", id]).stdout.trim();
    const until = Date.now() + 180_000;
    while (health() !== "healthy") {
      if (Date.now() > until) {
        const logs = docker(["logs", id]);
        throw new Error(
          `the slicer never became healthy (${health()}):\n${logs.stdout}${logs.stderr}`,
        );
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return {
      id,
      base: `http://127.0.0.1:${port}`,
      exec: (args) => docker(["exec", id, ...args]),
      health,
      stop,
    };
  } catch (err) {
    stop();
    throw err;
  }
}
