// Slicer HTTP contract v1 (build plan, Contracts). The examples are the
// plan's own, so a schema that drifts from the plan fails here.
import { describe, expect, test } from "vitest";
import {
  CONTRACT_VERSION,
  LIMITS,
  REASONS,
  type SliceResult,
  slicerContract,
} from "../src/index.js";

describe("slicer contract v1", () => {
  test("is version 1 with the plan's body limits", () => {
    expect(CONTRACT_VERSION).toBe(1);
    expect(LIMITS).toEqual({
      sliceBodyBytes: 536_870_912,
      scadBodyBytes: 1_048_576,
      stepBodyBytes: 268_435_456,
      maxPlate: 128,
      detailChars: 2000,
    });
  });

  test("the reasons are the plan's map as amended, in one closed list", () => {
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

  test("health parses the plan's example and rejects another contract number", () => {
    const ok = { contract: 1, orca: "2.5.0", openscad: "2026.11-RC0", busy: false };
    expect(slicerContract.health.parse(ok)).toEqual(ok);
    expect(slicerContract.health.safeParse({ ...ok, contract: 2 }).success).toBe(false);
    expect(slicerContract.health.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });

  test("profiles parses printers and filaments, each filament naming its printer and source", () => {
    const body = {
      contract: 1,
      orca: "2.5.0",
      printers: [
        { id: "Bambu Lab P1S 0.4 nozzle", model: "Bambu Lab P1S", modelId: "C12", nozzle: 0.4 },
      ],
      filaments: [
        {
          printer: "Bambu Lab P1S 0.4 nozzle",
          type: "PLA",
          profile: "Bambu PLA Basic @BBL P1S 0.4 nozzle",
          source: "bambu",
        },
        {
          printer: "Bambu Lab P1S 0.4 nozzle",
          type: "PA",
          profile: "Generic PA",
          source: "generic",
        },
      ],
    };
    expect(slicerContract.profiles.parse(body)).toEqual(body);
    const noNozzle = { ...body, printers: [{ ...body.printers[0], nozzle: "0.4" }] };
    expect(slicerContract.profiles.safeParse(noNozzle).success).toBe(false);
  });

  test("a profiles filament with no printer, an empty printer or another source is refused", () => {
    const body = (filament: Record<string, unknown>) => ({
      contract: 1,
      orca: "2.5.0",
      printers: [],
      filaments: [filament],
    });
    const ok = {
      printer: "Bambu Lab P1S 0.4 nozzle",
      type: "PLA",
      profile: "Generic PLA",
      source: "generic",
    };
    expect(slicerContract.profiles.safeParse(body(ok)).success).toBe(true);
    const { printer: _printer, ...noPrinter } = ok;
    const { source: _source, ...noSource } = ok;
    for (const bad of [
      noPrinter,
      noSource,
      { ...ok, printer: "" },
      { ...ok, source: "file" },
      { ...ok, source: "user" },
    ]) {
      expect(slicerContract.profiles.safeParse(body(bad)).success, JSON.stringify(bad)).toBe(false);
    }
  });

  test("an ok slice parses the plan's example", () => {
    const body = {
      contract: 1,
      orca: "2.5.0",
      plate: 3,
      status: "ok",
      printer: "Bambu Lab P1S 0.4 nozzle",
      process: "0.20mm Standard @BBL X1C",
      filamentProfiles: ["Bambu PLA Basic @BBL P1S 0.4 nozzle"],
      timeSeconds: 5025,
      weightGrams: 41.37,
      filaments: [
        {
          slot: 1,
          type: "PLA",
          color: "#FFFFFF",
          grams: 41.37,
          profile: "Bambu PLA Basic @BBL P1S 0.4 nozzle",
          profileSource: "bambu",
        },
      ],
      wallMs: 21000,
      peakRssBytes: 812000000,
    };
    const parsed: SliceResult = slicerContract.sliceResult.parse(body);
    expect(parsed).toEqual(body);
  });

  test("each sliced filament reports the preset used: Bambu, generic, or the file's own", () => {
    const body = (filament: Record<string, unknown>) => ({
      contract: 1,
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
    for (const ok of [
      { ...f, profile: "Bambu ABS @BBL X1C", profileSource: "bambu" },
      { ...f, profile: "Generic ABS", profileSource: "generic" },
      { ...f, profile: null, profileSource: "file" },
    ]) {
      expect(slicerContract.sliceResult.safeParse(body(ok)).success, JSON.stringify(ok)).toBe(true);
    }
    for (const bad of [
      f,
      { ...f, profile: null },
      { ...f, profileSource: "bambu" },
      { ...f, profile: "Generic ABS", profileSource: "user" },
      { ...f, profile: null, profileSource: "bambu" },
      { ...f, profile: null, profileSource: "generic" },
      { ...f, profile: "Generic ABS", profileSource: "file" },
    ]) {
      expect(slicerContract.sliceResult.safeParse(body(bad)).success, JSON.stringify(bad)).toBe(
        false,
      );
    }
  });

  test("an ok slice needs a time and a weight above zero", () => {
    const body = {
      contract: 1,
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

  test("a failed slice parses the plan's example and every reason", () => {
    for (const reason of REASONS) {
      const body = {
        contract: 1,
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
      contract: 1,
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
      contract: 1,
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

  test("error bodies are the plan's, plus bad_request and not_found", () => {
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
