// orcaArgs on its own: the arguments are fixed.
import { describe, expect, test } from "vitest";
import { type OrcaJob, orcaArgs } from "../src/orca.js";

const JOB: OrcaJob = {
  plate: 2,
  mstpp: 120,
  dataDir: "/j/orca/data",
  outDir: "/j/orca/out",
  machineFile: "/p/machine.json",
  filamentFiles: ["/p/a.json", ""],
  input: "/j/orca/input.3mf",
};

describe("orcaArgs", () => {
  test("the arguments are exactly these", () => {
    expect(orcaArgs(JOB)).toEqual([
      "--datadir",
      "/j/orca/data",
      "--slice",
      "2",
      "--export-statistics",
      "--mstpp",
      "120",
      "--allow-newer-file",
      "--outputdir",
      "/j/orca/out",
      "--load-settings",
      "/p/machine.json",
      "--load-filaments",
      "/p/a.json;",
      "/j/orca/input.3mf",
    ]);
  });
});
