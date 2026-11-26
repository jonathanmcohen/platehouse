// Slicer HTTP contract v2. The examples are the ones the contract was
// written with, so a schema that drifts from it fails here.
import { describe, expect, test } from "vitest";
import {
  CONTRACT_VERSION,
  KERNEL_CAUSES,
  LIMITS,
  REASONS,
  type SliceResult,
  slicerContract,
} from "../src/index.js";

describe("slicer contract v2", () => {
  test("is version 2 with the contract's body and answer limits", () => {
    expect(CONTRACT_VERSION).toBe(2);
    expect(LIMITS).toEqual({
      sliceBodyBytes: 536_870_912,
      scadBodyBytes: 1_048_576,
      stepBodyBytes: 268_435_456,
      stlBodyBytes: 268_435_456,
      renderOutputBytes: 268_435_456,
      stepOutputBytes: 268_435_456,
      maxPlate: 128,
      detailChars: 2000,
    });
  });

  test("the reasons are the contract's map as amended, in one closed list", () => {
    expect([...REASONS].sort()).toEqual(
      [
        "bed_too_small",
        "filament_temperature",
        "machine_not_supported",
        "nozzle_mismatch",
        "process_not_compatible",
        "slicer_error",
        "timeout",
        "toolpath_conflict",
      ].sort(),
    );
  });

  const HEALTH = {
    contract: 2,
    orca: "2.5.0",
    openscad: "2026.11-RC0",
    busy: false,
    sandbox: { state: "on", reason: null, detail: null, allowUnsandboxed: false },
    timeouts: { sliceSeconds: 180, scadSeconds: 120, stepSeconds: 120, uploadSeconds: 600 },
  };

  test("health parses the contract's example and rejects another contract number", () => {
    expect(slicerContract.health.parse(HEALTH)).toEqual(HEALTH);
    expect(slicerContract.health.safeParse({ ...HEALTH, contract: 1 }).success).toBe(false);
    expect(slicerContract.health.safeParse({ ...HEALTH, contract: 3 }).success).toBe(false);
  });

  test("a health body of contract 1, with no sandbox or timeouts, is refused", () => {
    const v1 = { contract: 1, orca: "2.5.0", openscad: "2026.11-RC0", busy: false };
    expect(slicerContract.health.safeParse(v1).success).toBe(false);
    const { sandbox: _s, timeouts: _t, ...v2Without } = HEALTH;
    expect(slicerContract.health.safeParse(v2Without).success).toBe(false);
  });

  test("health refuses an extra key at every level", () => {
    expect(slicerContract.health.safeParse({ ...HEALTH, extra: 1 }).success).toBe(false);
    expect(
      slicerContract.health.safeParse({ ...HEALTH, sandbox: { ...HEALTH.sandbox, extra: 1 } })
        .success,
    ).toBe(false);
    expect(
      slicerContract.health.safeParse({ ...HEALTH, timeouts: { ...HEALTH.timeouts, extra: 1 } })
        .success,
    ).toBe(false);
  });

  test("health takes the three sandbox states and a reason and detail when it is off", () => {
    for (const state of ["checking", "on"]) {
      const sandbox = { state, reason: null, detail: null, allowUnsandboxed: true };
      expect(slicerContract.health.safeParse({ ...HEALTH, sandbox }).success).toBe(true);
    }
    const off = {
      state: "off",
      reason: "old_kernel",
      detail: "the kernel is too old",
      allowUnsandboxed: false,
    };
    expect(slicerContract.health.parse({ ...HEALTH, sandbox: off }).sandbox).toEqual(off);
    for (const bad of [
      { ...off, state: "broken" },
      { ...off, reason: "other" },
      { ...off, allowUnsandboxed: "no" },
    ]) {
      expect(slicerContract.health.safeParse({ ...HEALTH, sandbox: bad }).success).toBe(false);
    }
  });

  test("health ties the sandbox state to its reason and detail", () => {
    const allow = { allowUnsandboxed: false };
    const refused = [
      { state: "on", reason: "old_kernel", detail: null, ...allow },
      { state: "on", reason: null, detail: "x", ...allow },
      { state: "checking", reason: "check_failed", detail: null, ...allow },
      { state: "checking", reason: null, detail: "x", ...allow },
      { state: "off", reason: null, detail: null, ...allow },
      { state: "off", reason: null, detail: "x", ...allow },
      { state: "off", reason: "old_kernel", detail: null, ...allow },
      { state: "off", reason: "old_kernel", detail: "", ...allow },
    ];
    for (const sandbox of refused) {
      expect(
        slicerContract.health.safeParse({ ...HEALTH, sandbox }).success,
        JSON.stringify(sandbox),
      ).toBe(false);
    }
    const off = { state: "off", reason: "check_failed", detail: "x", allowUnsandboxed: true };
    expect(slicerContract.health.safeParse({ ...HEALTH, sandbox: off }).success).toBe(true);
  });

  test("health takes a kernel cause on the off/old_kernel state, and without one", () => {
    const off = {
      state: "off",
      reason: "old_kernel",
      detail: "the kernel is too old",
      allowUnsandboxed: false,
    };
    const withCause = { ...off, kernel: "landlock_off" };
    expect(slicerContract.health.parse({ ...HEALTH, sandbox: withCause }).sandbox).toEqual(
      withCause,
    );
    expect(slicerContract.health.parse({ ...HEALTH, sandbox: off }).sandbox).toEqual(off);
  });

  test("health refuses a kernel cause on the on and checking states and an unknown cause", () => {
    for (const state of ["checking", "on"]) {
      const sandbox = {
        state,
        reason: null,
        detail: null,
        allowUnsandboxed: false,
        kernel: "too_old",
      };
      expect(slicerContract.health.safeParse({ ...HEALTH, sandbox }).success, state).toBe(false);
    }
    const off = {
      state: "off",
      reason: "old_kernel",
      detail: "x",
      allowUnsandboxed: false,
      kernel: "nope",
    };
    expect(slicerContract.health.safeParse({ ...HEALTH, sandbox: off }).success).toBe(false);
  });

  test("KERNEL_CAUSES lists the four causes in order", () => {
    expect([...KERNEL_CAUSES]).toEqual([
      "too_old",
      "landlock_off",
      "landlock_fix_missing",
      "unknown",
    ]);
  });

  test("health timeouts are positive whole seconds", () => {
    for (const bad of [0, -1, 1.5, "180"]) {
      const timeouts = { ...HEALTH.timeouts, scadSeconds: bad };
      expect(slicerContract.health.safeParse({ ...HEALTH, timeouts }).success).toBe(false);
    }
  });

  test("sandboxOff parses both reasons and refuses an unknown one", () => {
    for (const reason of ["old_kernel", "check_failed"]) {
      const body = { error: "sandbox_off", reason, detail: "why" };
      expect(slicerContract.sandboxOff.parse(body)).toEqual(body);
    }
    const body = { error: "sandbox_off", reason: "old_kernel", detail: "why" };
    expect(slicerContract.sandboxOff.safeParse({ ...body, reason: "gone" }).success).toBe(false);
    expect(slicerContract.sandboxOff.safeParse({ ...body, detail: undefined }).success).toBe(false);
    expect(slicerContract.sandboxOff.safeParse({ ...body, extra: 1 }).success).toBe(false);
    expect(slicerContract.sandboxOff.safeParse({ ...body, error: "busy" }).success).toBe(false);
  });

  test("profiles parses printers and filaments, each filament naming its printer", () => {
    const body = {
      contract: 2,
      orca: "2.5.0",
      printers: [
        { id: "Bambu Lab P1S 0.4 nozzle", model: "Bambu Lab P1S", modelId: "C12", nozzle: 0.4 },
      ],
      filaments: [
        {
          printer: "Bambu Lab P1S 0.4 nozzle",
          type: "PLA",
          profile: "Bambu PLA Basic @BBL P1S 0.4 nozzle",
        },
        { printer: "Bambu Lab P1S 0.4 nozzle", type: "PA", profile: "Generic PA" },
      ],
    };
    expect(slicerContract.profiles.parse(body)).toEqual(body);
    const noNozzle = { ...body, printers: [{ ...body.printers[0], nozzle: "0.4" }] };
    expect(slicerContract.profiles.safeParse(noNozzle).success).toBe(false);
  });

  test("a profiles filament with no printer, an empty printer or a field beyond the contract is refused", () => {
    const body = (filament: Record<string, unknown>) => ({
      contract: 2,
      orca: "2.5.0",
      printers: [],
      filaments: [filament],
    });
    const ok = { printer: "Bambu Lab P1S 0.4 nozzle", type: "PLA", profile: "Generic PLA" };
    expect(slicerContract.profiles.safeParse(body(ok)).success).toBe(true);
    const { printer: _printer, ...noPrinter } = ok;
    for (const bad of [
      noPrinter,
      { ...ok, printer: "" },
      { ...ok, source: "generic" },
      { ...ok, source: "bambu" },
    ]) {
      expect(slicerContract.profiles.safeParse(body(bad)).success, JSON.stringify(bad)).toBe(false);
    }
  });

  test("an ok slice parses the contract's example", () => {
    const body = {
      contract: 2,
      orca: "2.5.0",
      plate: 3,
      status: "ok",
      printer: "Bambu Lab P1S 0.4 nozzle",
      process: "0.20mm Standard @BBL X1C",
      filamentProfiles: ["Bambu PLA Basic @BBL P1S 0.4 nozzle"],
      timeSeconds: 5025,
      weightGrams: 41.37,
      filaments: [{ slot: 1, type: "PLA", color: "#FFFFFF", grams: 41.37 }],
      wallMs: 21000,
      peakRssBytes: 812000000,
    };
    const parsed: SliceResult = slicerContract.sliceResult.parse(body);
    expect(parsed).toEqual(body);
  });

  test("a sliced filament carries only the contract's slot, type, color and grams", () => {
    const body = (filament: Record<string, unknown>) => ({
      contract: 2,
      orca: "2.5.0",
      plate: 1,
      status: "ok",
      printer: "Bambu Lab A1 mini 0.4 nozzle",
      process: null,
      filamentProfiles: [null],
      timeSeconds: 1,
      weightGrams: 1,
      filaments: [filament],
      wallMs: 1,
      peakRssBytes: 1,
    });
    const f = { slot: 1, type: "ABS", color: null, grams: 1 };
    expect(slicerContract.sliceResult.safeParse(body(f)).success).toBe(true);
    for (const bad of [
      { ...f, profile: "Bambu ABS @BBL X1C", profileSource: "bambu" },
      { ...f, profile: "Generic ABS", profileSource: "generic" },
      { ...f, profile: null, profileSource: "file" },
    ]) {
      expect(slicerContract.sliceResult.safeParse(body(bad)).success, JSON.stringify(bad)).toBe(
        false,
      );
    }
  });

  test("an ok slice needs a time and a weight above zero", () => {
    const body = {
      contract: 2,
      orca: "2.5.0",
      plate: 1,
      status: "ok",
      printer: "Bambu Lab P1S 0.4 nozzle",
      process: null,
      filamentProfiles: [null],
      timeSeconds: 0,
      weightGrams: 1,
      filaments: [],
      wallMs: 1,
      peakRssBytes: 1,
    };
    expect(slicerContract.sliceResult.safeParse(body).success).toBe(false);
    expect(slicerContract.sliceResult.safeParse({ ...body, timeSeconds: 1 }).success).toBe(true);
    expect(
      slicerContract.sliceResult.safeParse({ ...body, timeSeconds: 1, weightGrams: 0 }).success,
    ).toBe(false);
  });

  test("a failed slice parses the contract's example and every reason", () => {
    for (const reason of REASONS) {
      const body = {
        contract: 2,
        orca: "2.5.0",
        plate: 3,
        status: "failed",
        code: -17,
        reason,
        detail: "The selected printer is not compatible with the process preset in the 3mf.",
      };
      expect(slicerContract.sliceResult.parse(body)).toEqual(body);
    }
  });

  test("a failed slice with no Orca code (the slicer's own kill) has code null", () => {
    const body = {
      contract: 2,
      orca: "2.5.0",
      plate: 1,
      status: "failed",
      code: null,
      reason: "timeout",
      detail: "",
    };
    expect(slicerContract.sliceResult.parse(body)).toEqual(body);
  });

  test("a failed slice refuses an unknown reason and a detail over 2000 characters", () => {
    const body = {
      contract: 2,
      orca: "2.5.0",
      plate: 1,
      status: "failed",
      code: -3,
      reason: "slicer_error",
      detail: "x".repeat(2000),
    };
    expect(slicerContract.sliceResult.safeParse(body).success).toBe(true);
    expect(
      slicerContract.sliceResult.safeParse({ ...body, detail: "x".repeat(2001) }).success,
    ).toBe(false);
    expect(
      slicerContract.sliceResult.safeParse({ ...body, reason: "needs_decision" }).success,
    ).toBe(false);
  });

  test("the slice query takes a printer id and a plate from 1 to 128", () => {
    const q = slicerContract.sliceQuery;
    expect(q.parse({ printer: "Bambu Lab P1S 0.4 nozzle", plate: "3" })).toEqual({
      printer: "Bambu Lab P1S 0.4 nozzle",
      plate: 3,
    });
    for (const plate of ["0", "129", "1.5", "-1", "", "abc", "1e2", " 2"]) {
      expect(q.safeParse({ printer: "x", plate }).success, `plate ${JSON.stringify(plate)}`).toBe(
        false,
      );
    }
    expect(q.safeParse({ printer: "", plate: "1" }).success).toBe(false);
    expect(q.safeParse({ plate: "1" }).success).toBe(false);
  });

  test("error bodies are the contract's, plus bad_request and not_found", () => {
    for (const error of ["busy", "too_large", "not_3mf"]) {
      expect(slicerContract.error.parse({ error })).toEqual({ error });
    }
    expect(
      slicerContract.error.parse({ error: "bad_request", message: "unknown printer" }),
    ).toEqual({
      error: "bad_request",
      message: "unknown printer",
    });
    expect(slicerContract.error.parse({ error: "not_found" })).toEqual({ error: "not_found" });
    expect(slicerContract.error.safeParse({ error: "nope" }).success).toBe(false);
    expect(slicerContract.renderError.parse({ error: "render_failed", message: "m" })).toEqual({
      error: "render_failed",
      message: "m",
    });
    expect(slicerContract.convertError.parse({ error: "convert_failed", message: "m" })).toEqual({
      error: "convert_failed",
      message: "m",
    });
  });
});
