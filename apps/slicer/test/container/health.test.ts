// The built image's health and hardening: its limits and isolation, the
// versions it reports, and its healthcheck.
import { slicerContract } from "@platehouse/slicer-contract";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { streamChunked } from "../support/http.js";
import { expectedOrcaVersion } from "../support/orca-version.js";
import { type RunningSlicer, startSlicer } from "./support/slicer.js";

let slicer: RunningSlicer;
beforeAll(async () => {
  slicer = await startSlicer();
});
afterAll(() => slicer?.stop());

describe("slicer image", () => {
  // The Orca version is the one the image was built with: the Dockerfile's
  // pin, or the release slicer-image.yml built (EXPECTED_ORCA_VERSION).
  test("health reports the image's Orca version, OpenSCAD 2026.11-RC0, contract 2, the sandbox on and the time caps", async () => {
    const res = await fetch(`${slicer.base}/v1/health`);
    expect(res.status).toBe(200);
    expect(slicerContract.health.parse(await res.json())).toEqual({
      contract: 2,
      orca: expectedOrcaVersion(),
      openscad: "2026.11-RC0",
      busy: false,
      // CI's kernel is new enough for the sandbox.
      sandbox: { state: "on", reason: null, detail: null, allowUnsandboxed: false },
      timeouts: { sliceSeconds: 180, scadSeconds: 120, stepSeconds: 120, uploadSeconds: 600 },
    });
  });

  test("Docker's HEALTHCHECK marks the container healthy", () => {
    expect(slicer.health()).toBe("healthy");
  });

  test("the server runs as the non-root user 10001", () => {
    const r = slicer.exec(["id", "-u"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("10001");
  });

  // At a time cap the server kills a slice's process group; an Orca that
  // outlives GNU time is re-parented to PID 1. Node never reaps a process it
  // did not spawn, so PID 1 is tini, which does.
  test("PID 1 is tini, and it reaps an orphaned process", () => {
    expect(slicer.exec(["cat", "/proc/1/comm"]).stdout.trim()).toBe("tini");
    // The subshell exits at once, so its sleep is orphaned to PID 1; once the
    // sleep ends, no process in the container may be left a zombie.
    const r = slicer.exec([
      "sh",
      "-c",
      '(sleep 0.5 &); sleep 2; grep -l "^State:[[:space:]]*Z" /proc/[0-9]*/status || true',
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  // /tmp is mode 1777 in the Ubuntu base and the image never changes it, so
  // user 10001 could write there on a writable root: only a read-only mount
  // stops the touch. (A root-owned folder such as /opt/platehouse refuses
  // 10001 either way, so it proves nothing about the mount.) The root
  // mount's own options must say ro too.
  test("the root filesystem is read-only and /work is writable", () => {
    expect(slicer.exec(["stat", "-c", "%a", "/tmp"]).stdout.trim()).toBe("1777");
    const tmp = slicer.exec(["touch", "/tmp/x"]);
    expect(tmp.code).not.toBe(0);
    expect(tmp.stderr).toMatch(/Read-only file system/);
    const mounts = slicer.exec(["cat", "/proc/mounts"]).stdout.split("\n");
    const root = mounts.filter((l) => l.split(" ")[1] === "/").at(-1);
    expect(root).toBeDefined();
    expect((root ?? "").split(" ")[3]?.split(",")).toContain("ro");
    expect(slicer.exec(["touch", "/work/x"]).code).toBe(0);
  });

  // examples/docker-compose.yml sets memswap_limit equal to mem_limit and a
  // core-file limit of 0; the harness passes the same (test/harness.test.ts),
  // and this checks they reached the running container. On cgroup v2 a swap
  // cap equal to the memory cap is memory.swap.max 0.
  test("memory is capped at 4 GiB with no swap, and core files are off", () => {
    expect(slicer.exec(["cat", "/sys/fs/cgroup/memory.max"]).stdout.trim()).toBe(
      String(4 * 1024 ** 3),
    );
    expect(slicer.exec(["cat", "/sys/fs/cgroup/memory.swap.max"]).stdout.trim()).toBe("0");
    expect(slicer.exec(["sh", "-c", "ulimit -c"]).stdout.trim()).toBe("0");
  });

  // A body with no Content-Length is counted as it arrives. Going past the
  // limit must cost that request a 413, never the server process.
  test("a chunked .scad past 1 MiB is 413 and the server keeps answering", async () => {
    const res = await streamChunked(`${slicer.base}/v1/scad/stl`, 2 * 1024 * 1024);
    expect(res).toEqual({ status: 413, body: JSON.stringify({ error: "too_large" }) });
    const health = await fetch(`${slicer.base}/v1/health`);
    expect(health.status).toBe(200);
    expect(slicerContract.health.parse(await health.json()).busy).toBe(false);
  });
});
