// Builds the slicer image and runs it the way examples/docker-compose.yml does
// (its isolation and limits): read-only root, a 1 GB tmpfs at /work mounted noexec, nosuid and
// nodev (nothing in a job folder is ever run; examples/docker-compose.yml
// carries the same options), 4 CPUs
// (fewer if the host has fewer), 4 GB of memory with no swap, a 1024 process
// and thread cap, no core files, no capabilities and no-new-privileges
// (test/harness.test.ts checks these against the compose file). Uses the docker
// CLI rather than testcontainers, which has
// no read-only-root option. The port is published on 127.0.0.1 only so the
// tests can reach the HTTP contract.
//
// SLICER_IMAGE names the image (default platehouse-slicer:test). The image is
// built here, once per run: later files hit Docker's cache. With
// SLICER_IMAGE_PREBUILT=1 nothing is built: SLICER_IMAGE must already be in
// Docker. .github/workflows/slicer-image.yml sets it, because it builds the
// image itself with an Orca version's build args, and a build here would
// replace that image with one at the Dockerfile's pinned version.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { slicerContract } from "@platehouse/slicer-contract";

const ROOT = resolve(fileURLToPath(new URL("../../../../../", import.meta.url)));
export const IMAGE = process.env.SLICER_IMAGE ?? "platehouse-slicer:test";

/**
 * The image's folders, as the server's defaults name them (loadConfig), for
 * a test that builds a program's sandbox rules by hand (sandboxRules) and
 * runs them with docker exec.
 */
export const IMAGE_PATHS = {
  openscadDir: "/opt/openscad",
  orcaDir: "/opt/orca",
  profilesDir: "/opt/platehouse/profiles",
  nodeDir: "/opt/node",
  appDir: "/opt/platehouse/app",
} as const;

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

/**
 * docker build of apps/slicer/Dockerfile with the repo root as context, or,
 * with SLICER_IMAGE_PREBUILT=1, a check that SLICER_IMAGE is already there.
 */
export function ensureImage(): void {
  if (built) return;
  if (process.env.SLICER_IMAGE_PREBUILT === "1") {
    const found = docker(["image", "inspect", "--format", "{{.Id}}", IMAGE]);
    if (found.code !== 0) {
      throw new Error(`SLICER_IMAGE_PREBUILT=1, but ${IMAGE} is not in Docker: ${found.stderr}`);
    }
    built = true;
    return;
  }
  const r = docker(
    ["build", "--platform", "linux/amd64", "-f", "apps/slicer/Dockerfile", "-t", IMAGE, "."],
    { inherit: true },
  );
  if (r.code !== 0)
    throw new Error(`docker build of apps/slicer/Dockerfile failed (exit ${r.code})`);
  built = true;
}

/**
 * Runs one program in a fresh throwaway container from the slicer image, as
 * root (or opts.user) with Docker's default capabilities, and removes the container after.
 * For checks of what is in the image itself, which do not need the hardened
 * runtime startSlicer gives: root there has no capabilities, so it cannot
 * read every folder in the image.
 */
export function runInImage(program: string, args: string[], opts: { user?: string } = {}): Run {
  ensureImage();
  return docker(["run", "--rm", "-u", opts.user ?? "0", "--entrypoint", program, IMAGE, ...args]);
}

export interface RunningSlicer {
  id: string;
  base: string;
  exec(args: string[]): Run;
  health(): string;
  /** The server's output so far (docker logs), stdout and stderr together. */
  logs(): string;
  stop(): void;
}

/**
 * examples/docker-compose.yml gives the slicer 4 CPUs. Docker refuses --cpus above the
 * host's count, so the tests ask for 4 or as many as the host has, whichever is fewer.
 */
export function cpuLimit(hostCpus: number): string {
  return String(Math.min(4, Math.max(1, Math.floor(hostCpus))));
}

/**
 * The docker run arguments startSlicer uses, for a host with hostCpus CPUs.
 * apps/slicer/test/harness.test.ts checks them against the platehouse-slicer
 * service in examples/docker-compose.yml, so the container tests (and the
 * smoke slice that gates a new Orca image) run under the deploy's limits.
 */
export function slicerRunArgs(hostCpus: number): string[] {
  return [
    "run",
    "-d",
    "--platform",
    "linux/amd64",
    "--read-only",
    "--tmpfs",
    "/work:rw,noexec,nosuid,nodev,size=1g,mode=1777",
    "--cpus",
    cpuLimit(hostCpus),
    "--memory",
    "4g",
    // memswap_limit equal to mem_limit, as examples/docker-compose.yml sets
    // it: with --memory alone Docker allows as much again in swap, so a slice
    // past 4 GiB would swap and pass here, then be OOM-killed in a deployment.
    "--memory-swap",
    "4g",
    // examples/docker-compose.yml's pids_limit and core-file limit, so every
    // container test runs under the caps a deployment sets.
    "--pids-limit",
    "1024",
    "--ulimit",
    "core=0",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "-p",
    "127.0.0.1::8080",
    IMAGE,
  ];
}

/**
 * Starts the slicer container. extraRunArgs go into docker run just before
 * the image name, for a test that changes the runtime (a seccomp profile);
 * slicerRunArgs itself stays what the compose file says.
 */
export async function startSlicer(extraRunArgs: string[] = []): Promise<RunningSlicer> {
  ensureImage();
  const info = docker(["info", "--format", "{{.NCPU}}"]);
  const hostCpus = Number(info.stdout.trim());
  if (info.code !== 0 || !Number.isFinite(hostCpus) || hostCpus < 1) {
    throw new Error(`docker info gave no CPU count: ${info.stderr}${info.stdout}`);
  }
  const runArgs = slicerRunArgs(hostCpus);
  runArgs.splice(runArgs.length - 1, 0, ...extraRunArgs);
  const run = docker(runArgs);
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
    // The image's healthcheck passes on any 200, and health answers 200 while
    // the start-up sandbox check holds the heavy-job lock, where a request is
    // 409 busy. A test starts once that check is done.
    const base = `http://127.0.0.1:${port}`;
    let last = "no answer";
    for (;;) {
      try {
        const res = await fetch(`${base}/v1/health`);
        const body = res.status === 200 ? slicerContract.health.parse(await res.json()) : null;
        last = body ? `sandbox ${body.sandbox.state}, busy ${body.busy}` : `status ${res.status}`;
        if (body && body.sandbox.state !== "checking" && !body.busy) break;
      } catch (err) {
        last = err instanceof Error ? err.message : String(err);
      }
      if (Date.now() > until) {
        const logs = docker(["logs", id]);
        throw new Error(
          `the slicer's start-up sandbox check did not finish (${last}):\n${logs.stdout}${logs.stderr}`,
        );
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return {
      id,
      base,
      exec: (args) => docker(["exec", id, ...args]),
      health,
      logs: () => {
        const r = docker(["logs", id]);
        return `${r.stdout}${r.stderr}`;
      },
      stop,
    };
  } catch (err) {
    stop();
    throw err;
  }
}
