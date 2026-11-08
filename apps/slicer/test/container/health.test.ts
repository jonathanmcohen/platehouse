// The built image's health and hardening (AC-035, AC-036, AC-093).
import { slicerContract } from "@platehouse/slicer-contract";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
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
});
