// The built image's health and hardening (AC-035, AC-036, AC-093).
import { slicerContract } from "@platehouse/slicer-contract";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { streamChunked } from "../support/http.js";
import { type RunningSlicer, startSlicer } from "./support/slicer.js";

let slicer: RunningSlicer;
beforeAll(async () => {
  slicer = await startSlicer();
});
afterAll(() => slicer?.stop());

describe("slicer image", () => {
  test("health reports orca 2.5.0, OpenSCAD 2026.11-RC0, contract 1 and not busy", async () => {
    const res = await fetch(`${slicer.base}/v1/health`);
    expect(res.status).toBe(200);
    expect(slicerContract.health.parse(await res.json())).toEqual({
      contract: 1,
      orca: "2.5.0",
      openscad: "2026.11-RC0",
      busy: false,
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

  test("the root filesystem is read-only and /work is writable", () => {
    expect(slicer.exec(["touch", "/opt/platehouse/x"]).code).not.toBe(0);
    expect(slicer.exec(["touch", "/work/x"]).code).toBe(0);
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
