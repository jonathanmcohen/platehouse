// The report's totals and exit code (AC-001, AC-004).
import { describe, expect, it } from "vitest";
import { exitCode, type ModelResult, modelLines, type Report, totals } from "../src/report.js";

const model = (over: Partial<ModelResult> = {}): ModelResult => ({
  manyfoldId: "m1",
  name: "Benchy Stand",
  outcome: "imported",
  reason: null,
  newModel: true,
  files: [
    {
      name: "benchy.3mf",
      manyfoldSize: 3000,
      storedSize: 3000,
      sha256: "0123456789abcdef".repeat(4),
      status: "imported",
      reason: null,
    },
  ],
  ...over,
});

const report = (models: ModelResult[], found = models.length): Report => ({
  mode: "apply",
  found,
  models,
});

describe("totals", () => {
  it("counts models by outcome and files by status", () => {
    const t = totals(
      report([
        model(),
        model({
          manyfoldId: "m2",
          outcome: "skipped",
          reason: "already in Platehouse",
          newModel: false,
        }),
        model({
          manyfoldId: "m3",
          outcome: "failed",
          newModel: false,
          files: [
            {
              name: "a.stl",
              manyfoldSize: 10,
              storedSize: null,
              sha256: null,
              status: "failed",
              reason: "size mismatch: got 9 bytes, Manyfold says 10",
            },
            {
              name: "p.png",
              manyfoldSize: 5,
              storedSize: null,
              sha256: null,
              status: "skipped",
              reason: "Platehouse does not take .png files",
            },
          ],
        }),
      ]),
    );
    expect(t).toEqual({
      found: 3,
      imported: 1,
      skipped: 1,
      failed: 1,
      newModels: 1,
      filesImported: 1,
      filesSkipped: 1,
      sizeMismatches: 1,
    });
  });
});

describe("exitCode", () => {
  it("is 0 when no model failed", () => {
    expect(exitCode(report([model(), model({ manyfoldId: "m2", outcome: "skipped" })]))).toBe(0);
  });

  it("is 1 when a model failed", () => {
    expect(exitCode(report([model(), model({ manyfoldId: "m2", outcome: "failed" })]))).toBe(1);
  });

  it("is 1 when the models handled do not add up to the models found", () => {
    expect(exitCode(report([model()], 2))).toBe(1);
  });
});

describe("modelLines", () => {
  it("gives the model line, then one size row per file with the SHA-256 prefix", () => {
    const lines = modelLines(model(), 0, 3);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("[1/3]");
    expect(lines[0]).toContain("Benchy Stand");
    expect(lines[1]).toContain("benchy.3mf");
    expect(lines[1]).toContain("manyfold 3000");
    expect(lines[1]).toContain("stored 3000");
    expect(lines[1]).toContain("sha256 0123456789ab");
  });
});
