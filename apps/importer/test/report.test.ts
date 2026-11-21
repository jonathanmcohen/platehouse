// The report's totals and exit code (AC-001, AC-004).
import { describe, expect, it } from "vitest";
import {
  exitCode,
  type ModelResult,
  modelLines,
  type Report,
  summaryLines,
  totals,
} from "../src/report.js";

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
          files: [
            {
              name: "old.3mf",
              manyfoldSize: 7,
              storedSize: 7,
              sha256: "ff".repeat(32),
              status: "already in Platehouse",
              reason: null,
            },
          ],
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
      valuesLeftOut: 0,
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
  it("prints names and reasons from Manyfold without control characters", () => {
    const lines = modelLines(
      model({
        name: "A\u001b[2Jb",
        outcome: "failed",
        reason: "bad\u0007 answer",
        files: [
          {
            name: `f${String.fromCodePoint(0x202e)}.3mf`,
            manyfoldSize: 1,
            storedSize: null,
            sha256: null,
            status: "failed",
            reason: "x\ny",
          },
        ],
      }),
      0,
      1,
    );
    expect(lines[0]).toContain("A[2Jb");
    expect(lines[0]).toContain("bad answer");
    expect(lines[1]).toContain("f.3mf");
    expect(lines[1]).toContain("xy");
    const unsafe = ["\u001b", "\u0007", String.fromCodePoint(0x202e), "\n"];
    expect([...lines.join("")].filter((c) => unsafe.includes(c))).toEqual([]);
  });

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

describe("values left out over Platehouse's limits", () => {
  it("are counted across models and named in the summary only when there are any", () => {
    const r = report([
      model({ leftOut: ["caption left out: 2001 characters, Platehouse takes at most 2000"] }),
      model({ manyfoldId: "m2", leftOut: ["a", "b"] }),
    ]);
    expect(totals(r).valuesLeftOut).toBe(3);
    expect(summaryLines(r).join("\n")).toMatch(/values left out 3: over Platehouse's limits/);
    expect(summaryLines(report([model()])).join("\n")).not.toMatch(/left out/);
  });

  it("do not by themselves make the exit code 1", () => {
    expect(exitCode(report([model({ leftOut: ["a"] })]))).toBe(0);
  });
});

describe("files already in Platehouse", () => {
  const present = model({
    outcome: "skipped",
    newModel: false,
    files: [
      {
        name: "old.3mf",
        manyfoldSize: 7,
        storedSize: 7,
        sha256: "ff".repeat(32),
        status: "already in Platehouse",
        reason: null,
      },
    ],
  });

  it("make the summary say their content was matched by size only, not checked", () => {
    const text = summaryLines(report([present])).join("\n");
    expect(text).toMatch(/matched by name and size only; their SHA-256 is not checked again/);
    expect(text).toMatch(/only in the report of the run that uploaded it/);
  });

  it("leave the summary without that line when there are none", () => {
    expect(summaryLines(report([model()])).join("\n")).not.toMatch(/name and size only/);
  });
});
